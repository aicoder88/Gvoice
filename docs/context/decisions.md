# Structural decisions

One entry per decision. Every entry says what was decided, why, and the
reverse-if line: the condition that should undo it and the one change that does.

## 2026-09-07 — When we cannot tell which app is in front, we do NOT paste

`src/paste-confidence.js` → `decidePasteOwnership`

A dictation is pasted only into the app that owned the field when the hotkey was
pressed. If the system's focus read comes back with nothing (asked twice), the
paste is refused rather than sent blind. The refusal is not reported as a
failure: the text goes on the clipboard and the pill says where it is.

Why: the mistakes are not the same size. A wrong refusal costs one ⌘V. A wrong
paste puts a dictation inside another application's window and cannot be undone.
Confirmed by the owner 2026-09-07, asked as a plain yes/no after the change was
built. Measured 2026-09-07 on this machine: the app that most often answers a
system-wide focused-element read with nothing is Chrome — so "couldn't tell" and
"a different app is in front" are usually the same situation. Built the opposite
way first (the code review recommended it) and it pasted a test sentence into a
live Chrome window.

Reverse if: users report dictations routinely not landing while they never left
the app — i.e. the unknown answer turns out to be common on healthy machines.
Watch the `ownership` field in the paste log. To reverse: `decidePasteOwnership`
returns `"same"` instead of `"unknown"` when `currentPid == null`.

## 2026-09-07 — A refused paste puts the text on the clipboard

`main.js` → `releaseClipboard`

When a paste is refused or typed by keyboard, nothing of ours has reached the
clipboard, so the dictation is written there and one ⌘V recovers it.

Why: without it the pill said "Click Copy" about a clipboard that never received
the text. The earlier fixes pass (2026-09-07, first pass) deliberately left this
out — "you moved on, and quietly replacing whatever you copied would be worse" —
and put it to the owner as an open question. He answered it directly on
2026-09-07, told the cost in plain words: keep it.

Cost: a dictation you walked away from replaces whatever you had copied.

Reverse if: the owner finds his clipboard being taken over. To reverse: drop the
no-hold branch at the end of `releaseClipboard` in `main.js`.
