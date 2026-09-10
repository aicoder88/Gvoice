# Daily-use results — step 17, 2026-09-10

Worktree: `/Users/macmini/dev/voice/.claude/worktrees/daily-use` (branch `worktree-daily-use`),
head `d43bcc2` (step 16). Compared against `docs/reports/daily-use-baseline-2026-09-10.md`.

Everything below ran offline, no `.env` present in the worktree, `GVOICE_NO_ENV=1` set on
every launch. The installed GVoice (pid 60242) and its speech engine (pid 60265, started
`Thu 10 Sep 01:46:33 2026`) were alive before and after every command — checked with
`ps -p 60265 -o lstart=`, unchanged.

## The regression bundle

| Command | Exit | Result |
| --- | --- | --- |
| `pnpm test:unit` | 0 | 279 tests, 279 pass, 0 fail, 0 skipped. Baseline was 164 tests. |
| `pnpm test:parity` | 0 | 6 tests, 2 pass, 4 skipped (3 need `GVOICE_LIVE=1`, 1 needs a model in the worktree's `models/`). |
| `pnpm test:pipeline-smoke` | 0 | 1 test, 0 pass, 1 skipped (needs `whisper-cli` + a model under this checkout). |

The step's named new tests, run one file at a time, all exit 0:

| File | Pass | Fail |
| --- | --- | --- |
| `scripts/unit/control-socket.test.js` | 23 | 0 |
| `scripts/unit/dictation-session.test.js` | 27 | 0 |
| `scripts/unit/clipboard-transaction.test.js` | 8 | 0 |
| `scripts/unit/mic-health.test.js` | 28 | 0 |
| `scripts/unit/paste-destination.test.js` | 12 | 0 |
| `scripts/unit/cancel-and-copy.test.js` | 9 | 0 |
| `scripts/unit/hotkey-mouse-gate.test.js` | 4 | 0 |
| `scripts/unit/preferences.test.js` | 10 | 0 |
| `scripts/unit/whisper-pid.test.js` | 12 | 0 |
| `scripts/unit/dictation-renderer.test.js` | 4 | 0 |

Honest note on the two skips: the worktree has no `models/` folder of its own, and the
plan forbids touching `/Users/macmini/dev/voice/models/`. So the whisper-local legs of
`test:parity` and `test:pipeline-smoke` skipped here exactly as they skipped at baseline.
Neither is a new gap, and neither is a pass.

## Before and after

| What | Before (step 4) | After (step 17) | Change | Command |
| --- | --- | --- | --- | --- |
| Warm press-to-first-audio | 85 ms | **85 ms** | none | `npx electron scripts/measure-mic.cjs 10` |
| Cold press-to-first-audio | 442 ms | **397 ms** | 45 ms faster | same |
| Cold capture-graph build | 178 ms | **140 ms** | 38 ms faster | same |
| Release-to-result (engine) | 222 ms | **196 ms** | 26 ms faster | `WHISPER_MODEL=/Users/macmini/dev/voice/models/ggml-small.en-q5_1.bin node scripts/measure-engine.mjs 10` |
| Paste duration (real ⌘V) | 225 ms | **185 ms** | 40 ms faster | `npx electron scripts/measure-mic.cjs 10 --paste` |
| Five minutes idle — capture graphs | UNMEASURED | **BLOCKED** | — | `./scripts/measure-idle.sh 300` |
| Five minutes idle — memory | 72.15 MB (installed app) | **BLOCKED** | — | same |
| Five minutes idle — bytes uploaded | 0 (installed app) | **BLOCKED** | — | same |

Every run behind each median:

- warm press-to-first-audio: 87, 84, 85, 85, 85, 85, 85, 85, 85, 85
- cold press-to-first-audio: 706, 398, 395, 395, 409, 397, 397, 396, 396, 403
- release-to-result: 197, 196, 196, 196, 196, 197, 196, 196, 196, 196
- paste: 201, 183, 200, 196, 185, 182, 184, 181, 183, 186 (target window frontmost was
  confirmed as `Electron` and 890 characters landed in it, so no keystroke reached
  anything a person was working in)

## Targets

| Target | Verdict |
| --- | --- |
| Warm press-to-first-audio ≤ 150 ms | **MET** — 85 ms |
| Release-to-result median within 10 % of baseline (222 ms, ceiling 244 ms) | **MET** — 196 ms, 11.7 % faster. No regression to investigate. |
| Five minutes idle shows one capture graph | **NOT MET — could not be measured.** See the blocker. |
| Five minutes idle, flat memory (±10 MB) | **NOT MET — could not be measured.** |
| Five minutes idle, 0 bytes uploaded | **NOT MET — could not be measured.** |

## The blocker: the app still will not start

`scripts/dev-isolated.sh` dies before a window opens, on this checkout, today:

```
> electron .
App threw an error during load
ReferenceError: envFile is not defined
    at file:///Users/macmini/dev/voice/.claude/worktrees/daily-use/src/bootstrap-env.js:106:25
```

This is the same fault step 4 wrote down on 2026-09-10 and attributed to step 3. It was
never fixed. Commit `befd973` moved `const envFile = join(HOME, ".env")` inside an
`if (process.env.GVOICE_NO_ENV !== "1")` block (line 99) and left
`export const ENV_FILE = envFile;` outside it (line 106). `const` is block-scoped, so the
export always throws — with the flag set and without it.

Consequence, said plainly: **steps 5 through 16 were all landed without the app ever being
started once.** Their unit tests pass, but nothing in the session, socket, clipboard,
destination-check, cancel or microphone work has been seen running. The three idle targets
above depend on a running app and stay unmeasured.

This step did not fix it, on purpose. `src/bootstrap-env.js` is step 3's file and step 3's
verify line; changing it here would be a different step's work done under this step's name.
The one-line fix is to hoist the declaration above the `if`.

## Left unverified, and what a person must do

1. **Three idle numbers.** Fix `src/bootstrap-env.js` line 99/106 so the export is in
   scope, then run `./scripts/measure-idle.sh 300` in this worktree and read the
   "capture graphs built during idle" line plus the samples table it prints.
2. **Everything hands-on from steps 7, 9, 11, 12 and 15** — switching windows mid-transcription
   to see the "Ready to copy · ⌘V" pill, cancelling with Escape, "Copy last result",
   the mouse side button driving the socket, the preferred microphone surviving a relaunch.
   All of these need the app to launch and a human hand on a mouse and keyboard.
   None of them is claimed as passed anywhere in this pass.
