# Fixes for the 2026-09-12 code review

Nine of the ten findings in `docs/reports/code-review-2026-09-12.md` are fixed.
One was a false positive and is deliberately untouched. Nothing is committed and
nothing is pushed; every change sits in the working tree on `main`.

Checks: `pnpm test` = 302 unit pass / 0 fail, parity 3 pass 3 skipped (live-only).
`pnpm run test:pipeline-smoke` exit 0. Nine new unit tests, all in existing files.

---

## What changed, finding by finding

### 1. Companion `stop`/`cancel` with no session id – FIXED, verified on the running app

`src/control-socket.js`: when neither the connection nor the frame can name a
press, the frame is refused with `reason: "session"` instead of being passed to
main.js, which reads a missing id as "whatever is live".

Verified live against the running dev instance: a companion whose `start` was
refused as `busy` then sent a bare `stop` and a bare `cancel`. Both came back
`{"type":"refuse","reason":"session"}`, the live press was untouched, and the
connection stayed open. It happened again by accident minutes later, on a press
started by a tray click – and that press survived, where before it would have
been cut off.

**Behaviour change to know about:** a companion's UNNAMED `cancel` after its own
`stop` is now refused too, because the connection's session id is cleared by the
stop. A companion that wants to cancel after release must name the press (the id
comes back in the `start` ack). A NAMED stop or cancel still works exactly as
before, including a retry after the press has ended.

### 2. "Click to cancel" during the paste window – FIXED, verified on the running app

Three pieces:
- `src/dictation-session.js` gains `markCancelled(id)`: mark a press the session
  has already let go of. Returns false when there is nothing to mark, so a stray
  Escape still costs nothing.
- `main.js` remembers the press being delivered (`deliveringSessionId`), set right
  after `done()` and cleared in the handler's `finally`. `cancelDictation` marks
  that press when `cancel()` has nothing live to end.
- `processTranscript` takes an `abandoned` callback and asks it once – after the
  cleanup pass, before the paste machinery and before anything touches the
  clipboard. A "yes" returns the cleaned words with `cancelled: true`; the handler
  parks them in history and shows no result pill.

Verified live, with a real spoken dictation into a scratch document:

```
transcript            {"len":246,"sinceRelease":1243,"sessionId":"9-c3030a5c"}
cancel                {"sessionId":"9-c3030a5c","wasRecording":false,"afterWords":true}
[dictation-session] cancelled 9-c3030a5c – after the words arrived
[main] cleanup done (732ms)
processed-cancelled   {"len":246}
transcript-cancelled-late {"sessionId":"9-c3030a5c","len":246}
```

No `typed` line, nothing in the document, and the clipboard still held the marker
string that was put there before the run. The same sequence before this change
pasted the sentence.

**Limit:** the check is at one point. Once `typeText` starts (about 640ms on this
machine) a cancel no longer stops it, and the pill still offers the click for
those 640ms. Narrower lie, not a removed one.

### 3. Unstamped renderer errors swallowed after a cancel – FIXED, not seen live

`main.js` `dictation:error` now only skips a cancelled press when the error names
it. An unstamped error (a renderer that reloaded and lost its stamp – the
dead-mic / relay-down case) reaches the pill again. `DictationSession` is
untouched, so the delivery rule that reads a missing name as "the live press"
still blocks a cancelled press's words.

Not reproduced on the running app: forcing an unstamped renderer error needs a
renderer reload mid-cancel, which nothing here can trigger from outside.

### 4. Mic rebuilt after every dictation – FIXED, one half verified live

Three pieces:
- `public/dictation.js` `getMicStream` now returns `{ stream, requestedId }`:
  which device id it successfully pinned, or null when it fell back to the system
  default. `buildCaptureGraph` keeps that in `currentRequestedId`, and
  `teardownCapture` clears it.
- `public/mic-health.js` `chooseCaptureDevice` takes `requestedId` and treats
  "opened FOR the preferred device" as being on it, so the comparison converges.
- `src/preferences.js` collapses a saved `"default"` / `"communications"` to no
  preference, and `reportMicState` no longer offers them in the Settings list.
  They are the browser's aliases for "whatever the computer is set to", which is
  the list's own first entry.

The live evidence for the bug shape, straight out of the running app's log:

```
mic-state {"activeId":"default","activeLabel":"Default - Anker PowerConf C200 (291a:3369)", ...}
```

The concrete device is the Anker; the live graph reports its id as `"default"`.
So a preference holding the Anker's real id could never equal the live id – the
rebuild was asked for every time, and Settings read "yours isn't plugged in" for
a microphone that was plugged in and recording.

Not verified live: the churn itself. Reproducing it needs a preference set to the
Anker's concrete id, and that id is a per-profile hash only the renderer can
enumerate – there is no way to set it without the Settings window.

### 5. Mouse-back toggle stuck after a cancel – FIXED, not seen live

`createMouseBackGate` gains `reset()` (clears the held flag, fires nothing),
`src/hotkey.js` exposes it as `resetMouseBack()` on both engines (a no-op on
Windows, which has no mouse trigger), and `cancelDictation` calls it.

Not verified live: it needs a physical press of the mouse's back button, which
nothing here can synthesise – uiohook reads real HID events.

### 6. Wrong microphone mode reported to the companion – FIXED, verified on the running app

`main.js` `hooks.status` reports `micPrefs.micMode` instead of the hardcoded
`"balanced"`. The running app answered `"micMode":"always"` – the real default –
on `hello` and on every heartbeat.

### 7. "ali" in the cleanup prompt – NOT A BUG, left alone

Croatian is a first-class dictation language here: `src/providers/deepgram.js`
auto-detects `["hr", "en"]`, `whisper-local.js` picks between an `hr` and an `en`
leg, and `scripts/fixtures/cleanup-quality-cases.js` carries Croatian cases –
including `"stranica je spremna ali cijenu treba još jednom provjeriti"`. The one
cleanup prompt formats both languages, so the comma rule for `ali` is deliberate.
Removing it would degrade Croatian dictation.

### 8. Short dictations truncated by the token ceiling – FIXED, not measured

`src/cleanup.js` adds `REASONING_HEADROOM_TOKENS = 512` on top of the
transcript's own budget, because the Groq gpt-oss models spend the same ceiling
on reasoning and on the answer. Only that request path uses this number;
Anthropic's is a flat 4096 and Google's sets none.

512 is a judgment, not a measurement – nothing here counts Groq's reasoning
tokens at `reasoning_effort: "low"`. If cleanup ever truncates again, measure
`usage.completion_tokens_details` and set this from data.

### 9. The `.env` isolation flag nothing ever set – FIXED

The two suites that load dotenv themselves (`scripts/parity`, `scripts/smoke`)
now do it only for a live run (`GVOICE_LIVE=1`, which is how
`scripts/run-live-tests.mjs` invokes them). Offline runs stay on a bare
environment with no shell prefix needed, so it works the same on Windows.
`GVOICE_NO_ENV=1` still forces it off even on a live run, and the misleading
comment in `src/bootstrap-env.js` now says what actually sets what.

### 10. Settings status messages on the wrong panel – FIXED, not seen live

`public/settings.html` `setStatus` takes an optional panel name: it writes to that
panel's save bar, else to the panel the user is looking at, else (no panel open)
to all of them as before. The microphone calls name their own panel, because
`loadMic()` runs at boot from whatever tab is open.

Not verified live: the Settings window can only be opened from the tray menu, and
an Electron tray menu does not open for a scripted click. The panel's real script
text IS exercised by `scripts/unit/settings-panel.test.js`, which grew a
`querySelector` / `querySelectorAll` stub for the new scoping.

### Also fixed (was in the review's "noted" list)

`main.js`: the cancel path now records `stripWhisperNoiseTokens(text)` like every
other path that logs a transcript nobody received, so "Copy last result" after a
cancel can't hand back a bare `[BLANK_AUDIO]`.

Left alone: `resolveProvider`'s `belongsToAnotherProvider` check discarding a
deliberately-set `CLEANUP_MODEL`. Changing it weakens a guard that exists to stop
one provider's model reaching another's endpoint; it wants its own decision.

---

## The companion app side (a second repo)

Better Options is the mouse-button helper:
`/Users/macmini/dev/better-options`, branch `main`. Finding 1 above made a
refusal reachable for a message that app sends every time the button comes up,
and its `handleRefusal` treated any refusal it could not match to a press in
flight as a broken CONNECTION – `dropConnection(unavailable: true)`. The side
button would then pass through as an ordinary back-click until GVoice restarted.
Worse than the fault being fixed, so it is fixed too.

The change: a refusal that names one of our own requests is about that one
request, never the connection. Only a refusal naming nothing hangs up, which is
exactly how GVoice's socket writes them (`refuseAndClose` sends no `requestId`).

Nothing about what Better Options SENDS needed changing: its `stop` already
carries the session id from the `start` ack, and it never sends `cancel`. Nothing
in it reads `micMode` either, so finding 6 needs nothing there.

Checked with that repo's own harness, `sh scripts/check-gvoice-socket.sh`: PASS,
including two new lines, "a refused stop leaves dictation on offer" and "and does
not hang up on GVoice". Reverting the fix makes the same check fail. `swift
build` completes.

It is NOT on that repo's `main`: that tree holds another session's uncommitted
work from 14:51 (`Sources/HIDDeviceMonitor.swift` plus the built binary), so the
change sits in its own copy, uncommitted, at

`/Users/macmini/dev/better-options/.claude/worktrees/gvoice-stop-refusal`
(branch `worktree-gvoice-stop-refusal`)

with its own write-up in that copy at
`docs/reports/gvoice-refused-stop-2026-09-12.md`. `/Applications/BetterOptions.app`
is untouched – installing from that copy would drop the uncommitted mouse-device
work.

---

## Flaws in this work, worst first

1. **A test sentence was pasted into another app's window.** At 14:50 a
   verification dictation captured TextEdit as its destination, TextEdit lost
   focus to a `cmux` terminal window before the paste, and the words went there:
   `typed {"len":67,"target":"cmux","verified":false,"readLen":0}`. The read-back
   came back empty, so it may never have landed in anything, but that cannot be
   proven. The sentence was "this sentence must never reach the document because
   I cancelled it". Worth a look at that window's input box.
2. **The clipboard was overwritten** with `CLIPBOARD-UNTOUCHED-MARKER` during the
   checks, and later with a test sentence. Whatever was on it before is gone.
3. **Cancel still cannot stop a paste in flight** (see finding 2's limit). The
   honest fix would make `typeText` interruptible, which is a bigger change than
   a review fix should carry.
4. **Three fixes were never seen working on the running app** (3, 5, 10), and
   one only half (4). Each is unit-tested, and each says above exactly why it
   could not be reproduced from outside the app.
5. **Anyone whose saved microphone was literally "default"** now reads as "no
   preference". Same microphone, same behaviour, but the Settings dropdown will
   show its first entry instead of a "Default" row that is no longer offered.
6. **The 512-token headroom is unmeasured** (finding 8).
7. **A companion's unnamed cancel after its own stop is now refused** (finding
   1). Better Options never sends one, so nothing breaks there today – but any
   other companion would have to name the press.
8. **The Better Options fix lives in a side copy, uncommitted**, and it has to
   be merged into that repo's `main` and installed before the side button
   actually benefits. Until then the running helper still hangs up on a refused
   stop, which finding 1 made reachable. Two moving parts, one of them not in
   place.
9. **The physical side button was never pressed** in any of this. Both repos'
   checks drive the code directly.

---

## Saved and put in place (2026-09-12, 17:28–17:30)

Both approved in one message ("1,2 yes"). Nothing pushed to GitHub; both repos
are local commits only.

**GVoice** – `/Users/macmini/dev/voice`, `main`, commit `9b6f46b` (21 files).
Rebuilt with `pnpm build` and installed over `/Applications/GVoice.app`. The old
copy is kept at `/Users/macmini/.app-backups/GVoice/2026-09-12-172825` (292 MB),
so putting it back is one copy.

The signature question that mattered: the installed app was signed by team
`JZ4Z22F6BM`, and macOS ties Accessibility and Microphone to the signature it
approved. The new build came out of electron-builder signed by the same team, so
the grants held – proved, not assumed:

```
press {"sessionId":"1-e5faf791","target":{"pid":702,"app":"cmux","role":"AXTextArea","editable":true}}
cancel {"sessionId":"1-e5faf791","wasRecording":true,"afterWords":false}
mic-state {"activeLabel":"Default - Anker PowerConf C200 (291a:3369)","open":true,"micMode":"always"}
```

A window read through the Accessibility API, the Anker opened, the press
cancelled with nothing typed. The socket answered `"micMode":"always"` – the real
setting, finding 6. No `hotkey-failed` this boot. The menu bar icon is there.

**Better Options** – `/Users/macmini/dev/better-options`, `main`, commit
`49981b4`, fast-forwarded from the side copy, which is now removed along with its
branch. Rebuilt and installed; signed with the same "Better Options Local
Signing" identity as the copy it replaced, which is what keeps its mouse grants.
Running as its own process, and GVoice logged it straight away:

```
[control-socket] companion connected: BetterOptions
```

### Not verified, and why

- **Neither physical button was pressed.** A synthetic left Ctrl+Cmd through
  AppleScript produced no press at all: the key hook reads hardware events, so
  scripted ones never reach it. The side button is the same. Both stay hand
  checks.
- **Input Monitoring for the new helper binary can't be read from here** (that
  table is sealed). The identical signature is the reason to expect it held.

### Two more things to know

- `scripts/install.sh` printed `Load failed: 5: Input/output error` when it
  reloaded the login item. The item was already loaded from before, which is why;
  nothing new auto-starts, and the app was started by hand instead. At the next
  login it starts exactly as it did yesterday.
- The helper was built from a tree still carrying another session's uncommitted
  mouse-device work (`Sources/HIDDeviceMonitor.swift`). That work is in the
  binary that was ALREADY installed, so nothing regressed by including it – but
  it is code this review never looked at, and it is still uncommitted on that
  repo's `main`.
