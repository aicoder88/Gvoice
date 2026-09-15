# Daily-use plan: run report, 2026-09-10

Plan: `/Users/macmini/dev/voice/docs/plans/gvoice-and-better-options-faster-safer-daily-use.md`
Run by the Claude session in `.claude-ulix`, dispatched with `/tier`. Seventeen agents,
one per step, no failures. Step 18 is gated and was not started.

Work lives in two places, both local, nothing pushed:
- `/Users/macmini/dev/voice/.claude/worktrees/daily-use`, branch `worktree-daily-use`, 15 commits.
- `/Users/macmini/dev/better-options`, branch `main`, 3 commits (`ddcc565`, `a3e7a84`, `4bb50e4`).

The main checkout at `/Users/macmini/dev/voice` was never touched. Its uncommitted cleanup
work is exactly as it was.

## The one thing that nearly wrecked the pass

Step 3 moved the `.env` path declaration inside an `if` block while the export below it
still referred to that name. Block scope, so every launch died on load:

    ReferenceError: envFile is not defined
      at src/bootstrap-env.js:106:25

Steps 5 to 16 all landed behind that crash. Their tests passed - the app could not start.
Three agents (9, 10, 17) found it, correctly refused to fix another step's file, and said so.
Step 17 called its own regression pass weak proof for exactly this reason, which is the right
call and the most useful sentence in the whole run.

Fixed after the run, in commit `bbda9f6`: declare the path once, outside, keep the skip inside.
Re-checked by hand: 279 offline checks pass; the app boots; the local speech engine warms at
boot and answers on its own port; the installed app's engine (pid 60265, started 01:46:33)
was alive before and after, and the installed Better Options (pid 67186) was never touched.

## Verify results, step by step

| Step | Verify | Note |
|---|---|---|
| 1 Worktree, packages, baseline | PASS | 164/164 at baseline, `swift build` clean |
| 2 Isolate the dev launch | PASS | two engines side by side, installed one survived a dev quit |
| 3 Offline checks need no keys | PASS as run, but shipped the crash | see above |
| 4 Before-numbers | PASS | idle numbers unmeasured, blocked by the crash |
| 5 One session id press to paste | PASS | wiring proven by reading, not by running (agent's own flag) |
| 6 State machine, idempotent stop | PASS | 36-cell transition table |
| 7 Re-check the destination | PASS automated / manual open | |
| 8 Clipboard as one transaction | PASS | |
| 9 Cancel and Copy last result | PASS automated / manual open | found the crash |
| 10 Control socket | PASS | folder mode `drwx------` confirmed |
| 11 Companion talks to the socket | PASS automated / manual open | driven against the real step-10 server |
| 12 Retire the raw mouse toggle | PASS automated / manual open | |
| 13 Companion control faults | PASS | 5 claims: 3 reproduced, 2 half - detail below |
| 14 Per-device reset, save failures | PASS | old settings files still round-trip byte for byte |
| 15 Microphone modes, preferred mic | PASS automated / manual open | |
| 16 Status lines and wording | PASS | screenshot taken from static markup, not the live window |
| 17 Regression and before/after | PARTIAL | 3 idle targets missed because the app would not boot |

### Step 13, what actually reproduced

- (a) Saved on/off state ignored at launch: **reproduced, fixed.** `remappingEnabled` was a
  literal `true`; nothing ever read or wrote it.
- (b) Pass Through ignored: **reproduced for the thumb wheel only, fixed.** Side button and
  keyboard were already gated correctly.
- (c) Unknown action name: **half reproduced, fixed.** It was not dropped from the file, but
  it was not treated as pass-through either - the control went dead.
- (d) Device identity in the HID callbacks: **half reproduced, half fixed.** The registry
  returned a keyboard as "the active mouse" with no mouse plugged in; fixed. Double delivery
  did **not** reproduce. Wrong-event suppression at the event tap is inherent and documented.
- (e) A held control not released: **reproduced, fixed.** There was one release call site and
  nothing called it on unplug, sleep, quit or a binding change. Now five. Release after the
  permission itself is revoked stays best-effort - posting the release needs that permission.

## Numbers, before and after

| What | Before | After | Target |
|---|---|---|---|
| Warm press to first audio | 85 ms | 85 ms | met, ceiling 150 ms |
| Release to result | 222 ms | 196 ms | met, 11.7% faster |
| Cold press to first audio | 442 ms | 397 ms | not a target |
| Paste duration | 225 ms | 185 ms | not a target |
| Idle: one capture graph | unmeasured | **not measured** | missed |
| Idle: memory flat within 10 MB | 72.15 MB installed | **not measured** | missed |
| Idle: nothing uploaded | 0 installed | **not measured** | missed |

The three idle numbers need `./scripts/measure-idle.sh 300` in the worktree. It runs the app
for five straight minutes. That is now possible - the crash is fixed - but it puts a second
dictation app on the same hold-to-talk key as the installed one for those five minutes.

## Still needs a hand at the Mac

None of these is claimed as passed. Every one needs a person; no agent can press a physical
button, unplug a device or sleep a Mac.

1. **Wrong-window guard.** Run `scripts/dev-isolated.sh` in the worktree. Click into a text
   field, hold right Option, speak, and while it says Transcribing click into another window.
   Expect the green "Ready to copy · ⌘V" pill, nothing typed anywhere, and ⌘V pasting by hand.
   Then repeat without switching and confirm a normal paste still happens.
2. **Cancel.** Same session: hold, then press Escape (or click the pill) mid-dictation.
   Nothing should paste; the pill should read "Cancelled - nothing pasted".
3. **Copy last result.** Tray menu, click it, press ⌘V somewhere.
4. **The mouse side button.** Build Better Options, launch it with
   `BETTEROPTIONS_GVOICE_SOCKET=<worktree>/.dev-userdata/control/gvoice.sock`, grant it
   Accessibility and Input Monitoring, then hold the side button and watch the dev app's log
   for `start` and `stop`. Also: one press must start exactly one recording, not two.
5. **Pass Through on the thumb wheel.** Set both wheel directions to Pass Through and flick it
   in a wide window; it must scroll sideways.
6. **The mouse still works at all.** One side-button press and one wheel flick. Step 13 changed
   how events find their binding and the automated checks cannot catch a wrong device name.
7. **A held control releases.** Quit the app mid-hold - cheapest of the four ways to test it.
8. **Remapping off survives a quit.** Turn it off, quit, relaunch, open the menu.
9. **Preferred microphone.** Pick the Anker in Settings, quit, relaunch, confirm it is still
   selected and is the device actually capturing. Then unplug it and plug it back.
10. **The save-failure alert.** Make the settings folder read-only, change a binding, expect
    one alert. Put it back afterwards.
11. **The idle numbers**, item above.

## Worst faults in this work, worst first

1. **The app could not start for most of the run.** Fixed now, but it means steps 5 to 16 were
   proven by tests only. Nothing between the session id and the microphone modes has been seen
   working in the real app even once.
2. **Clicking the pill now throws the dictation away.** It used to stop the hold and still type
   the words out. The plan asked for this and the words survive under "Copy last result", but a
   habit beats a label. Worth deciding whether it should commit-and-type instead.
3. **A slow app can turn a normal dictation into "Ready to copy".** The destination check now
   refuses to paste when the accessibility read fails, and macOS returns that same failure when
   an app is merely busy. Nothing lands in the wrong window; it is an annoyance, not a loss. Fix
   if it shows up: one retry, or a messaging timeout on the read.
4. **A microphone that is plugged in but silent fights the return rule.** Pick a virtual or
   meeting-app input and every other dictation can be lost, because the app keeps returning to
   the chosen device and recovery keeps walking away from it. The plan's wording asked for the
   return, so it was not second-guessed.
5. **Readiness on the companion refreshes every 2 seconds.** A press in a bad window is
   swallowed and nothing happens - no dictation, no browser-back.
6. **Every dictation now ends about 250 ms later**, because the clipboard restore is awaited
   instead of fired from a timer. It is inside the release-to-result number above, which still
   improved.
7. **A very deep data folder would break the socket** with an unhelpful error (unix socket paths
   cap near 104 characters). The real path is short, so nothing is wrong today.
8. **Wheel feel is saved once for the whole app**, not per mouse. Only one mouse model is
   recognised today, so it cannot bite yet.

## What was skipped on purpose

- **Step 18 (GATED).** Builds both apps, copies the current ones to `backups/installed-2026-09-10/`,
  quits the running apps and replaces them in `/Applications`. Needs Drago's word.
- Pushing. Merging the worktree back into `main`. Both named as gates in the plan.
