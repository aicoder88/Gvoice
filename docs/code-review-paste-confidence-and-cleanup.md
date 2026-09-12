# Code review — uncommitted changes (2026-08-30)

Scope: the unsaved work on `main` in `/Users/macpro/dev/voice` —
`main.js`, `src/cleanup.js`, `src/foreground.js`, `src/paste-confidence.js` (new),
`scripts/unit/paste-confidence.test.js` (new), `scripts/unit/cleanup-error-report.test.js`,
`SETUP.md`.

**Status: all five fixed on 2026-08-30 (working tree, not committed).** 178 of 178 unit
checks pass (five new ones added below), plus the dictation parity run. The fixture-speech
smoke run skips on this machine — whisper-cli is not installed. The desktop-paste scenario
itself was NOT watched on the running app: GVoice allows one instance, the installed copy
is running, and quitting it was not authorised.

## Context checked, not a finding

The reason for swapping the cleanup models holds up. Probed the live service with the
shipped key: both old models answer "no such model" (404), both new models answer fine
(200). So the automatic switch-over triggers on the real signal, and the new defaults
are alive.

---

## 1. A paste that goes nowhere now says "Success" — and the words are lost

**File:** `/Users/macpro/dev/voice/main.js:1320` · **Severity: medium-high**

The check for "did the paste land on anything at all" was dropped from the success
calculation.

Failure scenario: user holds the hotkey with the Finder desktop (or any window with no
text box) in front, speaks, releases. The keystroke is sent, ⌘V does nothing, the
read-back finds no text field and returns nothing at all
(`{isTerminal:false, value:null, app:""}`). `assessPasteOutcome` then returns
`pasted:true, verified:null, likelyMissed:false` — `likelyMissed` requires a non-empty
field value, and there is none.

Consequences:

- 3-second green "Success" pill.
- `recordTranscript(text, true)` marks it as delivered.
- `maybeSuggestVocab` runs on text that never arrived.
- `typing.js:139` puts the user's previous clipboard back at 250 ms, while the 450 ms
  rescue re-write in `main.js:1697` never fires — so the dictation is not even on the
  clipboard afterwards.

The words survive only in the tray's Recent list, behind a pill that claimed success.
Before this change the same case produced a 30-second error pill plus a clipboard
rescue.

**Narrow fix that does not bring back the seven false failures:** when
`fieldFocused === false && !isTerminal && fieldValue === null`, set `likelyMissed = true`
and leave `pasted` true. The seven historical false failures all read back an *empty
string* (`readLen 0`), not `null`, so they still take the `verified === false` path and
are unaffected.

## 2. One momentary rate-limit pins the weaker backup model for the rest of the session

**File:** `/Users/macpro/dev/voice/src/cleanup.js:349` · **Severity: medium**

`workingDefaultModel.set(providerName, model)` caches the winner after *any* successful
failover, and `isModelFailoverError` treats 404 (permanent retirement) and 429
(transient rate limit, clears within the minute) as the same thing.

Failure scenario: five dictations in a minute; the sixth hits a 429 on the primary
`gpt-oss-120b`; the smaller `gpt-oss-20b` answers. From then on `resolveProvider` puts
the small model first for every later call, and it only flips back if the small model
itself 404s or 429s. A one-minute blip permanently downgrades tidy-up quality until the
app restarts.

The comment at `src/cleanup.js:30` justifies caching for *retirement*. Caching on a rate
limit is not the same thing.

**Fix:** only cache the winner when the failure that caused the failover was a 404.

## 3. Primary model's free-tier budget is smaller than three places still claim

**File:** `/Users/macpro/dev/voice/src/cleanup.js:35` · **Severity: low**

Measured live on the shipped key: `x-ratelimit-limit-tokens` is **8000** per minute for
both `gpt-oss-120b` and `gpt-oss-20b`. The deleted comment recorded **12000** for
`llama-3.3-70b-versatile`, which had been chosen for exactly that headroom.

Budgets appear to be per-model (the second probe's `remaining` did not decrement from
the first), so total headroom is fine. But the primary now hits the limit after roughly
3.6 dictations per minute instead of 5.4 — so the failover, and the sticky cache in
finding 2, engage much sooner.

Stale text left behind:

- `/Users/macpro/dev/voice/src/cleanup.js:206` — "the shipped Groq key allows ~12k tokens/minute"
- `/Users/macpro/dev/voice/scripts/unit/cleanup-error-report.test.js:125` — same claim
- `/Users/macpro/dev/voice/docs/ARCHITECTURE.md:62` — still names `llama-3.3-70b-versatile`
  as the Groq default. `SETUP.md` was updated; this one was not.

## 4. `fieldFocused` is a required input that nothing reads

**File:** `/Users/macpro/dev/voice/src/paste-confidence.js:44` · **Severity: low**

It is in the JSDoc input type and `main.js:1324` passes it, but no line of
`assessPasteOutcome` touches it.

- Two tests vary it and would pass with any value, so they assert less than their names
  claim: `scripts/unit/paste-confidence.test.js:15` ("a terminal target overrides a
  false pre-paste editor probe") and `:28` ("a readable field can prove the paste landed
  despite a false preflight").
- `main.js` still pays a system-wide accessibility traversal (`isEditableFieldFocused()`)
  on every paste to produce a value used only in log lines.

Either wire it in (see finding 1) or drop it from the signature.

## 5. Dangling comment for a list that moved

**File:** `/Users/macpro/dev/voice/src/foreground.js:265` · **Severity: low**

The comment block above the deleted `TERMINAL_BINARIES` still explains the terminal list
and the exact-match-not-substring rationale ("Hyperplanning" must not match "hyper").
The list now lives in `src/paste-confidence.js`, and that rationale did not travel with
it. A future edit to the new file has no record of why matching must be exact.

---

# What was changed (2026-08-30)

Working tree only — nothing committed, nothing pushed.

**1 + 4 together.** `src/paste-confidence.js` now reads `fieldFocused` instead of ignoring
it. A second "probably missed" shape was added beside the existing one: the pre-paste probe
positively reported no editable field AND the post-paste read-back found nothing readable,
and the target is not a terminal. That case keeps `pasted: true` (never an error pill) but
turns on `likelyMissed`, so the 6-second "Press ⌘V if the text didn't land" note shows and
the dictation stays on the clipboard past `typing.js`'s 250 ms restore. `fieldFocused` is
`null` on Windows and on macOS without Accessibility permission, and `null` never triggers
it. The stale comment in `main.js` describing the old single rule was rewritten.

An empirical check of the Finder-desktop case was attempted first
(`osascript` activate + a standalone probe of `isEditableFieldFocused()` /
`readbackPasteTarget()`), but the probing process is not Accessibility-trusted, so it
returned `fieldFocused: null` — inconclusive. The looser condition above was chosen
deliberately: its worst false positive is a clipboard swap plus a soft note on a paste that
did land, versus a silently lost dictation behind a green Success.

**2.** `src/cleanup.js` gained `isRetiredModelError()` (404 only) and a `reachedByRetirement`
flag. `workingDefaultModel.set()` now runs only when every failover that reached the winning
model was a 404. A 429 failover still works for that one call and is forgotten, so the next
dictation retries the primary. Comments at the provider table and at `isModelFailoverError`
updated to say so.

**3.** The 12k-tokens/minute claim was corrected to 8k per model (measured
2026-08-30 from `x-ratelimit-limit-tokens`) in `src/cleanup.js`,
`scripts/unit/cleanup-error-report.test.js`, and `docs/ARCHITECTURE.md`, whose Groq default
now names `openai/gpt-oss-120b` with its backup. The remaining `llama-3.3` mentions in
`.claude/notes.md`, `src/cleanup.js:279` and the older review docs are dated records of past
measurements and were left alone.

**5.** The terminal-list rationale comment moved from `src/foreground.js` to
`src/paste-confidence.js`, above the list it explains; the orphaned block in
`src/foreground.js` was removed.

## New checks

- `no target before or after the paste keeps the text recoverable` — the desktop case.
- `an unreadable field cannot cost the clipboard when AX couldn't tell` — `fieldFocused: null`.
- `a focused editor that just won't expose its text keeps the clipboard` — `fieldFocused: true`.
- `a terminal is never treated as a missing target`.
- `an empty field read-back is not a miss — it's an app hiding its composer` — the seven
  historical false failures.
- `a rate-limited fallback is NOT remembered — the next dictation retries the primary`.

The old test named "an unknown AX target cannot override a successful macOS paste shortcut"
was the deliberate contract change: same input, `likelyMissed` now `true`. It was renamed to
say what it asserts.

## Known cost of fix 1

An app that reports no editable field to Accessibility AND exposes no readable text, but
still accepts ⌘V, now shows a 6-second "Press ⌘V if the text didn't land" note and leaves
the dictation on the clipboard — replacing whatever was there — even though the paste
worked. That is the deliberate trade: a needless clipboard swap with a visible note, versus
losing a dictation behind a green Success. Apps with a normal text field are unaffected
(`fieldFocused` comes back true), and terminals are excluded by name.

## Not verified on the running app

`pnpm start` exits immediately while the installed `/Applications/GVoice.app` is running —
`main.js:18` takes a single-instance lock. Quitting the running copy was not authorised, so
the desktop-paste scenario was never watched live. Ten-second self-check: click the desktop
so no text box is focused, dictate, and expect the "Press ⌘V" note plus the words waiting on
the clipboard instead of a bare "Success".
