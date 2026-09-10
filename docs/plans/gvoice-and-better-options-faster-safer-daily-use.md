# GVoice and Better Options: faster, safer daily use

Written 2026-09-10 on the Mac mini. Nothing runs until Drago types the `/tier` line at the end.

Two apps, two folders, one plan. GVoice lives in `/Users/macmini/dev/voice` (Electron, Node
24, pnpm). Better Options lives in `/Users/macmini/dev/better-options` (Swift package, macOS
13+). The plan file sits in the GVoice folder because most of the work is there; steps say
which folder they touch.

## What this buys

- The mic is ready the moment the button goes down. No clipped first word.
- Mouse-button dictation stops faking a Ctrl+Cmd keypress and talks to GVoice directly, so
  a stuck chord can never leave the mic recording with no way to stop it.
- Text never lands in the wrong window. If the window changed while GVoice was
  transcribing, the text waits on the clipboard with a "Ready to copy" pill instead.
- Better Options honours "Pass Through", remembers being switched off, and resets one
  mouse at a time.
- One clear status line each for microphone, engine, companion and permissions.

## Decisions already made (do not re-ask)

- Microphone default for this Mac: **Always ready**.
- Dictation stays English-only.
- A changed paste destination offers **Copy**, never a paste into the new window.
- Simulated Ctrl+Cmd presses are replaced by a local socket, not improved.
- Keep every provider, model, dictionary entry, recording and the unfinished cleanup edits.
- Keep Electron and Swift. No framework rewrite, no new cloud provider, no model download,
  no unrelated features.

## What is true today (checked 2026-09-10, read-only)

- Both installed apps are running from `/Applications`: GVoice (pid 60242 at check time)
  and Better Options (pid 67186). **The installed GVoice runs its speech engine from the dev
  folder**: `whisper-server -m /Users/macmini/dev/voice/models/ggml-small.en-q5_1.bin`.
  Never move, rename or clean `models/` during this work.
- The speech engine's PID file is `$TMPDIR/gvoice-whisper-server.pid`, shared by every
  GVoice instance on the Mac. A dev launch reaps whatever that file names if `ps` says
  "whisper-server". So a dev run today can kill the installed app's engine. Step 2 fixes
  this before any dev launch.
- GVoice's packages are **not installed**: `node_modules/` is empty. Five of the twenty
  unit check files fail today with `Cannot find package 'ws'`. The "34 checks pass" figure
  from the earlier draft is stale until step 1 installs packages and re-counts.
- GVoice's working tree has uncommitted edits in eight files (the cleanup modernisation:
  `src/cleanup.js`, its tests, docs, `package.json`, `public/settings.html`, `.env.example`)
  plus untracked docs, fixtures and scripts. The remote is two commits ahead (docs only).
  Neither is reconciled by this plan. Work happens in a worktree off local `main`.
- Hold-to-talk triggers in `src/hotkey.js`: right Option, left Ctrl + left Cmd chord, mouse
  back button. The mouse button is handled as a **toggle** because uiohook on macOS
  reports its release as a second press.
- Better Options' `Sources/GVoiceIntegration.swift` posts synthetic `flagsChanged` events
  for left Ctrl then left Cmd. `AppCoordinator.swift` only swallows the side button while
  GVoice's bundle (`com.purr.gvoice`) is running. Release-on-disconnect exists
  (`releaseHeldChord`).
- `src/dictation-session.js` has a `generation` counter. Error events carry it and are
  dropped when stale. The success path checks `stillMine()` in two places in `main.js`
  (near lines 1552 and 1739) but the clipboard write and paste are not re-checked right
  before they happen. Delivery has no session ID of its own.
- `src/typing.js` pastes via clipboard + osascript ⌘V, then restores the old clipboard
  250 ms later without checking whether the user copied something else in between.
- Mic warmth: `public/dictation.js` keeps the capture graph alive `MIC_IDLE_MS = 120000`
  after the last dictation, then drops it. Cold mode is a compile-time constant (0).
- Better Options settings live at `~/Library/Application Support/BetterOptions/settings.json`.
  `resetToDefaults(deviceID:)` replaces **all** settings, not one device's.
  `persist()` logs a save failure and shows nothing.
- `better-options/install.sh` at the repo root is a stray Claude Code status-line
  installer. It has nothing to do with this app. The real installer is
  `scripts/install.sh`; the bundle builder is `scripts/build_app_bundle.sh`.
- GVoice's `.env` is a secrets file. No agent may write it. Every new preference goes in a
  JSON file under the app-data folder, never in `.env`.

## Dependencies

Step 1 gates everything. Step 2 gates every later dev launch (5 onward). Steps 5 → 6 → 7 →
8 → 9 → 10 → 12 → 15 → 16 all edit `main.js` and run **one at a time, in order**. Step 10
gates 11 and 12. Steps 11, 13 and 14 all edit `AppCoordinator.swift` and `SettingsStore.swift`
and run one at a time (13, then 14, then 11). Step 17 needs 5–16 done. Step 18 needs 17.
Steps 3 and 4 need only 1 and can run alongside 2. Steps 13 and 14 need nothing from the
GVoice side and can start right after 1.

## Steps

### 1. Worktree, packages, honest baseline count [gpt-6-astra/low]

In `/Users/macmini/dev/voice`: `git worktree add .claude/worktrees/daily-use -b worktree-daily-use`
off local `main` (do not pull; the two remote commits are docs). Leave the uncommitted
cleanup edits in the main checkout untouched. In the worktree run
`pnpm install --frozen-lockfile`, then `pnpm test:unit`. Write the pass/fail count per file
to `docs/reports/daily-use-baseline-2026-09-10.md`. In `/Users/macmini/dev/better-options`
run `scripts/check-settings.sh` and `swift build`; add both results to the same report.
Add a `## Claims` line to this plan naming the worktree.
-> verify: `pnpm test:unit` in the worktree exits 0, or the report names every failing file
and the failure is not `ERR_MODULE_NOT_FOUND`. `swift build` exits 0.

### 2. Isolate a dev launch from the installed app [gpt-6-astra/medium]

Add `GVOICE_USER_DATA` (absolute path). When set, `main.js` calls
`app.setPath("userData", …)` before `ready` and every derived path (recordings, history,
control socket from step 10, speech-engine PID file) lives under it. Move the PID file from
`$TMPDIR` to `<userData>/whisper-server.pid` and make it a JSON record: pid, process start
time from `ps -p <pid> -o lstart=`, userData path, port. `reapStale()` kills only when pid,
start time and userData path all match. Add `scripts/dev-isolated.sh` that launches
`pnpm start` with `GVOICE_USER_DATA=$PWD/.dev-userdata` and `GVOICE_DEBUG=1`.
-> verify: with the installed GVoice running, `scripts/dev-isolated.sh` starts, `pgrep -fl
whisper-server` shows two engines, and the installed app's engine pid from before the launch
is still alive after the dev app quits. Unit test covers the three-field ownership match.

### 3. Offline checks never touch keys or provider allowances [gpt-6-astra/low]

Make `pnpm test:unit`, `test:parity` and `test:pipeline-smoke` run with `.env` ignored
(`GVOICE_NO_ENV=1` honoured in `src/bootstrap-env.js`) and with every network provider
mocked. Move anything that needs a real key behind `pnpm test:live`, which refuses to run
unless `GVOICE_LIVE=1` is set. Document both in `SETUP.md`.
-> verify: `env -i PATH=$PATH HOME=$HOME pnpm test:unit` passes with `.env` renamed away
(rename back after). `pnpm test:live` without `GVOICE_LIVE=1` exits 0 with "skipped".

### 4. Measure before changing anything [gpt-6-astra/medium]

Using `scripts/verify-warm-standby.mjs`, `src/benchmark-run.js` and the fixture audio in
`scripts/parity/fixtures/` through the local Whisper engine (`ggml-small.en-q5_1.bin`),
record ten identical dictations: press-to-first-audio, release-to-result, paste duration.
Then five minutes idle: CPU (`ps -o %cpu`), RSS, number of live capture graphs, bytes
uploaded (must be 0). Append the medians to `docs/reports/daily-use-baseline-2026-09-10.md`.
-> verify: the report has all five medians with the command that produced each one.

### 5. One session ID from press to paste [gpt-6-astra/high]

`DictationSession` gets an immutable `id` (monotonic, plus a random suffix) issued by
`tryStart()`. Every renderer event (`transcript`, `error`, `mic-warning`, `partial`) and
every main-process continuation (cleanup, retry, recording save, recovery, delivery)
carries it. Replace the two ad-hoc `stillMine()` closures in `main.js` with one
`session.owns(id)` check. Successful transcripts get the same stale-drop treatment errors
already have. A late result for an old session is parked in history as "recovered", never
pasted.
-> verify: new unit test in `scripts/unit/dictation-session.test.js`: start A, start B,
deliver A's transcript → history entry, no paste; B's transcript pastes. Renderer test
asserts every emitted event carries `sessionId`.

### 6. Session state machine with idempotent stop and cancel [gpt-6-astra/high]

States: `idle → recording → processing → (completed | cancelled | failed) → idle`. One
transition function; illegal transitions log and return false. `release()` twice is a
no-op. `cancel()` from recording or processing marks `cancelled` and blocks delivery even
if a transcript arrives later. The safety timer becomes a transition to `failed`, not a
bare `busy = false`.
-> verify: unit tests for every legal and illegal transition, duplicate stop, cancel
during cleanup (transcript arrives after cancel → no paste, history "cancelled").

### 7. Check the destination again before pasting [gpt-6-astra/high]

At press, `src/foreground.js` (macOS branch) records the frontmost app's bundle id, pid,
window number and, when Accessibility allows, the focused element's role. Store it on the
session. Immediately before the clipboard write in `typeText()`, compare again. Same
app + window + editable focus → paste. Anything else, or unreadable → do not paste: leave
the text on the clipboard, show the pill "Ready to copy · ⌘V", add a history entry marked
"copy". Windows keeps its existing hwnd check.
-> verify: unit test with a stubbed foreground reader: match → paste path; mismatch →
clipboard holds text, no paste call, history entry present. Manual: hold, switch windows
during "Transcribing…", see the pill and paste by hand.

### 8. Clipboard as one serialised transaction [gpt-6-astra/medium]

In `src/typing.js`: a single queue so two deliveries never interleave. Snapshot the
clipboard (text, image, and RTF/HTML when present via `clipboard.availableFormats()`).
Write, paste, then restore **only if** the clipboard still reads back as our text. A user
copy in between wins and is never overwritten. Remove the bare 250 ms timer.
-> verify: unit test with a fake clipboard: (a) restore happens when unchanged, (b) restore
is skipped when the user copied "other" mid-paste, (c) an image survives a dictation.

### 9. Cancel and Copy last result [gpt-6-astra/medium]

Escape while the pill shows recording/processing, and a click on the pill, call
`cancel()` (step 6). Tray menu gains "Copy last result" (reads the newest history entry).
Recovery storage follows the recordings preference: no clip is written when recordings
are off.
-> verify: manual on the isolated dev app: cancel during hold → no paste, pill shows
"Cancelled"; "Copy last result" puts the last text on the clipboard. Unit test: cancel
sets `cancelled` and delivery is skipped.

### 10. GVoice control socket for the companion [gpt-6-astra/high]

`src/control-socket.js`: `net.createServer` on `<userData>/control/gvoice.sock`, directory
mode 0700, socket unlinked on start and quit. Protocol v1, newline-delimited JSON, frames
over 4096 bytes close the connection. Messages: `hello {version, client}` →
`status {version, ready, micMode, session}`; `start {requestId}` → `ack {sessionId}` or
`refuse {reason}`; `stop {requestId, sessionId}`; `cancel {requestId, sessionId}`;
`heartbeat` every 2 s from the client. One owner at a time: a second `hello` is refused
with `busy`. No heartbeat for 6 s, or connection close, ends a companion-owned recording
as a normal release (transcript still delivered or parked). Recording duration limits stay
as in `main.js` (`MAX_HOLD_MS`). Unknown version → `refuse {reason: "version"}`.
-> verify: `scripts/unit/control-socket.test.js` covers handshake, refuse on second owner,
malformed frame, oversize frame, heartbeat timeout ending a recording, start/stop with
session IDs. `ls -ld <userData>/control` shows `drwx------`.

### 11. Better Options talks to the socket [gpt-6-astra/high]

Replace the body of `GVoiceIntegration.swift`: an `NWConnection` to
`NWEndpoint.unix(path:)` at `~/Library/Application Support/GVoice/control/gvoice.sock`
(path is a constant next to the bundle id). Handshake on connect, reconnect with backoff
while GVoice is running, heartbeat every 2 s. Readiness (`connected && status.ready`) is
cached on the main thread; the event tap callback only reads the cached flag. Press with
no readiness → let the click through unchanged. Once a press is consumed, its release is
consumed too, even if readiness changed. GVoice running but no socket → menu shows
"GVoice: update needed for mouse dictation" and the button passes through. Delete
`postModifier`, `dispatchPTTEvent`'s key synthesis and `togglePTT`'s chord; the thumb
wheel toggle now sends `start`/`stop`.
-> verify: `swift build` clean. With the isolated dev GVoice from step 2 running, hold the
side button: the socket log shows `start`, release shows `stop`, and no `flagsChanged`
events appear in `log stream --predicate 'process == "BetterOptions"'`. Kill GVoice
mid-hold: menu flips to "not running" and the next press passes through.

### 12. Retire the raw mouse toggle while a companion owns the button [gpt-6-astra/low]

In `src/hotkey.js`, expose `setMouseBackEnabled(bool)`. `main.js` disables it while a
companion is connected (step 10) and re-enables on disconnect. Keyboard triggers unchanged.
Windows path untouched.
-> verify: unit test in `scripts/unit/hotkey-logic.test.js` or a new
`hotkey-mouse-gate.test.js`: with the gate off, mouse button 4 events produce no press.
Manual: with Better Options connected, one button press starts exactly one recording.

### 13. Better Options control faults: confirm, then fix [gpt-6-astra/high]

For each claim below, first reproduce it in code or on the running app; fix only what
reproduces and log the rest as "not reproduced" in `docs/reports/daily-use-better-options-2026-09-10.md`
(better-options folder). Claims: (a) saved `enabled` is not authoritative at launch or
drifts between menu and Settings window; (b) `.passThrough` is not honoured for the wheel,
side buttons or keyboard mappings; (c) an unknown action string is dropped from the file
instead of kept and treated as pass-through; (d) HID callbacks lose device identity so an
event can be delivered twice or the wrong event suppressed; (e) a held control is not
released on disconnect, permission loss, remap change, disable, sleep or quit.
-> verify: `swift build` clean, `scripts/check-settings.sh` still byte-identical. Report
lists each of (a)–(e) as fixed-with-repro or not-reproduced. Manual: quit with remapping
off, relaunch, menu shows off.

### 14. Better Options settings: per-device reset, visible save failures, wheel controls [gpt-6-astra/medium]

`resetToDefaults(deviceID:)` replaces only that device's bindings; keyboard reset restores
pass-through, mouse reset restores the existing defaults. `persist()` failure shows an
alert once and keeps the last saved settings in memory. Settings window re-reads
connection state every 2 s while open. Coalesce wheel bursts and volume HUD updates
without dropping a direction change. Add "Wheel sensitivity" and "Reverse wheel" with
defaults equal to today's behaviour.
-> verify: `scripts/check-settings.sh` passes (old files still round-trip). A settings file
with two devices: reset one, the other's bindings are unchanged (settings-check case).
Manual: make the settings file read-only, change a binding, see the alert.

### 15. Microphone modes, preferred mic, and calm recovery [gpt-6-astra/high]

New preferences file `<userData>/preferences.json` (never `.env`): `micMode`
(`always` | `balanced` | `hold`), `preferredMicId`, `preferredMicLabel`. `public/dictation.js`
reads `MIC_IDLE_MS` from the mode: `always` = never drop, keep a bounded pre-roll ring
(600 ms as today) and upload nothing while idle; `balanced` = today's 120 s; `hold` = cold.
Default `always`. Settings page: mode picker plus a mic selector that writes
`preferredMicId` and shows "Preferred: X · Active: Y". On disconnect fall back to the
system default, label it "fallback", and return to the preferred device on the next
between-dictation check when it is back. Serialise graph build/recovery behind one
promise; quiet audio alone never triggers a device switch or a renderer reload.
-> verify: unit tests in `scripts/unit/mic-health.test.js` for the three modes and the
fallback/return rule. Manual on the isolated dev app: pick the Anker mic, quit, relaunch,
settings show it selected and `currentDeviceId` matches it in the debug log.

### 16. One status line each, and current wording [gpt-6-astra/low]

Settings page and tray show four lines: Microphone, Engine, Companion (Better Options),
Permissions, each with one action button when something is wrong ("Open Accessibility",
"Pick a mic", "Restart engine"). Fix outdated shortcut text in `public/settings.html`,
`README.md`, `SETUP.md` and `docs/ARCHITECTURE.md` (mouse button now via companion; Cancel;
Copy last result; mic modes).
-> verify: `grep -rn "Ctrl+Cmd\|Ctrl + Cmd" README.md SETUP.md docs/ARCHITECTURE.md
public/settings.html` returns only the keyboard-chord description. Screenshot of the
settings page saved to `.verification/`.

### 17. Regression bundle and before/after numbers [gpt-6-astra/medium]

Run the full offline set: `pnpm test:unit`, `pnpm test:parity`, `pnpm test:pipeline-smoke`,
plus the new socket, session, clipboard and mic tests. Repeat step 4's measurements on the
worktree build. Write `docs/reports/daily-use-results-2026-09-10.md` with before/after
medians. Targets: warm press-to-first-audio ≤ 150 ms; release-to-result median within 10 %
of baseline (investigate and fix any regression above that before step 18); five minutes
idle shows one capture graph, flat RSS (±10 MB) and 0 bytes uploaded.
-> verify: every command exits 0 and the results report has the before/after table with
each target marked met or not met.

### 18. Build both apps, keep rollback copies, replace the installed ones, prove it live [gpt-6-astra/high] GATED

Build `dist/mac-arm64/GVoice.app` (`pnpm build`) and `dist/BetterOptions.app`
(`scripts/build_app_bundle.sh`). Copy the current `/Applications/GVoice.app` and
`/Applications/BetterOptions.app` to `backups/installed-2026-09-10/` in each repo before
touching them. Quit both running apps, replace, relaunch, re-grant Microphone and
Accessibility if macOS asks. Then on the real apps: both tray icons visible and menus open;
the selected mic survives a relaunch and is the device actually capturing; side-button hold
starts and release stops; switch windows during transcription and get "Ready to copy";
five dictations land in the right window. Record each check in the results report.
Physical scenarios not seen (unplugging the mouse mid-hold, sleep during hold) are written
down as unverified.
-> verify: `pgrep -fl "GVoice|BetterOptions"` shows the new binaries' paths and start
times; the results report has every check above marked seen or unverified.

## After the steps

- Commits stay local in the worktree on branch `worktree-daily-use`. Pushing is a gate:
  ask, naming both folders and the branch.
- Merging the worktree back into `main` waits for Drago's word, because `main` still holds
  his uncommitted cleanup edits.
- Windows: offline checks must still pass; the Windows polling path in `src/hotkey.js` and
  `src/foreground.js` is not to be changed. No Windows runtime certification in this pass.

## Not in this pass

- The cleanup modernisation (`src/cleanup.js` edits in the main checkout).
- Pulling the two remote docs commits.
- Any model download, provider change or language beyond English.
- The stray `better-options/install.sh` at the repo root (leave it; it is not the app
  installer).

## Claims

- 2026-09-10, Mac mini, Claude session (.claude-ulix): started this plan via `/tier`.
  Running steps 1-17 in the worktree `/Users/macmini/dev/voice/.claude/worktrees/daily-use`
  (branch `worktree-daily-use`) and in `/Users/macmini/dev/better-options` on `main`.
  Step 18 is GATED and not started. Another window: pick something else or ask first.

/tier /Users/macmini/dev/voice/docs/plans/gvoice-and-better-options-faster-safer-daily-use.md
