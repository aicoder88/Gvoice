// @ts-check
// Deepgram streaming transcription transport. Selected via ?provider=deepgram.
//
// Translates the OpenAI-shaped browser frames (input_audio_buffer.append /
// .commit) into Deepgram's binary-audio + Finalize protocol, and synthesizes
// the OpenAI-shaped transcription frames back to the browser so the client
// code is provider-agnostic.
//
// Language auto-detect: Deepgram streaming has no language detection for
// Croatian (nova-3 "multi" covers ~10 languages, hr not among them; the
// detect_language feature is batch-only). So language "auto" runs one
// streaming connection ("leg") per candidate language in parallel on the same
// audio and keeps the transcript Deepgram was more confident about. Legs run
// simultaneously, so latency is unchanged; per-clip cost doubles (pennies).

import WebSocket from "ws";
import { readFile } from "node:fs/promises";
import { sendToClient, forwardUnexpectedResponse } from "./_shared.js";
import { withRetry, httpError } from "../retry.js";
import * as vocab from "../vocab.js";

const AUTO_LANGUAGES = ["hr", "en"];

// One wording for "your key was refused", shared by the streaming leg and the
// batch retry — the two paths hit it for the same reason (the shipped fallback
// key in realtime-relay.js having been revoked) and must not disagree about
// what the user should do.
const KEY_REJECTED = "Deepgram rejected the key. Add your own DEEPGRAM_API_KEY in Settings.";

// WebSocket.readyState numbers, for log lines a human has to read at 2am.
const READY_STATE_NAMES = ["connecting", "open", "closing", "closed"];

/**
 * How much of the audio we've sent Deepgram has NOT heard yet, in ms.
 *
 * Two readings, and the smaller one wins so neither can stall a good press:
 * Deepgram's own progress stamp (start + duration on every Results frame) is
 * exact but goes stale when it stops sending frames (a silent hold), and wall
 * clock always ticks but assumes the engine is no faster than real time, which
 * it usually beats.
 *
 * Exported for the unit test — the flush timing is the whole fix, and it is the
 * one piece that can be checked without a socket.
 *
 * @param {{ audioMs: number, streamStartedAt: number, processedMs: number, now: number }} state
 * @returns {number}
 */
export function unheardMs({ audioMs, streamStartedAt, processedMs, now }) {
  if (!streamStartedAt) return 0; // nothing has reached the engine yet
  const byClock = audioMs - (now - streamStartedAt);
  const byEngine = audioMs - processedMs;
  return Math.max(0, Math.min(byClock, byEngine));
}

/** Append the user's dictionary as keyterm/keywords params, same as the legs do. */
function addKeyterms(/** @type {URLSearchParams} */ params, /** @type {string} */ model) {
  try {
    const terms = vocab.deepgramKeyterms();
    const param = /nova-3/i.test(model) ? "keyterm" : "keywords";
    for (const term of terms) params.append(param, term);
  } catch {}
}

/**
 * @param {WebSocket} clientSocket
 * @param {{ apiKey: string, model: string, language?: string }} opts
 */
export function attach(clientSocket, { apiKey, model, language }) {
  // Re-read env on every connection so a runtime toggle (Right-Ctrl tap in
  // main.js) takes effect on the next dictation without a server restart.
  const lang = (language || process.env.WHISPER_LANGUAGE || "auto").toLowerCase();
  const langs = lang === "auto" || lang === "multi" ? AUTO_LANGUAGES : [lang];
  const multiLeg = langs.length > 1;

  let completedSent = false;
  // The relay's wire contract emits "connected" once per session, but in auto/
  // multi-language mode there are several legs — gate the synthesized frame so
  // the client sees exactly one (the per-leg console log below stays per-leg).
  let connectedSent = false;
  // Set when the browser commits (key released) and we ask Deepgram to flush.
  // Deepgram never sends a message of type "Finalize" back — it marks the
  // flushed result with from_finalize: true on a normal Results frame.
  let finalizeSent = false;

  function legUrl(/** @type {string} */ legLang) {
    const params = new URLSearchParams({
      model,
      language: legLang,
      encoding: "linear16",
      sample_rate: "24000",
      channels: "1",
      punctuate: "true",
      interim_results: "true",
      endpointing: "false",
      vad_events: "false"
    });
    // smart_format and keyterm prompting used to be English-only; Deepgram now
    // accepts both for nova-3 monolingual languages including hr (handshake
    // verified 2026-06-05 — no HTTP 400).
    params.set("smart_format", "true");
    // Bias toward the user's custom dictionary. nova-3 uses keyterm prompting;
    // older Deepgram models use the keywords param. Each term is appended as a
    // repeated query param. Re-read per connection so freshly-added words apply
    // to the very next dictation.
    addKeyterms(params, model);
    return `wss://api.deepgram.com/v1/listen?${params.toString()}`;
  }

  // One leg = one Deepgram connection transcribing in one language.
  function makeLeg(/** @type {string} */ legLang) {
    const dgSocket = new WebSocket(legUrl(legLang), {
      headers: { Authorization: `Token ${apiKey}` }
    });
    const leg = {
      lang: legLang,
      dgSocket,
      finalParts: /** @type {string[]} */ ([]),
      lastInterim: "",
      queuedBinaries: /** @type {(Buffer | string)[]} */ ([]),
      // Catch-up tracking, per leg: legs open at different moments (and in
      // auto-language mode there are two), so a fast leg must not make a slow
      // one look caught up. See unheardMs / scheduleFlush.
      streamStartedAt: 0, // when this leg first got audio
      processedMs: 0,     // how far in this leg says it has listened
      // Confidence-weighted word counts for the winner pick: Σ(conf·words)/Σwords.
      confWeighted: 0,
      confWords: 0,
      flushed: false
    };

    dgSocket.on("open", () => {
      console.error("[relay] deepgram connected model=" + model + " lang=" + legLang);
      if (!connectedSent) {
        connectedSent = true;
        sendToClient(clientSocket, { type: "local.status", status: "connected", provider: "deepgram", model });
      }
      if (leg.queuedBinaries.length > 0 && !leg.streamStartedAt) leg.streamStartedAt = Date.now();
      while (leg.queuedBinaries.length > 0) dgSocket.send(leg.queuedBinaries.shift());
      // The hold committed while this leg was still connecting — it owes a
      // Finalize. Schedule it the same way the commit path does rather than
      // sending it here: everything we just dumped is backlog Deepgram has not
      // heard yet, and a Finalize on top of it flushes one word (see
      // scheduleFlush).
      if (finalizeSent && !leg.flushed) scheduleFlush();
    });

    dgSocket.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === "Results") {
        // Deepgram stamps every Results frame (even empty ones) with how far
        // into the stream it has listened — start + duration, in seconds. That
        // is the exact catch-up signal scheduleFlush needs.
        if (typeof msg.start === "number" && typeof msg.duration === "number") {
          leg.processedMs = Math.max(leg.processedMs, (msg.start + msg.duration) * 1000);
        }
        const alt = msg.channel?.alternatives?.[0];
        const text = alt?.transcript || "";
        if (text) {
          if (msg.is_final) {
            leg.finalParts.push(text);
            leg.lastInterim = "";
            const words = text.split(/\s+/).length;
            const conf = typeof alt.confidence === "number" ? alt.confidence : 0;
            leg.confWeighted += conf * words;
            leg.confWords += words;
            // Deltas exist only as the renderer's last-resort fallback text.
            // With parallel legs they'd interleave two languages, so only the
            // single-leg mode streams them.
            if (!multiLeg) {
              sendToClient(clientSocket, {
                type: "conversation.item.input_audio_transcription.delta",
                delta: text + " "
              });
            }
          } else {
            leg.lastInterim = text;
          }
        }
        // The flush triggered by our Finalize arrives as a Results frame with
        // from_finalize: true (possibly with an empty transcript). That is the
        // real "everything is transcribed" signal — complete as soon as every
        // leg has flushed instead of letting a blind timeout fire.
        // finalizeAt, not finalizeSent: while the flush is being held back for a
        // backlog, nothing here may complete the utterance — the engine is still
        // mid-catch-up and its words are still coming.
        if (finalizeAt && (msg.from_finalize === true || msg.speech_final === true)) {
          leg.flushed = true;
          if (legs.every((l) => l.flushed)) emitCompleted("from_finalize");
          return;
        }
        // Still delivering. A slow upstream connect makes the relay dump the
        // whole queued hold at once, and Deepgram chews through that backlog at
        // roughly real time — on 2026-08-01 a 6s connect left it ~3s behind, the
        // fixed 3s timeout fired mid-backlog, and the user got the first five
        // words of a nine-second dictation. Any frame is proof it is still
        // working, so restart the give-up clock (bounded by the ceiling below).
        if (finalizeAt && !completedSent) armSafetyTimeout();
        return;
      }
      if (msg.type === "UtteranceEnd") return;
      if (msg.type === "Metadata") return;
      if (msg.type === "SpeechStarted") return;
    });

    dgSocket.on("error", (error) => {
      console.error("[relay] deepgram error (" + legLang + "):", error.message);
      // A dead leg must not block completion forever; mark it flushed so the
      // surviving leg's flush can complete the utterance.
      leg.flushed = true;
      if (multiLeg && legs.some((l) => !l.flushed || l.transcriptText())) {
        if (finalizeSent && legs.every((l) => l.flushed)) emitCompleted("leg_error");
        return;
      }
      // A 401 means the key was rejected — almost always the shipped fallback
      // key having been revoked (realtime-relay.js DEEPGRAM_FALLBACK_KEY). The
      // raw socket text ("Unexpected server response: 401") tells the user
      // nothing they can act on, so say what to do instead.
      const message = String(error.message || "").includes("401")
        ? KEY_REJECTED
        : "Deepgram: " + error.message;
      sendToClient(clientSocket, { type: "local.error", message });
    });

    dgSocket.on("close", (code, reason) => {
      console.error("[relay] deepgram closed lang=" + legLang + " code=" + code + " reason=" + reason.toString());
      leg.flushed = true;
      // Same finalizeSent guard as the Results and error paths: legs dropping
      // mid-hold (network blip) must NOT complete the utterance — a premature
      // `completed` would paste a partial transcript while the user is still
      // speaking. Pre-commit double-close falls through to clientSocket.close()
      // below, which the renderer handles by saving the audio for retry.
      if (finalizeSent && legs.every((l) => l.flushed)) emitCompleted("socket_close");
      if (legs.every((l) => l.dgSocket.readyState === WebSocket.CLOSED || l.dgSocket.readyState === WebSocket.CLOSING)) {
        sendToClient(clientSocket, { type: "local.status", status: "closed", code });
        clientSocket.close();
      }
    });

    forwardUnexpectedResponse(dgSocket, clientSocket, "deepgram");

    leg.transcriptText = function () {
      const finalsText = this.finalParts.join(" ").replace(/\s+/g, " ").trim();
      return finalsText || this.lastInterim.trim();
    };
    leg.confidence = function () {
      return this.confWords > 0 ? this.confWeighted / this.confWords : 0;
    };

    return leg;
  }

  const legs = langs.map(makeLeg);

  let safetyTimer = null;
  // When the Finalize actually went out, so the ceiling below measures the time
  // the engine had to ANSWER — never time it spent connecting or catching up.
  let finalizeAt = 0;
  // Quiet-time budget: how long the engine may say NOTHING before we give up.
  const SAFETY_QUIET_MS = 3000;
  // Hard ceiling from the Finalize, whatever the engine is doing. The whole
  // relay budget (backlog wait + this) must stay under the renderer's
  // DICTATION_FALLBACK_MS or the renderer pastes its half-built delta text
  // before the real transcript lands. Ordering: BACKLOG_WAIT_CAP_MS +
  // SAFETY_CEILING_MS < FALLBACK_MS < DICTATION_FAILURE_MS.
  const SAFETY_CEILING_MS = 5000;
  // Safety net only — the from_finalize Results frames are the normal
  // completion path. Long enough that it can't beat a healthy flush. If THIS is
  // what completes the utterance, the flush never came back — worth seeing in
  // the log (reason=safety_timeout). Armed at commit, re-armed by any leg that
  // opens afterwards and by every Results frame that arrives after the commit,
  // so the clock measures engine SILENCE, never time it spent connecting or
  // working through a backlog.
  function armSafetyTimeout() {
    clearTimeout(safetyTimer);
    const untilCeiling = finalizeAt ? finalizeAt + SAFETY_CEILING_MS - Date.now() : SAFETY_QUIET_MS;
    const ms = Math.max(0, Math.min(SAFETY_QUIET_MS, untilCeiling));
    safetyTimer = setTimeout(() => emitCompleted("safety_timeout"), ms);
  }

  // --- Backlog-aware flush ----------------------------------------------------
  // We hand audio to Deepgram as fast as the browser produces it, but Deepgram
  // transcribes a live stream at roughly real time. After a slow upstream
  // connect the queued hold goes out in one burst, so at key-up the engine can
  // still be seconds behind — and Finalize means "flush what you have NOW", not
  // "finish the backlog first". Measured 2026-08-01 by replaying a real 9.5s
  // clip as one burst: Finalize immediately came back with ONE word; the same
  // clip with the Finalize held back came back complete. That is the words-go-
  // missing bug, and no timeout can fix it — the audio is discarded upstream.
  //
  // So: hold the Finalize until the engine has had real time to hear what we
  // sent. Wall clock is the estimate (bytes in ÷ 48 = ms of audio); Deepgram
  // chews a backlog slightly FASTER than real time, so this errs long by a beat.
  let audioMs = 0;
  let flushTimer = null;
  // Ceiling on the wait. A hold longer than this that also hit a slow connect
  // gives up some tail rather than blowing the renderer's watchdog.
  const BACKLOG_WAIT_CAP_MS = 10000;
  // Under this much lag, flush now. The engine is inside the tail the renderer
  // already streams after key-up (DICTATION_TAIL_MS, 1s of mostly trailing
  // silence), which is why healthy presses always came back complete — so a
  // wait here would be pure added latency on every single dictation.
  const FLUSH_NOW_UNDER_MS = 1200;

  // The slowest leg decides: a leg that opened late is the one holding unheard
  // audio, and Finalizing on its backlog is exactly the bug being fixed here.
  function backlogMs() {
    const now = Date.now();
    return Math.max(0, ...legs.map((leg) => unheardMs({ audioMs, ...leg, now })));
  }

  // Send the Finalize to every live leg and start the answer clock.
  function flushLegs() {
    flushTimer = null;
    // What each leg's socket was doing the instant we flushed. The loop below
    // marks a closing/closed leg `flushed` SILENTLY, which is how a dictation
    // can complete as `commit_no_live_legs` with nothing in the log to explain
    // it — on 2026-07-30 one did, and the matching `deepgram closed` line only
    // arrived 22s later. This is the missing evidence.
    const stateSummary = legs
      .map((l) => `${l.lang}:${READY_STATE_NAMES[l.dgSocket.readyState] || l.dgSocket.readyState}`)
      .join(" ");
    console.error(`[relay] deepgram finalize ${stateSummary}`);
    let sent = 0;
    for (const leg of legs) {
      if (leg.dgSocket.readyState === WebSocket.OPEN) {
        leg.dgSocket.send(JSON.stringify({ type: "Finalize" }));
        sent += 1;
      } else if (leg.dgSocket.readyState === WebSocket.CONNECTING) {
        // Still handshaking — its queued audio flushes on 'open', which then
        // schedules the Finalize this commit owes it (see the open handler).
      } else {
        leg.flushed = true; // closing/closed — don't wait on it
      }
    }
    // Every leg already dead: complete now with whatever was heard instead of
    // making the user wait out the safety timeout.
    if (legs.every((l) => l.flushed)) { emitCompleted("commit_no_live_legs"); return; }
    // Nothing live to flush yet (a tap that beat the handshake). Do NOT start
    // the answer clock — there is no engine listening to answer it, and arming
    // it here is what completed a whole dictation as an empty paste. The leg's
    // open handler schedules this again once it can actually take the Finalize.
    if (!sent) return;
    finalizeAt = Date.now();
    armSafetyTimeout();
  }

  function scheduleFlush() {
    if (completedSent) return;
    clearTimeout(flushTimer);
    const wait = Math.round(Math.min(backlogMs(), BACKLOG_WAIT_CAP_MS));
    if (wait <= FLUSH_NOW_UNDER_MS) { flushLegs(); return; }
    console.error(`[relay] deepgram is ${wait}ms behind — holding the flush so the backlog is heard`);
    flushTimer = setTimeout(flushLegs, wait);
  }

  function emitCompleted(/** @type {string} */ reason = "unknown") {
    if (completedSent) return;
    completedSent = true;
    clearTimeout(flushTimer);
    clearTimeout(safetyTimer);
    // Winner: the leg with the highest confidence that actually heard words.
    let best = legs[0];
    for (const leg of legs) {
      const a = leg.transcriptText() ? leg.confidence() : -1;
      const b = best.transcriptText() ? best.confidence() : -1;
      if (a > b) best = leg;
    }
    // Always log the per-leg outcome (not just in multi-leg auto mode) so a
    // dictation that completed with nothing is diagnosable instead of a mystery
    // blank. Each leg reports how many words it heard and at what confidence.
    const legSummary = legs
      .map((l) => `${l.lang}:words=${l.confWords},conf=${l.confidence().toFixed(3)},len=${l.transcriptText().length}`)
      .join(" ");
    const winnerText = best.transcriptText();
    if (!winnerText) {
      // Every leg came back empty — the single most useful thing to surface when
      // chasing "I dictated and nothing happened" (silence, mic gain, or both
      // auto-language legs genuinely hearing nothing).
      console.error(`[relay] deepgram ALL EMPTY (reason=${reason}, multiLeg=${multiLeg}) ${legSummary}`);
    } else {
      console.error(`[relay] deepgram complete pick=${best.lang} (reason=${reason}) ${legSummary}`);
    }
    sendToClient(clientSocket, {
      type: "conversation.item.input_audio_transcription.completed",
      transcript: winnerText,
      language: best.lang
    });
  }

  clientSocket.on("message", (message, isBinary) => {
    // A genuine binary frame is raw PCM audio — forward it as-is to every leg.
    // (The shipped client only sends JSON with base64 audio, so this is the
    // documented contract for third-party clients, not a path GVoice exercises.)
    if (isBinary) {
      forwardBinary(message);
      return;
    }
    const payload = message.toString();
    let parsed;
    try { parsed = JSON.parse(payload); } catch {
      forwardBinary(payload);
      return;
    }

    if (parsed.type === "input_audio_buffer.append" && typeof parsed.audio === "string") {
      const buf = Buffer.from(parsed.audio, "base64");
      forwardBinary(buf);
      return;
    }

    if (parsed.type === "input_audio_buffer.commit") {
      finalizeSent = true;
      console.error(`[relay] deepgram commit (audio=${Math.round(audioMs)}ms, engine ${Math.round(backlogMs())}ms behind)`);
      scheduleFlush();
      return;
    }
  });

  function forwardBinary(/** @type {Buffer | string} */ buf) {
    // 24kHz, 16-bit, mono = 48 bytes per millisecond of speech. Counted once per
    // frame, not once per leg — the legs all carry the same audio.
    if (Buffer.isBuffer(buf)) audioMs += buf.length / 48;
    for (const leg of legs) {
      if (leg.dgSocket.readyState === WebSocket.OPEN) {
        if (!leg.streamStartedAt) leg.streamStartedAt = Date.now();
        leg.dgSocket.send(buf);
      } else {
        leg.queuedBinaries.push(buf);
      }
    }
  }

  clientSocket.on("close", () => {
    for (const leg of legs) {
      try {
        if (leg.dgSocket.readyState === WebSocket.OPEN) leg.dgSocket.send(JSON.stringify({ type: "CloseStream" }));
      } catch {}
      setTimeout(() => { try { leg.dgSocket.close(); } catch {} }, 200);
    }
  });
}

/**
 * Why a batch retry failed, in words the user can act on.
 *
 * Every failure used to read "check your internet", which is wrong for most of
 * them: a 401 (revoked key) is not a network problem, and pointing someone at a
 * working connection leaves them with no way out.
 *
 * @param {any} error  the throw from transcribeWavFile
 * @returns {string}
 */
export function batchFailureReason(error) {
  const status = error && error.status;
  if (status === 401 || status === 403) return KEY_REJECTED;
  // 429/5xx survived withRetry's attempts, so it's their end, not the clip.
  if (status === 429 || status >= 500) return "Deepgram is busy or down (error " + status + ") — try again shortly.";
  if (status) return "Deepgram refused the clip (error " + status + ").";
  const name = error && error.name;
  if (name === "TimeoutError" || name === "AbortError") return "Retry timed out — the connection stalled.";
  return "Retry failed — check your internet.";
}

/**
 * Transcribe a saved .wav with Deepgram's prerecorded (batch) API.
 *
 * This is the second chance for a dictation the streaming path came back empty
 * on — the audio is already on disk, so a failed stream never has to mean lost
 * words. Batch is a plain request/response with no handshake to race, and it
 * has real language detection, so "auto" is ONE request here instead of the
 * one-leg-per-language workaround streaming needs.
 *
 * @param {string} wavPath
 * @param {{ apiKey: string, model?: string, language?: string }} opts
 * @returns {Promise<string>} the transcript, or "" if it genuinely heard nothing
 */
export async function transcribeWavFile(wavPath, { apiKey, model = "nova-3", language } = {}) {
  const lang = (language || process.env.WHISPER_LANGUAGE || "auto").toLowerCase();
  const params = new URLSearchParams({ model, punctuate: "true", smart_format: "true" });
  if (lang === "auto" || lang === "multi") params.set("detect_language", "true");
  else params.set("language", lang);
  addKeyterms(params, model);

  // The WAV header carries the format, so encoding/sample_rate must be omitted —
  // those are raw-audio params and sending them with a WAV is a 400.
  const body = await readFile(wavPath);
  // ONE deadline for the whole call, retry included — created out here, not
  // inside the attempt. Without this a half-open connection (captive portal, VPN
  // drop) hangs on undici's 300s default, and a per-attempt signal makes the
  // "30s" a per-try budget instead of a ceiling: a socket-level failure comes
  // back as TypeError("fetch failed"), which withRetry DOES retry, so the user
  // waits 30s + 30s. Measured on 2026-07-30 with Deepgram degraded: one retry
  // ran 44.4s (debug.log `retranscribe ... ms:44373`) with the pill stuck on
  // "Transcribing…" the whole time. A clip this size comes back in seconds, so
  // 30 total is generous.
  const deadline = AbortSignal.timeout(30000);
  const json = await withRetry(async () => {
    const res = await fetch(`https://api.deepgram.com/v1/listen?${params.toString()}`, {
      method: "POST",
      headers: { Authorization: `Token ${apiKey}`, "Content-Type": "audio/wav" },
      body,
      signal: deadline
    });
    if (!res.ok) throw httpError(res.status, (await res.text().catch(() => "")).slice(0, 200));
    return res.json();
  });
  return (json?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "").trim();
}
