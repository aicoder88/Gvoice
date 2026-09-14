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

## Still open

1. **The night of 2026-09-14 has no proven cause.** No GVoice, Chrome or ChatGPT helper died between 00:20 and 01:45. There were no bubble errors in the log. The failed clips again held no speech: the holds were 0.03 to 1.2 s. The right Option key was last logged at 01:26:34 (it was never logged from 01:38 on, which matches the earlier prompt). The questions in `docs/prompts/find-why-dictation-key-goes-deaf.md` about the key and the short mouse holds stay unanswered.
2. The unified Mac log shows "Better Options" asking macOS for permission at each press and release. Its own info log is not kept, so the mouse app's side of a short hold can't be read after the fact.

## My own faults, worst first

1. Not verified with a real spoken press after the fix. Only the forced kill and the automated press were seen.
2. The sender of the stop signal is narrowed to "a command run by an AI assistant window at 00:19:09.43", not named.
3. Last night's failure is unexplained, so the "one cause" covers tonight only.
4. A page that dies every time it loads would now reload every 0.8 s forever, with no warning. This was already true for the recording page; it now applies to every page.
5. A press during the 0.8 s gap plus the reload shows no bubble.
6. The test waits a fixed 5 s. A very slow machine could fail it for the wrong reason.
7. The old installed app was removed from /Applications during the swap. A full copy is kept first at `~/.claude/archive-2026-08/GVoice-8ccd9b4-before-window-rebuild-2026-09-15.app`, logged in `ARCHIVE-LOG.md`.
