/bug-hunt

Runs on the Mac mini only: the app, its logs and `pmset` live there.

GVoice went deaf after a long run, and a restart cured it. Find the cause. Do not patch symptoms.

## What happened (2026-09-14, times are Croatia time, log is UTC)

- The installed app, /Applications/GVoice.app, was built 2026-09-12 from commit 8ccd9b4.
- It was started 2026-09-13 01:08 and ran for about 24.5 hours with no restart.
- Last good dictation: 00:46 (22:46 UTC). Then 40 minutes with nothing in the log.
- 01:26 to 01:43: Drago pressed the right Option key and the mouse back button many times.
  - **Right Option key:** from 01:38 on, not one press was logged. At 01:26:34 one Option release was still logged (`release {"source":"hotkey"}`).
  - **Mouse button (through the Better Options companion):** only some presses were logged. The worst ended 160 to 420 ms after they began (`release {"source":"companion:companion"}`), even though he held the button down. So the clips were empty and nothing was pasted.
  - At 01:38 Drago pressed 5 times. Only 2 presses were logged, both from the mouse.
- 01:43: GVoice was quit and reopened. `companion connected: BetterOptions` came 3 s after startup.
- 01:53: a 3.3 s mouse hold pasted 24 characters. Fixed by the restart, cause unknown.
- Mic was the Anker PowerConf C200 the whole time, `micMode: "always"`. Recordings of the failed presses held room noise, not silence, so the mic was probably fine.

## Evidence

- Log: `~/Library/Application Support/GVoice/debug.log`. The window that matters is 2026-09-13T22:46Z to 23:44Z, plus the 23:43:49Z restart for comparison. `debug.log.1` holds older runs.
- Failed clips: `~/Library/Application Support/GVoice/temp-recordings/`, files from 01:26 and 01:38 to 01:42.
- macOS log: `log show --start "2026-09-14 00:40" --end "2026-09-14 01:45"`. Look for Accessibility / TCC, event tap disabled (`kCGEventTapDisabledByTimeout`, `ByUserInput`), secure input, and USB or HID changes.
- `pmset -g log` for the same window. Note: Chrome briefly took the mic at 01:25:50.
- Code: `src/hotkey.js`, `src/hotkey-logic.js`, `src/control-socket.js`, and in `main.js` `fireRelease`, `mouse-back-gate` and the companion handler around line 1265.
- Better Options is a separate app. Find its source or logs before blaming either side.

## Questions to answer, with log or code proof for each

1. Why did the Option key stop reaching GVoice with no error logged? Suspect first: the macOS key listener got switched off by the system and never switched back on.
2. Why did mouse holds end in under half a second? Is it GVoice's socket, the companion's own timer, or a lost connection that sent a release?
3. Is there one root cause behind both? What wears out over about 24 hours: a listener, a timer, a socket or memory?
4. Why did GVoice say nothing? The "key isn't reaching the app" warning from commit 4c375d8 should have fired.

## Rules

- Reproduce the failure before fixing it. Shorten the time to failure if you can (sleep and wake, a secure password field, a forced listener timeout, killing and reconnecting the companion).
- The fix must switch the listener back on by itself, or warn out loud, in the menu bar and in the log.
- Follow this repo's CLAUDE.md: rebuild, install, reproduce the exact failure on the running app, and see it fixed. Not seen = "not verified".
- Commit locally only. No push.

## Already proven since (2026-09-15, do not redo)

From `docs/bug-hunt-dead-windows-2026-09-15.md`, the hunt run the next night:

- The 2026-09-15 00:29 failure was a different fault: at 00:19:09 something outside GVoice sent a plain stop signal (exit code 15) to the web helper processes of GVoice, Chrome and the ChatGPT app at once. GVoice brought back only the hidden recording page; the bubble stayed dead, so every press ran with nothing on screen. Fixed by reloading every window whose process dies (commits 5833fbe and f57db61). Do not re-prove this.
- Question 4 is answered: the 4c375d8 "key never reaches the app" warning stops checking after the first event, so it can only catch deafness at launch. Any fix must keep checking for the app's whole life.
- Questions 1 to 3 are still open. The 2026-09-14 Option-key silence is NOT explained by the 00:19 kill: that night the log shows presses missing at the hotkey listener (no `hotkey` events at all from 01:38), not a dead window. Start there.
