# Session notes — 2026-07-27: code review fixes + recording playback

## Why the recording didn't play

macOS LaunchServices binds `com.microsoft.waveform-audio` to the Music/GarageBand
family. The SAME claim also binds `public.mp3`, so converting recordings to MP3
would have opened the same app that was already failing — verified with
`lsregister -dump`. The WAV itself is fine (`afinfo`: 24.4s, Int16, 24000 Hz,
mono). The file was never the problem, the opener was. Fix: `playRecording()` in
main.js sends the path to `open -a VLC`, falling back to `shell.openPath` when
VLC is absent or off-macOS. All three call sites route through it.

Rejected: converting to MP3 (needs ffmpeg, lands in Music anyway); QuickTime
instead of VLC (guaranteed present, but Mark asked for VLC and VLC is installed);
in-app `<audio>` playback (new window + new UI for something the OS does).
`open -a VLC` by NAME, not by hardcoded path — LaunchServices finds it in
/Applications or ~/Applications.

## Decisions inside the review fixes

- **Streak threshold of 3** for cleanup failures: the timeout is 2500ms, so three
  consecutive misses is ~8s of unreachable engine, past any wifi handoff. One
  constant, `TRANSIENT_FAILURES_BEFORE_WARNING`.
- **`resetCleanupFailureStreak()` is exported for tests only.** The tempting
  alternative — resetting inside `takeCleanupError()` — is a trap: main.js drains
  after every utterance, so the counter would never reach the threshold and the
  warning would never fire at all.
- **429 shares the streak counter** with network failures. A mixed run (2 timeouts
  + 1 rate-limit) reports the rate-limit wording. Imprecise, but both mean the
  same thing to the user: cleanup is degraded, text is coming out raw.
- **The dead `!deepgramKeyNow` branch in realtime-relay.js was LEFT in place.** It
  is unreachable only because the baked-in fallback key is always truthy; remove
  that key and the guard goes live again. Fixed the actual harm instead — the
  opaque 401 — in `src/providers/deepgram.js`.
- **The whisper-cli guard reads `WHISPER_BIN`/`WHISPER_CLI` only.** If the parity
  test runs without bootstrap-env having populated them, a developer with the
  binary under BIN_DIR gets a skip rather than a run. Fails safe, and that subtest
  already skips today on the missing model file.

## Open — needs Mark's decision

The Deepgram key in `realtime-relay.js` is real, on a card-backed account, and the
XOR pad hiding it is printed on the adjacent line. It is **not on GitHub yet** —
the commits holding it are unpushed. Pushing publishes it. Options: rotate + set a
spend cap; move it behind a hosted relay; or accept the exposure knowingly (the
code comment already says it's deliberate). Not changed here because removing it
guts the zero-setup feature it exists for.

Separately: `GROQ_FALLBACK_KEY` in `src/cleanup.js` is ALREADY public on
origin/main. Lower stakes — the comment says no-card free tier.

## Verified

Rebuilt, relaunched, confirmed on the running app: tray "Play last recording"
opens VLC with the right clip and the clock advances; no Settings nag window with
STT_PROVIDER=deepgram + blank key; tray icon present. unit 122/122, parity 3 pass
+ 3 skip + 0 fail. Committed (875f1ed, 73bd0c9, 5eb0512), NOT pushed.

---

# Session notes — 2026-06-27 (pt.2): Settings UI redesign (sidebar)

Rewrote public/settings.html into a sidebar/sectioned window (Speech, AI cleanup,
Dictionary, Activity, History & privacy, Shortcuts). Consolidated the standalone
dictionary window + tray history into Settings; added Activity (src/stats.js,
computeStats from history.json); surfaced two env-only settings (self-correction
toggle, cleanup-engine picker). cleanup.js: provider/model now resolve per-call
(resolveProvider) so the engine dropdown applies live; SYSTEM_PROMPT →
buildSystemPrompt(on) that OMITS the self-correction section when off (a trailing
override didn't work — model ignored it; verified omission keeps retracted words).

Review gate (adversarial + simplicity over the diff) — merged:
- Dropped Anthropic/Google from the cleanup-engine dropdown: no key fields for
  them → picking one silently disabled cleanup (raw passthrough). Kept Groq
  (free default) + OpenAI (key on Speech tab); fixed the hint. Env power-users
  can still set CLEANUP_PROVIDER=anthropic/google manually (validation kept).
- Dropped the unused `now` param from stats.dayIndex().
Left as-is (reviewer-confirmed fine): per-tab Save is global (saves, never loses);
twice-a-year DST off-by-one in streak for UTC+0/DST zones (harmless).
Verified clean: settings round-trip, cleanup.js scope (no dangling deleted
consts), SELF_CORRECTION gate↔prompt consistency, IPC shapes, no dropped
capability (engine probe/benchmark/apply, intro, reveal, clear, retention clamp).
Tests after: unit 115/115, cleanup 13/13, all syntax OK.

---

# Session notes — 2026-06-27: FluidVoice self-correction port

Added spoken self-correction to the cleanup pass (drop retracted words).
Review gate (adversarial + simplicity subagents over the diff) — merged:
- Removed the "cancel entirely → empty output" prompt case: dead on arrival
  (polishTranscript falls back to RAW on empty output, so it pasted the full
  un-retracted sentence — opposite of intent) and scope creep. Both reviewers.
- Dropped "delete that" from gate + prompt cues: common literal content
  ("delete that file") → false routing/latency + over-deletion risk. Kept the
  idiomatic "scratch that"/"strike that".
- Dropped bare "rather" from prompt (kept "or rather"): content word.
- Amended the top "verbatim" rule (it claimed list layout was the ONLY
  drop-words case) to name the self-correction carve-out — removes a
  3-way "only exception" contradiction that destabilizes the small model.
- Centralized the cue regex into exported looksLikeRetraction() (one source of
  truth, used by main.js gate) + added scripts/unit/cleanup-gate.test.js.
- Fixed a misleading test (fifty/sixty used bare "no" on a <40-char phrase →
  would skip cleanup in production; now uses "no wait").
Rejected: trimming the prompt section for brevity (would break house style /
consistency with neighboring sections — fails "right regardless").
Tests after: unit 107/107, cleanup 13/13, syntax OK. NOT committed, NOT shipped.

Rabbit-hole avoided: per-app prompt profiles (the bigger FluidVoice feature)
deliberately NOT built this pass — it adds a new config-UI window + cross-
platform app detection; surfaced to user for go-ahead instead of half-shipping.

---

# Session notes — 2026-06-17: polish pass

Ran a 9-dimension find→adversarially-verify review (60-agent workflow): 39 confirmed
(0 critical/high, 7 medium, 32 low), 12 refuted. Fixed the high-value confirmed ones in
5 tested batches; ran an adversarial+simplicity review gate; applied its findings. Not committed.

## Tradeoffs / deviations
- #2 (relay has no Origin/token auth — any local webpage can spend your API credits) was
  NOT fixed. It's real, but the fix sits on the connection-accept path (mis-plumb breaks ALL
  dictation) and a mandatory token breaks the reusable web component's cross-origin design.
  Surfaced to the user with two options (Origin allow-list vs per-launch token). This is the
  one finding deliberately left for a decision.
- #3 (sync GPU probe blocks the Windows main thread) fixed by MEMOIZING probeCapability, not
  the fuller async conversion. On macOS detectGpu is a pure arch check (no spawn), so the async
  path is Windows-only and untestable here; memoize kills the repeated blocking (every Settings
  open / benchmark) safely. Full async fix surfaced as a Windows follow-up.
- #8/#11/#15 left as-is per the verifiers (proposed fixes didn't work or risked load-bearing
  lifecycle for ~no gain).
- #28 (web-component failure copy) done copy-only — no new UI — since it's a dev demo panel.
- #38 (dictionary unbounded) capped at the CONSUMERS (promptTerms, 100) not the store, so no
  silent data loss — the store keeps everything; only the per-request prompt is bounded.

## Review-gate decisions (adversarial + simplicity, applied the CLAUDE.md merge bar)
ACCEPTED & APPLIED:
- whisper-local.js: spawn the server on `resolvedModel` (absolute) not the raw `model` string,
  so the -m arg matches the cache key and never depends on the child's cwd. (adversarial should-fix)
- dictation.js #0: softened the message from "check that your OpenAI API key is valid" to
  "Lost the connection to OpenAI before it answered — if this keeps happening, check that your
  API key is valid." The same closed-frame shape also covers a transient network drop on a valid
  key; don't assert the key is bad. (adversarial should-fix)
- model-download.js: moved psq() above its first use (definition-before-use clarity). (simplicity nit)
- hardware.js: trimmed the speculative "Windows-only follow-up" tail from the memo comment. (simplicity nit)
REJECTED (per reviewers' own recommendation):
- Removing `|| gotTerminalEvent` from the dictation.js guards — redundant TODAY but a one-token
  belt-and-suspenders in zero-test-coverage async code whose redundancy rests on a cross-branch
  invariant nothing enforces. Keep.
NOTED, NOT DONE (follow-up, pre-existing):
- Aligning the relay's RELATIVE whisper-model default (realtime-relay.js:55) with whisper-local's
  ABSOLUTE default. Mismatch can spuriously respawn the server only when WHISPER_MODEL is unset AND
  cwd != repo root (a dev/misconfig edge; production always sets it absolute). spawn-on-resolvedModel
  removes the broken-spawn sharp edge; full default-alignment left as follow-up.

## Verified
- node --check clean on every touched .js. unit 110/110, parity 4 pass + 1 known network skip
  (pre-existing OpenAI bad-key test, restores key before connect → can't fail), cleanup 9/9.
- Tests cover only pure modules; main.js/dictation.js/providers verified by reasoning + the
  adversarial gate (no automated coverage there). The whisper-local + deepgram + openai-relay
  paths ARE exercised by the parity harness and pass.

## Refuted highlights (do NOT redo)
- "settings.js corrupts CRLF .env / drops your change" — empirically false (dotenv last-wins).
- "settings.js edits wrong duplicate line" — proposed fix would INTRODUCE a split-brain; current correct.
- vocab pop-up a11y keyboard path — pop-up is focusable:false by design; fix would be dead code.
- powerMonitor listener leak — single app-lifetime registration, correct.
- wmic-removed-on-24H2 — code already has the PowerShell fallback the finding said was missing.

# Session notes — 2026-06-18: code-review fix pass (xhigh)

Ran /code-review (10 finder angles + verify + sweep) over the uncommitted working tree, then
fixed the survivors and adversarially verified every fix (10-agent workflow: 9 SOUND + a
completeness critic, all clean). Not committed.

## Headline bug fixed
- whisper on-device model switch was inert until app restart. The relay reads API KEYS fresh
  per connection (realtime-relay.js:116-121) but passed the BOOT-FROZEN whisperModel to
  whisper-local (line 140). So a Settings "Use on-device <different model>" never reached the
  new respawn logic — the warm server (boot model) kept serving, and the new model-aware
  respawn (the original diff's stated purpose) actively respawned the WRONG (boot) model.
  Fix: read process.env.WHISPER_MODEL/WHISPER_BIN fresh per connection, same pattern as keys.
  ensureSocket closes+reopens every press, so the next dictation picks it up — no reload needed.

## Other fixes applied
- whisper-local.js: added monotonic whisperServerGeneration; an in-flight start bails (throws)
  before spawn and after waitForServer (killing its own proc) if superseded. Closes the
  orphaned-server + last-writer-wins WHISPER_SERVER_URL race on two rapid different-model starts.
- vocab.js: new addTermResult() ("added"|"duplicate"|"too-long"|"invalid") is the single
  validator; addTerm delegates. main.js vocab:add-many switches on it — tooLong now uses the
  COLLAPSED length (a 41-raw/38-collapsed term is no longer wrongly skipped) and punctuation-only
  is "invalid" (silently skipped), not miscounted as duplicate. Reverted the now-orphaned
  `export` on MAX_TERM_LEN back to a plain const.
- main.js: engine:apply model gate `!MODELS[name]` -> `!Object.hasOwn(MODELS, name)` (inherited
  keys like "constructor"/"__proto__" no longer slip the allow-list).
- dictation-session.js: added fail() = finalize()+done(); collapsed the 3 error-site pairs.
- realtime-relay.js: dropped the dead "::1" LOOPBACK_HOSTS entry (URL hostname is always "[::1]").
- hardware.js: Object.freeze the memoized probe so a future caller can't poison the shared cache.
- dictionary.html: showAddStatus shows "No new words to add." instead of a blank status.

## Review-gate decisions
REVERTED (honor prior decision): removing `gotTerminalEvent` from dictation.js. This session's
  review flagged it as redundant (true today, and the fix verified SOUND), but the 2026-06-17
  notes above already evaluated and KEPT it as deliberate belt-and-suspenders in untested async
  code. Re-applied the flag + a comment pointing here, rather than re-litigate the decision.
REJECTED: collapsing engine:apply's provider check into settings.js patchFromView. They already
  share the exported VALID_PROVIDERS set and legitimately differ (engine:apply returns a
  user-facing error; patchFromView silently sanitizes on save). Merging loses the feedback.
LEFT INTENTIONAL: the `|| failureHandled` guard in finalizeAndSend (dictation.js) drops a
  transcript that lands AFTER the 20s watchdog fired. The original diff added this on purpose
  ("don't paste into a field the user moved on from"). Defensible; not reverted. Flagged to user.

## Verified
- node --check clean on all touched modules. unit 110/110. parity NOT runnable here (needs
  OPENAI_API_KEY even to boot the relay) — origin-rejection logic verified by reasoning + the
  new parity test asserts it. cleanup-test needs a live LLM; not run.
- main.js/dictation.js/providers have no automated coverage; verified by the adversarial workflow.

## 2026-07-30 — empty transcripts on good audio: root cause + batch retry

### Root cause (from ~/Library/Application Support/GVoice/debug.log)
The 12:45:17 dictation is a latch race, not silence:
```
12:45:21.127  Sending commit (socket readyState=1)
12:45:24.127  ALL EMPTY (reason=safety_timeout)   <- exactly commit+3000ms
12:45:27.894  [relay] deepgram connected          <- open lands 3.8s LATER
```
`emitCompleted` sets `completedSent = true` and nothing ever resets it, so the transcript
Deepgram returned after the open was discarded. Proof the audio was fine: the batch API on
that same clip (dictation-1785415524136-6tx2.wav) returns "Go through all my chats in all the
repos." The 3s safety timeout was being spent on the HANDSHAKE instead of on the engine.

Fix: `armSafetyTimeout()` — armed at commit, RE-armed in the leg's `open` handler when a
Finalize was owed. The clock now only ever measures time the engine had to answer.

The 12:42:41 failure (`commit_no_live_legs`, 7.2s handshake, no `deepgram closed` logged until
22s later) is NOT explained by the code as read. Same shape — completion decided on socket
bookkeeping rather than on "did the engine answer" — but the specific cause is unproven. Did
not write a confident story for it.

### Decisions
- CHOSE: recovered text goes to the CLIPBOARD + pill, NOT auto-pasted. Timed the batch path
  end-to-end: 1.1-6.2s (upload-bound; 1.7MB/36s clip took 6.3s). `savedForegroundHwnd` is
  stale by then, so auto-paste would land in whatever window the user moved to. Auto-paste is
  one line away (`processTranscript(text, null)`) if Mark wants it.
- CHOSE: batch retry runs AUTOMATICALLY on every empty result, not only on a button. The user's
  complaint was that a recorded clip should have transcribed — making them click for it keeps
  the bug's symptom.
- CHOSE: `detect_language=true` for language auto/multi in batch. Streaming needs the
  one-leg-per-language workaround because streaming has no hr detection; batch does. Half the
  cost, one request.
- CHOSE: reuse `withRetry`/`httpError` from src/retry.js. Deepgram batch returned a real 408
  SLOW_UPLOAD during testing on this network, and 408 is already in `isRetryableHttpStatus`.
- CHOSE: `resolveDeepgramKey()` exported from realtime-relay.js and used by BOTH the relay and
  main.js. A different resolution order would make "the retry failed too" undebuggable.
- REJECTED: a new src/providers/deepgram-batch.js. Second export in deepgram.js shares
  `addKeyterms` (extracted from legUrl) so a retried dictation spells custom names the same way
  a live one does.
- REJECTED: running the LLM cleanup pass on recovered text. Adds seconds to an already-slow
  path; the raw transcript is what the user is missing.
- NOT sent to Deepgram batch: `encoding`/`sample_rate`. Those are raw-audio params; with a WAV
  body they 400 with a message that reads like an auth failure. Asserted in the unit test.

### Verified on the running app (pnpm start, 2026-07-30)
- Tray icon present; menu opens; new "Transcribe last recording again" item present (screenshot).
- Clicked it: `retranscribe {... len:41, ms:1103}`, clipboard held the recovered sentence.
- Clicked the pill's new "Transcribe again" button (nut-js real mouse move + click): second
  `retranscribe` entry at 13:23:07. Pill renders all four buttons + ✕ at width 700, nothing
  clipped; the reason label wraps to two lines and stays fully readable.
- unit 131/131 (4 new). parity 3/3 runnable — "deepgram completes one utterance" still passes,
  so the safety-timer refactor didn't break the normal streaming path.
- The slow-handshake race itself is NOT reproducible on demand (needs Deepgram to take >3s to
  connect). Fix is verified by reasoning against the log + the unchanged parity pass, not by a
  live repro.
