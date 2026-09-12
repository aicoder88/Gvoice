# Idle numbers and the live swap, 2026-09-11

Follows `daily-use-run-2026-09-10.md`. Drago approved both open decisions: run the idle
test, and replace both installed apps.

## The three idle numbers, now measured

Five minutes of the app sitting idle, launched isolated from the worktree.

| Target | Result | Verdict |
|---|---|---|
| Nothing uploaded | 0 bytes out. Only loopback sockets, all to its own speech engine on 127.0.0.1 | **MET** |
| Memory flat within 10 MB | 106 MB at launch, falling to 80 MB by 3 minutes, then exactly flat at 80 MB for the rest | **MET after it settles, not before** |
| One capture graph | 0 graphs built during idle - no churn, but also none ever made | **INCONCLUSIVE** |

Processor share: 0.2% to 0.5% throughout, apart from a 3% bump in the last minute that
lines up exactly with my own network-checking commands, not with the app.

Two honest caveats:

1. **The capture-graph check cannot pass as written.** The script counts graphs *built*
   during the idle window. No dictation was performed, so no graph was ever built, and zero
   is what you get whether the app is behaving perfectly or not holding a microphone at all.
   To actually test "always ready keeps one graph alive", a person must dictate once, then
   sit idle and confirm the count stays at one. That needs a hand on the key.
2. **The script's own network reading is broken.** `measure-idle.sh` writes the literal word
   `bytes_out` into every row instead of a number - its `nettop` parse takes the header line.
   I measured it separately and directly instead: `nettop` reports 0 bytes out for the app,
   and `lsof` shows its only sockets are loopback. The script should be fixed before anyone
   trusts that column.

## The live swap

Rollback copies made first, both verified on disk before anything was touched:
- `/Users/macmini/dev/voice/backups/installed-2026-09-10/GVoice.app` (292 MB)
- `/Users/macmini/dev/better-options/backups/installed-2026-09-10/BetterOptions.app` (844 KB)

**The build failed the first time.** `codesign --timestamp` could not reach Apple's timestamp
service - the tether was down. Nothing to do with the code. The connection came back, the
half-built output was cleared, and the rebuild exited 0, signed as `com.purr.gvoice`,
team `JZ4Z22F6BM`. Worth knowing: any future build of this app needs the internet up for
several minutes straight, and fails late if it drops.

Better Options' folder in `/Applications` is owned by root, so its replacement needed
elevated rights; ownership was put back to `root:admin` afterwards to match how it was.

Both apps quit cleanly, were replaced, and relaunched. macOS did not re-prompt for
Microphone or Accessibility.

### What was proven on the real installed apps, by machine

- Both running: GVoice pid 55916, Better Options pid 55918, both started 05:51 on 2026-09-11.
- Both signatures verify.
- The speech engine started on its own and warmed at boot, on the real model, port 55209.
- **The two apps are talking over the new socket.** GVoice's own log:
  `[control-socket] listening on …/GVoice/control/gvoice.sock` then
  `[control-socket] companion connected: BetterOptions`, 56 ms later. This is the heart of
  the whole pass - the mouse button no longer fakes a keypress - and it is now proven on the
  installed apps, not in a test.
- The connection survived well past the 6-second heartbeat cutoff with no reconnect.
- Socket folder mode `drwx------`, socket `srw-------`. Nobody else on the Mac can drive it.
- **The shared engine marker moved.** It now reads
  `{"pid":55991,"startTime":"Fri 11 Sep 05:51:15 2026","userData":"…/Application Support/GVoice","port":55209}`
  under the app's own data folder, and the old shared one in the temp folder is gone. The bug
  where a development copy could kill the real app's engine is closed, on the live install.
- No permission, error or failure lines in the log since launch.

### Still needs a hand at the Mac

Unchanged from yesterday's report, and none of it is claimed as passed. In rough order of
what would bite first:

1. Hold the mouse side button. One press must start exactly one recording; release must stop it.
2. Hold a key, speak, and switch windows mid-transcription. Expect the green
   "Ready to copy · ⌘V" pill and nothing typed into the new window.
3. Press Escape mid-dictation. Nothing should paste.
4. Tray menu, "Copy last result", then ⌘V.
5. Pick your microphone in Settings, quit, relaunch, confirm it stuck.
6. Set both thumb-wheel directions to Pass Through and flick it - it must scroll sideways.
7. Quit the app mid-hold; the microphone must let go.
8. Turn remapping off, quit, relaunch; the menu must still say off.
9. One dictation, then five idle minutes, confirming the capture-graph count stays at one.

### Rolling back

Quit both apps, then put the two backup copies above back into `/Applications`
(Better Options needs elevated rights). No data migration is involved either way.

## Merged into main, and the idle checks fixed (same day)

Drago said merge and fix. Both done, nothing pushed.

**Before the merge**, the unfinished cleanup work loose in the main folder was saved as its
own point (`8fb2d07`) so it could not be clobbered: the rewrite of `src/cleanup.js` and its
checks, a new Groq model default, a quality test and a transcriber comparison script. Also
added `backups/`, `.claude/worktrees/` and `.verification/` to the ignore list - the rollback
copies alone are 292 MB and nothing was stopping them being committed.

**The merge** (`36607c0`) brought in all 16 saved points, 43 files, about 4,700 new lines.
One conflict, in the ignore list, where both sides had added entries; kept both. Everything
else merged on its own. Packages had never been installed in the main folder, so they were;
**292 checks pass, 0 fail** on the merged result.

**The two idle checks** (`9b0828d`):

- *The network reading.* It recorded the literal word `bytes_out` in every row. `nettop`
  prints a header line whether or not a process sent anything, and the parse took the last
  line. It now keeps only rows naming one of the app's own processes, sums the whole process
  tree rather than the main process alone, and - the number that actually answers the
  question - counts sockets open to anywhere but this Mac. Proven against the live app: it
  reads 867,561 bytes of its own local chatter and 0 sockets leaving the machine.
- *The capture-graph count.* It read zero whether the app behaved or not, because a graph is
  only ever built by a dictation and the run never performed one. It now asks for one
  dictation at the start and reports **inconclusive** when it does not get one, instead of
  reporting a pass.
- Two faults found in that fix while testing it, both closed: the socket count printed zero
  twice (`grep -c` prints 0 *and* exits non-zero when nothing matches, so the fallback fired
  as well), and the byte total was labelled as bytes that left the Mac when `nettop` counts
  loopback too. It is now labelled for what it is.

The side branch `worktree-daily-use` is fully inside main and the side checkout at
`.claude/worktrees/daily-use` can be removed whenever someone wants the disk back.

Main is 19 saved points ahead of GitHub and 2 behind. Pushing needs Drago's word.
