# Bug hunt: GVoice stops showing anything until a restart – 2026-09-15

## What Drago saw

- 2026-09-15 00:29 Croatia time: presses did nothing he could see. A restart at 00:31 fixed it.
- 2026-09-14 01:26 to 01:43 (the night before): the same complaint. A restart fixed it then too.

## What actually broke tonight (proven)

1. **00:19:09.49 Croatia time (22:19:09Z): something outside GVoice stopped the web helper processes of three apps at once.**
   - GVoice: all three web pages (the recording page, the bubble, the add-a-word pop-up), plus the network, audio and camera helpers.
   - Google Chrome: every tab process, plus its network and storage helpers. Every Chrome tab process alive now started after 00:19.
   - The ChatGPT app: every page, plus its network and storage helpers. All restarted at 00:19:09 to 00:19:21.
   - Only the graphics helper survived in each app.
   - GVoice's log names the signal: `render-process-gone {"reason":"killed","exitCode":15}`. Exit 15 is a plain "please stop" signal sent by another program. It is not a crash, and the Mac's memory manager sends a different one.
2. **GVoice brought back only the hidden recording page.** It had its own reload since commit 155d815 (2026-06-10). The bubble had none.
3. **Every press after that ran with a dead bubble.** Each attempt to show it failed with `Render frame was disposed`. The microphone and the speech engine still worked. The clip from the 00:29:26 press is 1.1 s long.
4. **The clips hold only room noise, no speech.** Loudness sits flat at 230 to 350 (normal speech peaks at 1 600 to 3 100). With no bubble on screen, Drago tapped to test instead of talking. So "not working" was really "shows nothing".

## Who sent the stop signal

Not named. Here is what can be proven:

- 00:19:09.241 to .252: a burst of about ten short `sh` and `bash` programs. That is the shape of Claude's safety checks running before a command.
- 00:19:09.434: a `zsh` started. That is the shape of the command itself.
- 00:19:09.493: the first helper died, 60 ms later.
- A `node` program also exited at 00:19:10.
- No tool, hook or skill on this Mac contains a command that stops browser helpers. Searched: `~/.claude/bin`, `~/.claude/hooks`, all skills, hub scripts, every repo's `scripts/`. The stray-preview cleaner (`~/.claude/hooks/close-stray-previews.mjs`) only stops listening dev servers, and its log has no entry after 2026-09-14 02:18Z.
- The only files that mention such a command are saved ChatGPT/Codex conversations under `~/.codex`. The rules forbid reading them, so they were not opened.

Most likely: a Claude or ChatGPT/Codex window ran a broad "stop these processes" command at 00:19:09. Chrome, the ChatGPT app and GVoice all run on the same browser engine, so one pattern hit all three.

## Prior fixes on "works until a restart"

| Date | Commit | What it changed | What it assumed |
|---|---|---|---|
| 2026-06-10 | 155d815 | Reload the hidden recording page when its process dies | Only that page matters; the bubble never dies |
| 2026-06-16 | 95b87ef | Self-heal a silent microphone without a press or restart | The microphone is the part that goes quiet |
| 2026-06-25 | b1adcb0 | Cap a hold at 90 s so a lost key release can't jam the app | The key release is the part that gets lost |
| 2026-07-30 | 4c375d8 | Warn when the dictation key never reaches the app | Deafness only happens at launch (it stops checking after the first event) |

## The one cause

**GVoice heals itself one part at a time.** Each past fix added a reload or a watchdog to the single part that had just failed. Any part nobody had written a handler for stays dead until a restart. Tonight that part was the bubble, along with the add-a-word pop-up and Settings.

This cause is proven for tonight. It does **not** explain the night before (2026-09-14 00:46 to 01:43). See "Still open".

## The fix (commit 5833fbe)

- One handler in `main.js`, inside `app.on("web-contents-created")`, now runs for every web page the app creates. When a page's process dies, it logs `render-process-gone {page}`. After 0.8 s it reloads the page and logs `window-rebuilt {page}`.
- The recording page's own handler was removed, so there is one rule, not two. It still reloads through `reloadDictationWindow()`.
- Any window added later is covered without anyone remembering to add a handler.

## Proof

- New test: `node scripts/electron/dead-window-rebuild.mjs`. It launches a separate copy of GVoice, sends the same stop signal to every page and checks each one answers. A press must then show the bubble in its "listening" state.
  - Before the fix: **FAIL**. The bubble, add-a-word and Settings stayed crashed; only the recording page came back.
  - After the fix: **PASS**. All four came back, and the press showed "listening" with no `Render frame was disposed`.
- `pnpm run test:unit`: 414 pass, 0 fail.
- Installed app: built from 5833fbe with the same signature as before, so permissions carry over. Installed at 00:49. The log says `startup-build revision 5833fbe`, and the mouse app reconnected.
- Tonight's kill repeated on the installed app at 22:49:49Z: the same signal to all three pages. The log shows three `render-process-gone ... killed, 15` lines and three `window-rebuilt` lines within 0.81 s. New processes were running 5 s later.
- **Not yet seen:** a real voice press on the installed app after that kill. It needs Drago's voice.

**What proves it came back:** `render-process-gone` in `~/Library/Application Support/GVoice/debug.log` with no `window-rebuilt` after it, or any `Render frame was disposed` line.

## Last night (2026-09-14 00:46 to 01:43): the pill never reached the screen

This is proven from the Mac's own record of when GVoice has a window on screen (`runningboardd ... com.purr.gvoice ... visiblity`):
- **Before:** every press was followed within about 70 ms by `visiblity is yes` (00:40:17.184, 00:42:10.574, 00:42:37.879, 00:43:11.039, 00:44:45.321).
- **The last one:** `00:46:29.931 visiblity is no`. The presses at 01:26:07, 01:26:24, 01:26:30, 01:26:33, 01:38:08 and 01:42:55 got no line at all.
- **After the restart:** `01:52:54.490 visiblity is yes`.
- **Nothing else stands out:** no GVoice, Chrome or ChatGPT helper died, no pill errors, and no screen lock, sleep or display change in the log.

On both nights the pill was missing, so Drago tapped instead of speaking. The two mechanisms differ:
- **Tonight:** the pill's process was killed.
- **Last night:** its window never came on screen. Why is **not provable** from the records.

## The first report's faults, and what happened to each (commit f57db61, installed)

1. **Not verified with a real spoken press.** FIXED:
   - 23:08:25Z: all three pages of the installed app were killed with SIGTERM, and three `window-rebuilt` lines followed within 0.81 s.
   - 23:10:43Z: a spoken press ran into a scratch TextEdit file. The Mac's own voice (`say`) played through the speaker, and the menu bar icon started the press.
   - The log shows `press {"trigger":"tray"}`, then `visiblity is yes` at 01:10:43.227, so the pill was on screen.
   - `transcript {"len":85}` read "Testing the dictation app after a crash, the quick brown fox jumps over the lazy dog."
   - It ended with `typed {"pasted":true,"verified":true}`. There was no `Render frame was disposed` and no `pill-not-shown`.
2. **The sender was not named.** FIXED FOR NEXT TIME; the 00:19 sender stays unnamed.
   - The new hub guard (commit 45f22edd) is installed in all three Claude accounts: `~/.claude/hooks/block-app-helper-kill.sh`.
   - It writes every kill command to `~/.claude/logs/kill-commands.log` with time and session.
   - It refuses a pattern kill that reaches Chrome, ChatGPT or GVoice processes.
   - It was tested live: a harmless pattern kill was blocked and logged.
3. **Last night unexplained.** PARTLY FIXED:
   - The hidden-pill finding is above.
   - Every press now checks 150 ms later that the pill is visible and alive, and builds a fresh pill window if not. The log line is `pill-not-shown {visible, crashed, rebuilt}`, at most one rebuild per 10 s.
   - Test step 5 swaps the pill's show call for one that does nothing. It fails with the check off and passes with it on.
4. **A window that keeps dying reloaded forever.** FIXED. After four deaths in a minute, GVoice stops reloading it and warns in the log (`window-gave-up`), the menu bar tooltip and a notification. It also adds a "Restart GVoice" menu item. Test step 4.
5. **A press during a reload showed nothing.** FIXED:
   - A pill reloaded mid-press shows that press again.
   - A press while the recorder reloads is refused with an error pill ("GVoice was restarting its recorder. Press again."), logged as `press-refused`.
   - Test steps 2 and 3.
6. **The test waited a fixed 5 s.** FIXED: it waits on conditions now.
7. **The old app was removed during the swap.** FIXED: this install moved the old app into the backup folder instead. Both backups pass `codesign --verify`:
   - `~/.claude/archive-2026-08/GVoice-8ccd9b4-before-window-rebuild-2026-09-15.app`
   - `~/.claude/archive-2026-08/GVoice-5833fbe-2026-09-15.app`

## Also found and fixed while reading

- **A cancelled mouse-button dictation deafened both triggers.**
  - Escape or a pill click reset only the mouse toggle. The shared hold tracker still counted the button as held, so every later right Option press and mouse click was swallowed with nothing logged.
  - Proof, today's code run directly: `held after cancel = 1, events = ["press:mouseBack"]`.
  - Fix: `hold.forget("mouseBack")` in `resetMouseBack`. `fireRelease` also resets the toggle when a press ends by tray, hold limit or companion. Unit test in `scripts/unit/hotkey-logic.test.js`.
  - This did NOT cause last night: no cancel was logged then.
- **The press log now names what started it:** `press {"trigger":"hotkey"|"companion"|"tray"|"voice-edit"}`.
- **Tests:** `pnpm run test:unit` 416 pass, `test:parity` 3 pass, `scripts/electron/dead-window-rebuild.mjs` 5 of 5 pass.

## Still open

1. **Why the pill window stayed hidden last night.**
   - The new check is proven against a pill whose show call does nothing, not against what really happened.
   - If macOS reports the window as visible while it is off screen, the check won't fire.
   - Sign of that: presses with no `visiblity is yes` and no `pill-not-shown`.
2. **Why right Option was never logged from 01:38 last night.** The stuck-trigger fault above would do exactly that, but it needs a cancel, and none was logged.
3. **Better Options keeps no button records.** Its log is info level, which the Mac discards. Not changed: `Sources/HIDDeviceMonitor.swift` in /Users/macmini/dev/better-options holds unsaved work from another window, dated 2026-09-12.
4. **Some kills escape the guard.** Kills from the ChatGPT/Codex app are neither logged nor refused.
5. **The spoken test used the Mac's voice**, started from the menu bar icon, not Drago's voice on the mouse button.
