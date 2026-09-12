# Merge, review, fix and install – 12 September 2026

One session. Two machines' versions of GVoice joined into one, reviewed, fixed,
built and put in the menu bar.

## What was split

Two machines had each solved a different half of the same problem in the
tidy-up pass, and neither version could be taken without deleting the other.

| Half | Where it came from | What it does |
| --- | --- | --- |
| Backup model | the other machine | A dead or rate-limited engine falls through to a second model with its own allowance, instead of the dictation going in raw |
| Word guard | this Mac | Whatever the engine sends back is thrown away and your own words used, if it added, replaced, translated or reordered anything |

Both now run together. A separate heal, nearly lost in the merge, also
survived: a model name left in Settings by an older build no longer pins a dead
engine – it is dropped and the working chain runs.

Eleven clashes settled by hand: six in the tidy-up file, two in the main file,
three in the documents. No half was thrown away.

## Fixed on the way in

- The end-to-end check hung forever after passing, because the speech engine it
  started was never shut down. 90 seconds down to 2.
- The repository address still pointed at its old name and worked only through
  a redirect. Now points at `aicoder88/Gvoice`.

## What the review found, worst first

1. **Terminals could not be dictated into.** The new destination guard refused
   to paste into any app where Accessibility never saw a text field. That is
   every terminal and every custom Electron editor – the exact apps the rest of
   the code says out loud do accept a paste. Each dictation ended on the
   clipboard with "Ready to copy" instead of landing. The guard now asks
   whether the destination *changed*, not whether Accessibility approves of it.
   Four tests cover it.
2. **A call could kill the microphone until restart.** Switching to the chosen
   mic tore down the working one first, and had no way back if the new one
   would not open. A mic held by Zoom or Teams throws a different error than a
   missing one, so nothing caught it. It now falls back to the system default.
3. **Companion and mouse button could both fire.** A companion connecting during
   startup never turned the raw mouse button off: the hotkey engine did not
   exist yet, so the call silently did nothing. Both then drove the same
   dictation – the double-trigger stuck mic the socket was built to end.
   Startup now asks the socket directly. Confirmed real: Better Options
   connects at startup on this machine, every launch.
4. **A false "nothing pasted".** Escape during the paste itself painted
   "Cancelled – nothing pasted" over a paste that was landing in the document,
   then painted Success over the lie. The right to cancel now ends where the
   paste becomes unstoppable.
5. **A stray Croatian word** sat mid-sentence in the English tidy-up
   instruction with nothing to explain it, so the engine had to guess on every
   call. It now names both languages.

## Checked on the running app

- 324 unit checks, 3 parity checks and the end-to-end check all pass.
- Built, signed, and installed to `/Applications/GVoice.app`. The old build is
  kept beside it as `GVoice.app.prev` in case anything needs winding back.
- The menu-bar icon is on screen.
- A real dictation ran the whole chain on the installed app: microphone opened
  on the Anker PowerConf C200, audio captured, speech engine transcribed, the
  noise filter dropped it, nothing pasted.

## NOT checked

- **The terminal paste fix has not been watched happening.** It needs someone
  to speak into a terminal. Four unit tests cover the rule; the live paste is
  unproven.
- **Microphone choice surviving a restart is unproven.** No microphone has ever
  been picked by hand on this machine (there is no preferences file), so the
  code that switches to a chosen mic never runs here. Pick the Anker in
  Settings, restart, and confirm it is still chosen and still the one
  recording.

## The second join, same evening

The other machine pushed a week of work mid-session: voice editing, per-app
output profiles, a personal accuracy benchmark and a clipboard lease. It had
rewritten the same paste code this Mac had. Drago chose to plan the join
first, then ran the plan. Full step-by-step results:
`docs/plans/join-the-two-gvoice-versions-into-one.md`.

**Joined, nothing dropped.** A press has one name that carries its number, so
cancel and voice editing share one identity. One paste engine keeps both
destination checks and restores copied formatting. Every dictation now has
one recorded outcome instead of four separate flags.

**Found in the join itself and fixed:**
- A microphone that hung while opening made every later press time out.
- Recent dictations would have shown a false warning on every cancelled or
  copied dictation.
- The reading of which app is in front now happens before the mic opens, as
  the other machine proved it must.

**Seen on the installed app:** 413 checks plus the other machine's end-to-end
run (real speech pasted and read back, voice editing working). Menu-bar icon
present. A dictation landed in a Terminal window.

**Not seen:** a chosen microphone surviving a restart. A paste into cmux,
which hides its text field; proved only in tests.

**Behaviour change:** a paste that cannot be confirmed (every terminal) now
leaves the words on your clipboard in place of what you had copied.

**Incident:** scripted clicks on the menu-bar icon started two dictations,
because that click is push to talk. The second was aimed at the live cmux.
GVoice was force-stopped with nothing pasted. An Escape key may have reached
cmux just before.
