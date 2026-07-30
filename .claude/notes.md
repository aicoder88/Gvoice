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
- unit 127/127 (4 new). parity 3/3 runnable — "deepgram completes one utterance" still passes,
  so the safety-timer refactor didn't break the normal streaming path.
- The slow-handshake race itself is NOT reproducible on demand (needs Deepgram to take >3s to
  connect). Fix is verified by reasoning against the log + the unchanged parity pass, not by a
  live repro.
- Post-review fixes, re-verified: `dictation:failure` no longer flashes its own pill before the
  retry (that also left a 45s safety-hide timer armed under the retry's states — only hidePill()
  clears it); the retry owns the pill whenever a clip exists. A `retryInFlight` guard makes a
  second tray click a no-op — confirmed: two triggers 1s apart produced ONE retranscribe entry.
  `DictationSession.fail()` is finalize()+done(), so awaiting the retry after it can't wedge the
  state machine.
- Side effect worth knowing: a successful retry writes a NEW history entry, so retrying an old
  clip shows up at the retry's timestamp, not the original dictation's.

## 2026-07-30 — polish candidates (asked "any other fixes?"; nothing edited yet)

Repo state at scan: clean tree, unit 127/127, no TODO/FIXME/ponytail markers in source.

### Proposed, ranked
1. **Start at login.** No `setLoginItemSettings`/`openAtLogin` anywhere in main.js. A menu-bar
   push-to-talk app that doesn't come back after a reboot is dead until the user remembers it.
   Size: tray checkbox + one Electron call + persist in settings. Verifiable by reading back
   `app.getLoginItemSettings().openAtLogin` and rebooting.
2. **Accessibility-denied message is wrong advice.** VERIFIED against the dep source, not guessed:
   `uiohook-napi` addon.c:229 throws `UIOHOOK_ERROR_AXAPI_DISABLED` when Accessibility is off, so
   `setupHotkey()`'s catch (main.js ~930) DOES fire — the app is not silently dead. But the
   notification says "Quit and reopen the app. Details are in debug.log", which never mentions
   permission. libuiohook calls `AXIsProcessTrustedWithOptions` WITH the prompt option
   (libuiohook/src/darwin/input_helper.c:62-72), so macOS shows its own "control this computer"
   dialog at the same moment — user sees a system permission prompt and an app notification that
   says to restart. Fix: branch on the AXAPI code, say "Allow GVoice in Privacy & Security >
   Accessibility, then reopen", and open the pane with
   `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`.
   Note for verification: this machine already has the grant, and dev (Electron.app) and built
   (GVoice.app) are SEPARATE grants — an unsigned rebuild can drop it, so this is not a
   fresh-install-only path. The false branch can only be seen by forcing it in dev or revoking
   the grant; do not revoke unprompted.
3. **`commit_no_live_legs` instrumentation, not a fix.** The 2026-07-30 notes above say the
   12:42:41 failure is unexplained. deepgram.js:288 emits that reason from leg bookkeeping alone.
   Log the leg states + last close code/reason at commit so the next occurrence is diagnosable.
   Proposing a fix for an unproven cause would be the symptom-patch this repo normally rejects.
4. **`pnpm test` alias** in package.json (unit + parity). Trivial; the 2026-06-17 continuation
   already listed it as an open follow-up (item 4f).

### Considered and dropped (do NOT re-raise)
- Retry writes a new history entry at the retry's timestamp — already evaluated and accepted on
  2026-07-30. Not a new finding.
- Recovered text goes to clipboard instead of auto-paste — deliberate (stale `savedForegroundHwnd`).
- parity "openai bad-key" test always skips — network-dependent, zero user-visible value.
- Log rotation, recordings pruning (count + age caps), history atomic write: all already correct.

### Outcome (same day) — 3 fixed, 1 was already there

**Item 1 was WRONG: "Start at login" already exists** (main.js `rebuildTrayMenu`, checkbox wired to
`app.setLoginItemSettings`). The earlier scan missed it because `grep -n ... main.js | head -20`
truncated before line 1795. Confirmed on the running app: the tray menu shows it, already ticked.
Lesson worth keeping: never conclude "X is absent" from a `head`-truncated grep.

**Item 2 — Accessibility (done).** main.js: new `hotkeyNeedsAccessibility`, set in setupHotkey's
catch when `error.code === "UIOHOOK_ERROR_AXAPI_DISABLED"` on darwin. Drives (a) its own tray
tooltip, (b) a notification whose body names the permission and whose click opens the pane, (c) two
new tray items at the very top ("⚠ Dictation key blocked — needs permission" + "Allow GVoice in
Accessibility…"). `openAccessibilitySettings()` opens
`x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`.
`dlog("hotkey-failed")` now records the error code, not just the stack.
VERIFIED both branches on the running app: granted -> the two items are absent and the menu is
normal; forced-denied (temporary `GVOICE_FAKE_AXAPI` throw in dev, since revoking the real grant was
off-limits) -> dlog shows `{"code":"UIOHOOK_ERROR_AXAPI_DISABLED"}`, both items render at the top,
and clicking the second opened System Settings on Privacy & Security > Accessibility with GVoice.app
in the list (screenshot). The temporary throw was removed afterwards.

**Item 3 — commit instrumentation (done).** deepgram.js logs one line at commit with each leg's
socket state, before the loop that silently marks a closing/closed leg `flushed`.
VERIFIED live by driving the running relay over WebSocket (append + commit, no mic needed):
`[relay] deepgram commit en:connecting` — and that run went on to `safety_timeout`, so the line
already does its job. Note it reaches debug.log only in a PACKAGED launch (main.js mirrors
console.error to the file behind `app.isPackaged`); in dev it goes to the terminal.

**Item 4 — `pnpm test` (done).** unit + parity, not cleanup (that one needs a live LLM). Ran:
127/127 unit, parity 3 pass / 3 skip (whisper model absent, OPENAI_API_KEY absent).

### Unrelated thing seen while verifying — dev app gets no audio
The dev launch (Electron.app, not the built GVoice.app) loops `recovery-escalate {"reason":
"startup"}` and answers a real hold with "No sound is reaching GVoice". Default input is the
built-in mic and it is the system default, so this smells like the dev Electron binary missing its
own Microphone TCC grant rather than a device problem. Not touched by any of today's changes — the
hotkey press/release still logged correctly through it. Not investigated.

## 2026-07-30 (later) — "no voice detected, but the recording plays fine"

### What the evidence says
Mark's failing dictation is 14:29:31Z, clip `dictation-1785421777117-cxhz.wav`. Measured: 2.05s,
max_volume -12.8 dB — real speech, not a quiet room. Live result was
`ALL EMPTY (reason=safety_timeout) en:words=0`, i.e. Deepgram answered nothing in the 3s window
after commit.

**Replayed that exact clip through the same relay + Deepgram, same query string the renderer uses
(`?provider=deepgram&language=en&model=nova-3`): `"Testing one two three."`, conf 0.917, answer in
319ms after commit.** So the audio, the baked Deepgram key, the relay, and the params are all fine.
A healthy flush is ~320ms, so the 3s timeout is not tight — that run simply got nothing back.

### The actionable finding
`/Applications/GVoice.app` was built **Jul 27 19:52**. Extracted its asar:
`grep -c armSafetyTimeout` = 0, `grep -c retranscribeRecording` = 0. It contains **none** of today's
deepgram work — not the discarded-transcript fix, not the automatic batch retry from disk. Mark has
been hitting the exact bug that was fixed in source this morning and never built. Rebuilt
(`pnpm build`); the new `dist/mac-arm64/GVoice.app` has both (armSafetyTimeout present, tray
verified via System Events). Swapping it into /Applications is pending Mark's OK.
Note the retry is what actually rescues this symptom: on THIS clip the batch path returns the
sentence, so the same failure now lands the text on the clipboard instead of showing nothing.

### Correction to the earlier "your mic is deaf" report — that was wrong
It was based on (a) a synthetic nut-js hold that logged `peak=0.0000` and (b) `ffmpeg -f
avfoundation` recording -91 dB. Mark's own 16:29 dictation captured clean speech minutes later, so
the mic works. The ffmpeg silence is most likely ffmpeg (via the shell) lacking its own Microphone
TCC grant, which macOS answers with zeros rather than an error. Don't repeat that claim.

### Not a repro (recorded so nobody re-runs it)
Playing the clip through the speakers into the built-in mic during a simulated hold produced a
5.29s clip at -17.2 dB that is genuinely unintelligible — Deepgram returns empty for it BOTH live
and on replay. That is correct behavior, not the bug. Acoustic playback can't reproduce this;
it needs Mark's voice.

## 2026-07-30 (later still) — "the paste didn't land" on every dictation, wrongly

### Root cause, proven on the running app
`typed {"len":22,...,"pasted":true,"verified":false,"target":"cmux","readLen":0}`

The post-paste read-back (main.js, `readbackPasteTarget`) asks the focused element for its AXValue
and downgrades the paste when our text isn't in it. cmux — Mark's main app — answers with an
**empty string**, not null. `typeof "" === "string"`, so the old code took the empty-but-readable
branch, `"".includes(text)` was false, and it declared a paste that had visibly landed a failure:
a 30s error pill saying "Click Copy — the paste didn't land" over text already on screen. Seven in
a row at 14:50. The code was IDENTICAL in the Jul 27 build (diffed the extracted asars) — nothing
regressed; he simply started dictating into an app whose composer reads back empty.

### Fix
A failed read-back no longer sets `pasted = false`. It can't tell "the paste missed" from "this app
doesn't expose its composer" (web areas, Electron/rich-text editors), so it now only feeds
`uncertain` — success pill, 8s linger, text still copyable. The signals that genuinely prove a miss
are untouched: typeText threw, no editable field focused, Windows foreground lost.
Also added `verified` / `target` / `readLen` to the `typed` log line (app name and length only —
never the dictated text or the field's contents) so the next weird paste is diagnosable.

### Verified end-to-end on the running installed app
Played Mark's own clip through the speakers at full volume into the mic during a simulated hold:
Deepgram returned "Testing one two three." (conf 0.956) and the paste logged `pasted:true,
verified:false` — no error pill, no "Click Copy" line in the renderer log (the failing runs logged
`Final: Click the copy. The paste didn't land.`). Side effect: that test typed one sentence into
whatever had focus (cmux).

### Rejected
Adding "cmux" to TERMINAL_BINARIES. The generic fix already covers it; a second mechanism for the
same problem means the next app with a quiet composer needs another entry.

## 2026-07-30 — code-review fixes: two known tradeoffs left in

- **Clipboard race, accepted.** `retranscribeRecording` now runs with the
  dictation session already re-opened, and its `clipboard.writeText(cleaned)`
  is deliberately NOT behind the `ownsPill()` guard. So a retry landing while a
  new dictation is mid-paste can collide (typeText saves/restores the clipboard
  around a 250ms window). Guarding it would trade a rare collision for
  guaranteed loss of the recovered text — the clipboard is the ONLY place that
  text lives. Left as is.
- **Tray "Transcribe again" during a live dictation is silent.** `ownsPill()`
  suppresses the retry's pill writes so it can't paint over "Listening…", and
  `retranscribeOnDemand` only speaks up for the on-device-engine case. The text
  still reaches the clipboard and Recent dictations. Narrow; not worth a
  queue-and-replay.

## Client-feedback pass — mic light, deaf hotkey, Mac local engine (30 Jul 2026)

- **`powerMonitor.getSystemIdleTime()` is not Accessibility-gated.** Probed with
  a throwaway ad-hoc-signed app bundle that had never been granted anything:
  `isTrustedAccessibilityClient()` returned false, idle time still read fine.
  That's what makes the deaf-hotkey watchdog's cross-check viable at all — if
  the idle read had needed the same permission we were missing, the warning
  could never have fired in the case it exists for.
- **The "launched from an untrusted parent" repro produces the LOUD failure,
  not the silent one.** Launching GVoice as a child of an unsigned app with no
  Accessibility grant makes `uIOhook.start()` throw
  `UIOHOOK_ERROR_AXAPI_DISABLED` — the path main.js already handles. So the
  client's silent case is something else (a hook that started and then went
  quiet), and the watchdog was verified by forcing `sawEvent` false in a
  throwaway build rather than by reproducing the client's exact environment.
- **Why the idle drop is armed in `finishUtterance`, not `stopRecording`.**
  Same branch the cold-mode teardown already lived in, and it's after the tail
  drain and the commit. Arming on key-release would arm mid-drain.
- **Why the idle timer re-checks at 5s instead of just firing.** `captureBusy` /
  `recovering` / a live hold all mean a teardown would land under an in-flight
  rebuild (the stacked-graph bug the codebase already guards against). Re-arming
  for the full idle period on a busy tick would instead push the drop out by
  minutes.
- **Dedup vs the old key.** `MIC_ALWAYS_ON` is still read when
  `MIC_IDLE_MINUTES` is absent, so an existing install keeps its behaviour. The
  live `.env` here now carries both (new key wins in the new build; the old
  `/Applications` build still honours the old one).
- **Rejected:** shipping a `GVOICE_FORCE_DEAF_HOTKEY` test seam. It would ship a
  fake-failure switch forever to save one temporary build during verification.
- **The deaf-hotkey watchdog must listen on uiohook's `input`, not on the four
  key/button events.** `powerMonitor.getSystemIdleTime()` counts mouse movement
  and scrolling; keydown/keyup/mousedown/mouseup don't. Listening narrowly
  would have shipped a false "GVoice isn't hearing your keyboard" at anyone who
  read a page for 30s after launch without typing. Measured on this machine: 6
  seconds of mouse movement = 12 `input` events, 12 `mousemove`, 0 `keydown`.
- **Synthetic CGEvents can't drive the watchdog's active-user branch.** They
  ARE delivered to uiohook (a synthetic right-Option hold starts a real
  dictation) but they do NOT reset HIDIdleTime — measured, idle kept climbing
  through both synthetic keys and synthetic mouse movement. Any future test of
  "user active + hook deaf" needs a real hand on the hardware.

## 2026-07-30 (evening) — cold-press latency + the seven review findings

- **Measured, on the running packaged build.** Cold press (mic idle-dropped),
  key-down → first captured frame: **2939ms before, 456ms after**. Old
  breakdown from the user's own log: 650ms IPC, +1356ms WS open, +2340ms relay
  upstream, +2939ms mic actually open, pre-roll `0B`. Every word said in that
  window was gone, which is exactly the "hold it several seconds before I start
  talking" report.
- **Why the socket stopped blocking the mic.** `startRecording` awaited
  `ensureSocket()` *then* `initCapture()`. Nothing in the mic path needs the
  socket: the relay queues binaries for its upstream leg, and the pre-roll flush
  re-sends whatever the ring holds once the socket is up. Kicking the handshake
  off and awaiting it after the mic is open makes the cost `max(mic, socket)`
  instead of `mic + socket`.
- **Why the pre-roll ring grows while `startInFlight`.** With the mic open first,
  the ring is the ONLY place the opening words live until the socket is up. The
  usual 600ms cap would clip a slow handshake. 20× (~12s) is a ceiling against a
  hung handshake, not a target.
- **The remaining 456ms is `getUserMedia` + worklet.** Unavoidable without
  holding the mic open, which is the orange-dot complaint the idle drop exists
  to answer. Not chased further.
- **The batch retry is now Deepgram-only, not "any non-local engine".** An
  OpenAI user's audio was being uploaded to api.deepgram.com with the shared
  fallback key on every empty dictation. Cost of the fix: OpenAI users lose
  automatic recovery — they get "No speech detected." and the pill, same as
  before the retry existed.
- **A retry that lost the pill no longer writes the clipboard either.** It could
  land seconds after a *newer* dictation had already restored the user's
  clipboard, silently replacing it with older text and no pill to explain it.
  Rescued text still reaches history and the tray.
- **Finding #4 was NOT fixed by restoring the `verified === false` downgrade** —
  that's the bug aedc11c removed (seven false "paste failed" pills). Instead the
  clipboard fallback arms on `likelyMissed` = read the field back, it had real
  content, ours wasn't in it. All seven false positives read back EMPTY
  (`readLen: 0`), so requiring content separates them. Reasoned from the logged
  `readLen`, not reproduced.
- **Muted mic arms the idle timer rather than dropping the stream.** Dropping it
  would also drop it for someone who set `MIC_IDLE_MINUTES=never`, overriding an
  explicit choice. Arming means the dot goes out on the user's own schedule.
- **Verified by hand:** cold-press timing, warm-press pre-roll, the idle drop
  itself, the auto-retry firing on an empty clip. **Not reproduced:** the
  clipboard race, the pill stomp, the muted-mic dot (all need timing or hardware
  I can't force); each was fixed from the code path, not from a repro.
- **Tray icon not re-verified visually** — the display was asleep during the
  test window and nothing in this change touches tray or startup code.
