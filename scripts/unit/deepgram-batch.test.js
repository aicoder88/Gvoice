// Covers the retry-a-saved-recording path: transcribeWavFile must send the WAV
// as-is (no raw-audio params, which Deepgram 400s on), retry a transient
// failure, and dig the transcript out of the batch response shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transcribeWavFile, batchFailureReason } from "../../src/providers/deepgram.js";

const wav = join(mkdtempSync(join(tmpdir(), "gvoice-")), "clip.wav");
writeFileSync(wav, Buffer.from("RIFF____WAVEfmt "));

const okBody = { results: { channels: [{ alternatives: [{ transcript: "  hello there  " }] }] } };

function stubFetch(responses) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    return {
      ok: next.status === 200,
      status: next.status,
      json: async () => next.body,
      text: async () => JSON.stringify(next.body)
    };
  };
  return calls;
}

test("posts the wav as audio/wav with no raw-audio params, trims the transcript", async () => {
  const calls = stubFetch([{ status: 200, body: okBody }]);
  const text = await transcribeWavFile(wav, { apiKey: "k", model: "nova-3", language: "en" });
  assert.equal(text, "hello there");
  const { url, init } = calls[0];
  assert.equal(init.headers["Content-Type"], "audio/wav");
  assert.equal(init.headers.Authorization, "Token k");
  assert.match(url, /language=en/);
  // encoding/sample_rate belong to the streaming legs only — sending them with
  // a WAV is a 400 that reads like an auth failure.
  assert.doesNotMatch(url, /encoding=|sample_rate=/);
});

// A half-open connection (captive portal, VPN drop) would otherwise hang on
// undici's 300s default with the user staring at "Transcribing…".
test("the upload carries an abort signal so a dead connection can't hang", async () => {
  const calls = stubFetch([{ status: 200, body: okBody }]);
  await transcribeWavFile(wav, { apiKey: "k", language: "en" });
  assert.ok(calls[0].init.signal, "fetch was called without a timeout signal");
});

// The retry must share the FIRST attempt's deadline. With a fresh signal per
// attempt, a socket-level failure (TypeError "fetch failed", which withRetry
// retries) buys a second full 30s — measured at 44.4s in the wild, with the
// pill stuck on "Transcribing…" the whole time.
test("retry shares one deadline instead of restarting the clock", async () => {
  const calls = stubFetch([
    { status: 503, body: { err_msg: "upstream" } },
    { status: 200, body: okBody }
  ]);
  await transcribeWavFile(wav, { apiKey: "k", language: "en" });
  assert.equal(calls.length, 2);
  assert.strictEqual(calls[0].init.signal, calls[1].init.signal);
});

test("language auto uses batch language detection, not one request per language", async () => {
  const calls = stubFetch([{ status: 200, body: okBody }]);
  await transcribeWavFile(wav, { apiKey: "k", language: "auto" });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /detect_language=true/);
});

test("retries a transient upload timeout instead of losing the dictation", async () => {
  const calls = stubFetch([
    { status: 408, body: { err_code: "SLOW_UPLOAD" } },
    { status: 200, body: okBody }
  ]);
  assert.equal(await transcribeWavFile(wav, { apiKey: "k", language: "en" }), "hello there");
  assert.equal(calls.length, 2);
});

test("silence comes back as empty string, not a crash", async () => {
  stubFetch([{ status: 200, body: { results: { channels: [{ alternatives: [{ transcript: "" }] }] } } }]);
  assert.equal(await transcribeWavFile(wav, { apiKey: "k", language: "en" }), "");
});

// A revoked key used to show "check your internet" — sending the user to fix a
// connection that was never broken. Each failure has to name its own cause.
test("a refused key says the key was refused, not that the internet is down", async () => {
  stubFetch([{ status: 401, body: { err_msg: "Invalid credentials" } }]);
  const error = await transcribeWavFile(wav, { apiKey: "bad", language: "en" }).catch((e) => e);
  const reason = batchFailureReason(error);
  assert.match(reason, /key/i);
  assert.doesNotMatch(reason, /internet/i);
});

test("a network throw still points at the connection", () => {
  assert.match(batchFailureReason(new TypeError("fetch failed")), /internet/i);
});

test("a stalled upload says it timed out", () => {
  const timeout = Object.assign(new Error("aborted"), { name: "TimeoutError" });
  assert.match(batchFailureReason(timeout), /timed out/i);
});
