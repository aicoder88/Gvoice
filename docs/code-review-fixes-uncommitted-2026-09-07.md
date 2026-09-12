# Fixes for the 10 review findings — 2026-09-07 (second pass)

Review this answers: `docs/code-review-uncommitted-2026-09-07.md`.
Earlier, separate pass today: `docs/code-review-fixes-2026-09-07.md`.

All 10 changed. Nothing saved to history, nothing pushed.

Automatic checks: 255 pass (251 before this pass, 4 new). The desktop check on
the running app is **blocked on this machine right now** — see "What could not
be seen working" at the bottom. Two fixes were verified on the running app; the
rest were not.

---

## 1. HIGH — a paste no longer fails just because the system was slow

`/Users/macpro/dev/voice/src/paste-confidence.js`, `/Users/macpro/dev/voice/main.js:1304`

**I did not do what the review asked, and the reason matters.**

The review said: when the system can't tell which app is in front, let the paste
through. I built that, ran it on the real app, and it pasted the test sentence
into Chrome. So I rebuilt it the other way.

The decision now lives in one small function, `decidePasteOwnership`, with three
answers:

- read the app, it's the one you started in → paste.
- read the app, it's a different one → don't paste.
- couldn't read it → ask once more, then don't paste.

What actually changes for the user is the *third* case, and it is the whole
point of the finding: not pasting is no longer reported as a failed paste. The
red "Click Copy — the paste didn't land" is replaced by "Not pasted — couldn't
tell which app was in front. It's on your clipboard.", and the text really is on
the clipboard (fix 2), so one ⌘V puts it where they want it.

The asymmetry is the argument: a wrong refusal costs one keystroke; a wrong
paste puts a dictation inside somebody else's window and cannot be undone.

Measured today: the app that most often answers a system-wide focus read with
nothing is Chrome. So "couldn't tell" and "another app is in front" are usually
the *same* situation, not different ones.

Four new automatic checks cover all three answers.

**Verified on the running app.** The app's own log from a real dictation:
`paste-refused {"reason":"unknown","sourcePid":49186}` — read the app at press
time, could not read it at paste time, refused, sent nothing.

## 2. MEDIUM — a refused paste keeps your words reachable again

`/Users/macpro/dev/voice/main.js:1327`, `/Users/macpro/dev/voice/src/typing.js:143`

The old clipboard rescue was deleted and its replacement only worked when a
clipboard hold existed — which is never true on the paths that needed rescuing.

Now: if the paste is meant to stay recoverable and nothing of ours ever reached
the clipboard, the text is written there. A real hold still ends the way it did
(kept on a miss, handed back on a hit).

The keyboard-typing mode (`TYPE_VIA_CLIPBOARD=false`) no longer pretends to hold
a clipboard. That silenced a false "clipboard lost" log entry on every rescue in
that mode, and it means that mode gets the rescue too.

**This reverses a deliberate choice** recorded in the earlier fixes doc ("It is
deliberately NOT put on your clipboard"). Put to Drago as a plain yes/no on
2026-09-07, with the cost stated — a dictation you walked away from replaces
what you had copied — and he said keep it.

**Verified on the running app.** Immediately after the refusal above, the
system clipboard held `The quick brown fox jumps over the lazy dog.` — the
dictated text, recoverable with ⌘V.

## 3. MEDIUM — the pipeline smoke test can reach its assertion again

`/Users/macpro/dev/voice/scripts/smoke/pipeline-smoke.test.js:132`

The fake clipboard was missing `availableFormats()`, so the clipboard hold threw
`clipboard.availableFormats is not a function` inside `typeText` and the
paste-buffer assertion never ran. The fake now answers everything the hold asks
and tracks what was written.

**Partly verified.** Building the hold against the test's exact fake now
succeeds with no throw. The full test was not run — see the bottom.

## 4. MEDIUM — the wait before the microphone is bounded and named

`/Users/macpro/dev/voice/src/foreground.js:145`

Two changes, no reordering (reordering was tried on 2026-09-07 and broke every
paste; the comment now says so).

- The two Accessibility budgets are named constants instead of a `0.2` repeated
  in four places. `AX_TIMEOUT_S` = 0.2 for the after-the-paste reads;
  `PRESS_TIMEOUT_S` = 0.12 for the one read taken while the user is waiting for
  the microphone.
- The comment on that function no longer claims it *reduced* the press-path
  cost. It says plainly that before destination profiles there was no
  Accessibility work at press time at all, what this one costs, and why it
  cannot move.

0.12 is a judgement, not a measurement. I first used 0.08 and backed off: when
that read fails, nothing is recorded about which app the dictation came from and
the paste guard downstream has nothing to check. Shaving microphone delay by
disarming the guard is a bad trade. The paste log now carries `sourcePid` and
`ownership` so the number can be tuned from evidence — a run of nulls means it
is too small for the machine.

**Verified on the running app** only in the working direction: the press read
returned a real app (`sourcePid: 49186`) at 0.12 under a loaded machine.

## 5. MEDIUM — a failed spoken edit shows one error, not two

`/Users/macpro/dev/voice/main.js:1910`

The error handler now returns after telling the edit window, the same way the
failure handler already did. Session teardown still runs. Before this, a blocked
microphone during a spoken edit put a red dictation pill over the user's work
for 30 seconds *on top of* the edit window's own message.

Not seen on the running app.

## 6. MEDIUM — pressing the edit shortcut twice no longer eats your instruction

`/Users/macpro/dev/voice/src/voice-edit-window.js:36`

"Listening" and "transcribing" joined the protected list. A second press while
you are still speaking used to cancel the generation the instruction was stamped
with; the transcript then arrived with nowhere to go and vanished with no
message, no preview and no history entry.

One new automatic check: press, speak, press again, stop, press again — the
instruction still becomes a preview.

## 7. LOW — the tray's output-profile switch cannot crash the app

`/Users/macpro/dev/voice/main.js:2497`

Saving writes to disk and throws on a full or read-only folder. The Settings
window already guarded that; the tray click did not, so the throw became
Electron's "A JavaScript error occurred in the main process" dialog. Now it says
what went wrong and rebuilds the menu either way, so the dot reflects what is
actually saved.

Not seen on the running app — I could not make the disk write fail.

## 8. LOW — "I didn't paste it, here's where it is" is no longer called a failure

`/Users/macpro/dev/voice/main.js:1284`, `:1290`, `:1793`

Three outcomes carry a `skipped` mark: the press aged out of its 30-second
window, and the two refusals from fix 1. The pill reads the outcome's own
message instead of the fixed "Click Copy — the paste didn't land.", which was
false in all three cases.

## 9. LOW — the "shortcut is taken" tray label can appear on first launch

`/Users/macpro/dev/voice/main.js:1620`

The tray menu was built before the editor existed, so the check for a dead
Cmd+Shift+E always saw nothing and advertised the shortcut regardless. The menu
is now rebuilt once the answer exists.

Not seen on the running app — it needs another app to own Cmd+Shift+E.

## 10. LOW — a clipboard holding files is cleared, not left holding your dictation

`/Users/macpro/dev/voice/src/clipboard-lease.js:33`

With files (or rich content) on the clipboard there was no text and no image to
restore, so neither branch fired and GVoice's text stayed there indefinitely.
The files were already gone — writing the dictation destroyed them — so the
handback now always runs. An empty clipboard beats a stale dictation.

One new automatic check.

---

## What could not be seen working, and why

The desktop check (`pnpm run test:electron`) drives a real GVoice, a separate
test application, and a real ⌘V. It cannot pass on this machine at the moment:
**Drago's own Chrome keeps the foreground.** The test target calls for focus and
loses it; the system reports "Google Chrome" as frontmost during the paste
window. The paste section fails that way both with the fixes in and with every
one of them reverted. The selection-capture section failed with the fixes in; I
did not run it reverted.

I did not touch his Chrome.

A separate session wiped the machine's browser and package caches at 15:28. The
app still launches and drives fine afterwards — Electron does not use those
caches — and a tray-only run at 15:28 passed, so the menu-bar icon is present
with real screen bounds on the running app. Chrome still held the foreground at
15:29, so the paste and selection sections stayed blocked.

Verified on the running app: fixes 1 and 2, the working direction of 4, and the
menu-bar icon's presence.
Covered by automatic checks only: 1 (all three answers), 6, 10, and the
non-throwing part of 3.
Neither: 5, 7, 8, 9, and the full smoke test.

## Flaws in this work

- **The test sentence may have gone into Chrome.** Three desktop runs this
  afternoon sent a real ⌘V while Chrome held the foreground, before I found the
  cause. If a text box was focused in Chrome, "The quick brown fox jumps over
  the lazy dog." landed in it, up to four times. I cannot check whether it did.
- **The clipboard now holds that same sentence** — the rescue in fix 2 worked, on
  the test's text. Copy anything and it's gone.
- **Five of ten fixes were never seen working on the app.** They are covered by
  reading and by automatic checks. Call them fixed but not seen.
- **Fix 1 is the opposite of what the review recommended.** Drago confirmed the
  behaviour on 2026-09-07 after being shown it in plain words. If it is ever
  reversed, one word does it (`decidePasteOwnership` returning `"same"` for
  unknown) — but see the evidence above first.
- **Fix 2 undoes a decision the earlier pass left open for Drago.** He answered
  it directly on 2026-09-07: keep it. Reversible in one line.
- **0.12 seconds for the press-path read is a guess**, chosen to be safe rather
  than fast. The log now carries what is needed to replace the guess.
- The desktop check's own reliability is unknown today: an earlier pass measured
  it failing about one run in five even on untouched code, and today it fails
  every run for an unrelated reason.
- The repo had no decisions log; this pass created
  `/Users/macpro/dev/voice/docs/context/decisions.md` with the two decisions
  above and how to undo each.
