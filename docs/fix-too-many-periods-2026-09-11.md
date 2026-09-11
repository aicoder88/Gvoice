# Too many periods when you pause while dictating (2026-09-11)

## What Drago reported

"Sometimes I pause while dictating and the transcription adds entirely too many periods."

## What was actually happening

Two faults stacked on top of each other.

**1. The speech engine puts a period at every pause.** Deepgram closes a chunk
wherever the speaker breathes, punctuates that chunk on its own, and the relay
joins the chunks with a space (`src/providers/deepgram.js`, `transcriptText`).
One sentence spoken with a pause in the middle therefore arrives as two
"sentences". Real examples pulled from this machine's own dictation history
(`%APPDATA%/GVoice/history.json`):

- "Install AutovotKey and set up. The Mac Apple copy, paste, move shortcuts."
- "Also set up the other keyboard short cuts I have on my Mac. Like IPT. Paste. My email address fully."

**2. The tidy-up pass that would have fixed it never ran.** Two reasons:

- The routing gate in `main.js` skips cleanup on text that is short and already
  ends in a period. Chopped dictations look exactly like that, so they went
  straight to the clipboard unformatted.
- Worse: `.env` on this PC pins `CLEANUP_MODEL=llama-3.3-70b-versatile`, a model
  Groq retired. Every cleanup call returned HTTP 404, and by design an explicitly
  pinned model never fell back. Tidy-up has been completely dead on this machine.
  The latency line of the last dictation confirms it: `"cleanupMs": null`.

`src/cleanup.js` already carried a comment about this exact failure happening
once before ("when Groq retired the configured model, every call 404'd ... for
weeks"). It happened again.

## What changed

1. **`src/cleanup.js` — new `looksOverPunctuated(text)`.** Flags a transcript
   that looks chopped: an interior sentence ending on a dangling word ("and",
   "to", "up", "the"), a later sentence opening on a continuation word, or a
   bare one-word sentence mid-dictation. It only routes; it never edits text.
2. **`main.js` — routing gate.** A flagged transcript always goes through
   cleanup, whatever its length.
3. **`src/cleanup.js` — new prompt section.** Tells the model the periods in its
   input are the engine's, not the speaker's, and to merge parts that continue
   one sentence, lowercasing the joined word. Explicitly forbids splitting a
   sentence the speaker delivered in one breath, and forbids changing any word.
4. **`src/cleanup.js` — a retired pinned model now falls over.** A pinned model
   that 404s is a dead pointer, so the built-in models take over and the user is
   told once ("Your chosen tidy-up engine is gone - used the built-in one.").
   A pinned model that is merely *busy* (429) is still never swapped. The dead
   name is remembered and skipped for the rest of the session.
5. **`src/voice-edit.js`** honours the same rule via the new `pinnedModel` flag
   on the request.

## What was checked

- `pnpm test` — 259 unit tests plus the parity suite, all green.
- New unit tests: `scripts/unit/over-punctuation.test.js` (routing gate, using
  real dictations from history), plus two rewritten failover tests in
  `scripts/unit/cleanup-error-report.test.js` and one in `voice-edit.test.js`.
- New live cases in `scripts/cleanup-test.js` (`chopped-pause-merges`,
  `chopped-pause-fragments`, `real-sentence-boundary-survives`).
- End to end against the real Groq engine, with `.env` left exactly as it is
  (still pinning the dead model):

  - "Install AutoHotkey and set up. The Mac copy and paste shortcuts."
    -> "Install AutoHotkey and set up the Mac copy and paste shortcuts."
  - "Sometimes I pause while. Dictating and the transcription. Adds entirely too many periods."
    -> "Sometimes I pause while dictating and the transcription adds entirely too many periods."
  - "The order shipped this morning. Tracking goes out tonight."
    -> unchanged, still two sentences.

- NOT verified with a live voice press. That needs Drago to hold the key and
  speak. The running copy of GVoice on this PC is still the old code; the fix
  applies after the app is restarted.

## Flaws in this work

1. **Free-tier cap.** Cleanup now runs on more dictations, and the new prompt
   section adds roughly 12% to each call's tokens. The shipped free Groq key
   allows 8,000 tokens a minute per model. Dictating fast will hit the cap
   sooner, and a capped dictation pastes raw, periods and all (the pill says so).
2. **English only.** Both word lists are English. A Croatian dictation with the
   same chopping is not flagged.
3. **The model is the judge.** Merging is an LLM decision. Eight samples all
   came out right, including the two that must NOT be merged, but a wrong merge
   is possible.
4. **The pinned-model swap.** Someone who pinned a model deliberately now gets a
   different one when theirs is retired. The one-time notice is the only signal.
5. **Deepgram is untouched.** The periods are still generated at the source; the
   fix cleans up after them. Fixing it at the source needs word-level timings
   and a pause threshold, and a thinking pause is not reliably shorter than a
   sentence-end pause, which is why it was not attempted.
6. **The stale setting is still in `.env`.** The app now heals itself around it,
   at the cost of one dead request per app session. The line should still be
   removed; secrets files cannot be written by an agent.
