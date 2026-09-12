# Code review — 2026-09-05

Reviewed: everything changed but not yet saved to history on `main` (paste
confidence, destination profiles, voice editing, personal benchmark).
Automatic checks: 240 passed, 0 failed. Nothing was changed, nothing pushed.

Eight problems found, worst first.

## 1. HIGH — a failed paste now loses your words

`/Users/macpro/dev/voice/main.js:1382`

When the app pastes into another app it borrows the clipboard and gives it back
250 milliseconds later (`/Users/macpro/dev/voice/src/typing.js:133`, delay set in
`/Users/macpro/dev/voice/src/clipboard-lease.js:3`). The clock starts the instant
the paste key is sent. The new "did it land?" check then waits 150ms
(`/Users/macpro/dev/voice/main.js:1341`) and asks the other app what it holds —
a question allowed up to 200ms. That leaves 100ms of room for a call that may
take twice that. Whenever it does, the decision to *keep* your text arrives after
the clipboard has already been handed back. Confirmed by reading all three
numbers; not reproduced on the running app.

What you see: the app says "text may not have landed", you press paste, and you
get whatever was on the clipboard before. Your dictation is gone.

The old code waited 450ms, which left 200ms of margin. That margin was removed.
Two extra notes: `keep()` returns true/false to say whether it won the race, and
that answer is thrown away; and when the app decides it cannot paste at all, no
clipboard copy is ever made, so there is nothing to fall back to.

## 2. MEDIUM — the benchmark screen can freeze the whole app

`/Users/macpro/dev/voice/src/benchmark-evaluate.js:24`

Every time the benchmark data is read, each saved row is re-scored by comparing
two texts letter by letter (up to 2000 x 2000 comparisons per row), on the same
thread that runs the tray and the hotkey. Around 60 saved rows already stalls the
app for seconds. Import allows 500 rows at once, which is a 20-second freeze.
Nothing is cached.

## 3. MEDIUM — pressing the edit hotkey twice throws away your preview

`/Users/macpro/dev/voice/src/voice-edit-window.js:31`

Reopening is only blocked while an edit is being applied or undone. With a
preview on screen, pressing Cmd+Shift+E again tears the window down, drops the
hold on the text you had selected, discards the generated replacement, and then
grabs whatever is focused — which is the edit window's own text box. No warning.

## 4. LOW — the floating pill hangs after a failed voice edit

`/Users/macpro/dev/voice/main.js:1837`

On failure during a voice edit the handler returns early without hiding the pill
or showing a result, so it reads "Transcribing…" until a 25-second safety timer
hides it. The instruction audio has also already been written to disk with no
matching record, leaving a stray clip; the success path discards that audio.

## 5. LOW — a clip whose audio file is missing can never be deleted

`/Users/macpro/dev/voice/src/benchmark-corpus.js:74`

`remove(id)` looks up the audio file first and throws if it is gone. If the file
was deleted by hand or a copy failed, the clip and its scores are stuck in the
list forever.

## 6. LOW — voice editing has no backup model

`/Users/macpro/dev/voice/src/cleanup.js:63`

Ordinary dictation cleanup walks the whole model list and retries when a model is
retired. The voice-edit request pins the first model only. When that model is
retired, dictation keeps working and every "Edit selected text" fails with an
HTTP 404.

## 7. LOW — the edit hotkey can fail silently

`/Users/macpro/dev/voice/src/voice-edit-window.js:98`

Registering Cmd+Shift+E returns false if another app already owns it. The result
is exposed but never read, so the shortcut does nothing while the README and the
tray menu both advertise it. The tray item still works, which hides the failure.

## 8. LOW — up to 400ms extra before the mic opens

`/Users/macpro/dev/voice/main.js:1077`

Starting dictation now makes two extra requests to the focused app (which app,
which field) before the mic is told to start. Each is capped at 200ms. A busy or
hung foreground app adds up to 400ms on the key press — the exact case the
pre-roll buffer was added to protect.

## Flaws in this review

- Nothing was reproduced on the running app. These come from reading the code.
  Item 1 in particular deserves a real test with a slow target such as a large
  Chrome document.
- The 240 automatic checks passed, but they do not cover the paste race in
  item 1 or the freeze in item 2.
