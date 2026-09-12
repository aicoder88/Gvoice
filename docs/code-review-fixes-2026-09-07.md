# Fixes for the 8 review findings — 2026-09-07

Pulled first (the shared copy was one commit ahead; documents only, no code).
Seven are fixed outright. The eighth (the delay before the microphone opens) is
halved rather than removed — the obvious fix broke every paste, see below.
Nothing has been saved to history or pushed.

Checks: 249 automatic checks pass (240 before, 9 new ones written for these
fixes). The real-app desktop check — a real dictation through the microphone
path, real speech recognition, a real paste into a separate app, and the
selection editor's capture/preview/apply/undo — passes.

## 1. HIGH — a failed paste no longer loses your words

`/Users/macpro/dev/voice/src/clipboard-lease.js`, `/Users/macpro/dev/voice/main.js:1300`

The clipboard is now held for the whole "did it land?" check and handed back
only once the answer is in: kept when the paste looks missed, given back on the
remainder of the normal 250ms window when it landed, given back immediately if
anything throws mid-check. The two timings live in one place
(`RESTORE_DELAY_MS`, `VERIFY_HOLD_MS`) instead of being spread across two files.
When the keep still loses (it now cannot, but the log should say so if it ever
does), the miss is written to the debug log instead of being discarded.

Verified: three new automatic checks prove a 400ms check still keeps the text, a
landed paste restores on the original schedule, and an over-long check restores
at once rather than at a negative delay. The desktop check's "paste must restore
the clipboard" assertion passes on the running app.

## 2. MEDIUM — the benchmark screen no longer freezes the app

`/Users/macpro/dev/voice/src/benchmark-evaluate.js`, `/Users/macpro/dev/voice/src/benchmark-corpus.js`

Each row is scored once and the answer reused, keyed by the row's own id and the
clip's revision. The cache belongs to the corpus store, so two stores in one
process can never read each other's scores, and a revised reference gets a new
key. Clip lookup inside the loop is now a map instead of a linear search of the
whole corpus per row.

## 3. MEDIUM — pressing the edit hotkey twice keeps your preview

`/Users/macpro/dev/voice/src/voice-edit-window.js:30`

Re-pressing while a preview is on screen, a request is in flight, or an apply or
undo is running now does nothing at all. Same when the edit window itself has
focus — that was the case that re-captured the window's own text box instead of
the user's selection. Applied and undone are deliberately NOT protected: those
are finished, and a fresh selection should still open.

Three new automatic checks cover all three cases. The desktop editing check
passes.

## 4. LOW — the pill no longer hangs after a failed voice edit

`/Users/macpro/dev/voice/main.js:1795`

The editing branch now hides the pill instead of leaving it on "Transcribing…"
for 25 seconds, and it is checked before the audio is written, so a failed
instruction no longer leaves a clip on disk with nothing in the history that
could play it. That matches what the success path already did.

## 5. LOW — a clip whose audio file vanished can be deleted again

`/Users/macpro/dev/voice/src/benchmark-corpus.js:76`

Deleting a clip no longer stops at a missing or unsafe audio file. The record
goes either way; only a file that resolved safely is deleted. An unknown clip id
still fails, as before. New automatic check.

## 6. LOW — voice editing now has the same backup model as dictation

`/Users/macpro/dev/voice/src/cleanup.js:63`, `/Users/macpro/dev/voice/src/voice-edit.js:63`

The editing request can now ask for the second vetted model, and it does so on a
retired model (404) or a full token bucket (429), exactly as dictation cleanup
already did. An explicitly configured model is still exact and never swapped.
Any other error still fails on the first try. New automatic check.

## 7. LOW — a dead edit shortcut now says so

`/Users/macpro/dev/voice/src/voice-edit-window.js:104`, `/Users/macpro/dev/voice/main.js:2461`

If another app already owns Cmd+Shift+E, the menu item reads "Edit selected
text… (Cmd+Shift+E is taken by another app)" and the failure is logged. The
menu item itself still works.

Verified only in the working direction: the tray menu screenshot from the
running app shows the normal item with its shortcut. Forcing another app to
steal the shortcut was not done.

## 8. LOW — one trip to the system instead of two before the microphone opens

`/Users/macpro/dev/voice/src/foreground.js:345`, `/Users/macpro/dev/voice/main.js:1078`

Halved, not removed. The obvious fix — open the microphone first and read the
focused app afterwards — was tried and it BROKE the paste: starting capture can
move the frontmost app, so the app recorded at press time was the wrong one and
every paste was then refused as "went to the wrong app". The desktop check
caught it, twice, and it passed again as soon as the reads went back in front.

So both reads were merged into a single trip instead: one traversal of the
system's accessibility tree returns the owning process and the app identity
together, where there used to be two, each able to block for 200ms. The comment
on the new function records why the order cannot be changed.

## What was NOT changed, and needs a decision

When you switch to another app mid-dictation, the app refuses to paste and the
text is filed under Recent dictations. It is deliberately NOT put on your
clipboard: you moved on, and quietly replacing whatever you copied in the
meantime would be worse than leaving it in the list. Say the word and it goes on
the clipboard too.

## Flaws in this work

- The desktop check is unreliable on this machine in BOTH directions. It fails
  about one run in five on the untouched code too (a Sep 5 profile failed the
  paste with none of these changes, and one baseline editing run today failed the
  same way as mine). Read as: the fixes pass repeatedly, not that the check is
  green every time. Runs today with the fixes in: the paste step passed 6 of 7,
  the editing step 5 of 7. The one paste failure did not reproduce on the
  untouched code today — its two runs both passed — so I cannot call that one
  proven environmental, only very likely: the code that records which app you are
  dictating into asks the system the same question, the same way, as the check
  the paste makes later.
- The first attempt at fix 3 also called up the window on the guarded path. That
  stole focus from the app being edited and hung the apply. Caught by the desktop
  check; the guard now does nothing at all.
- Finding 4 (pill after a failed edit), finding 6 (backup model) and finding 7's
  warning label were not reproduced on the running app. They are covered by
  automatic checks and by reading the code — call them fixed but not seen.
- The held clipboard has a 2-second backstop. If the app dies between the paste
  and the decision, your own clipboard comes back 2 seconds later instead of a
  quarter of a second. That is the price of not losing dictated text.
- Nothing was saved to history. The folder still holds a large amount of earlier
  unsaved work from other sessions, so saving it is your call, not mine.
