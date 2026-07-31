# Code review — recent dictation, cleanup and pill changes

Reviewed the last five commits on `main` (rescue-paste, cleanup limit notice, dictionary
move, pill position + mic warm-up, parity test). Seven findings, worst first.

**Status: all seven fixed. Nothing pushed.** What changed, and how far each fix was
verified, is in "Fixes applied" at the bottom.

---

## 1. HIGH — `main.js:1468` — rescue path can jam the next dictation

The rescue path calls `dictation.done()` **before** the batch retry runs, so `busy` is
already false. When the retry recovers text, control falls through to the normal path
(`main.js:1494`) and can spend ~5 s inside `processTranscript` (2.5 s cleanup timeout ×
1 retry, plus the paste) with the session still effectively open. The `!pillFree()` guard
at `main.js:1488` is only checked once, before all of that.

If the user presses the hotkey during that window:

- `main.js:1522` sets `savedForegroundHwnd = null`, wiping the **new** dictation's captured
  window — its paste never restores focus.
- `showPillResult` at `main.js:1537` paints "Success" over the live "Listening…".
- `finally { dictation.done() }` at `main.js:1575` clears the **new** session's `busy`
  mid-hold. `fireRelease` (`main.js:992`) does `if (!dictation.release()) return`, so the
  user's key release is swallowed: no `dictation:stop` to the renderer, no "Transcribing…",
  and the stream keeps running.

**Fix direction:** hold the session (or a dedicated rescue lock) across the whole retry +
paste, and re-check `pillFree()` immediately before touching `savedForegroundHwnd` and the
pill. Do not release before the work is finished.

---

## 2. MEDIUM — `src/cleanup.js:326` — first 429 burns the once-per-run outage notice

`showCleanupWarning` (`main.js:1947`) latches on `cleanupWarned`, which is never reset.
Free Groq tier 429s after roughly five dictations a minute, so that one notification slot
is consumed within minutes of launch. Later, if the model is retired and every call 404s,
the user gets no system notification at all — only a 6 s pill. That is exactly the failure
the removed streak gate existed to prevent, and the rationale comment at
`src/cleanup.js:190-193` still describes protection the diff deleted.

**Fix direction:** key the latch by failure kind (rate-limit vs hard error), or reset it
when the error class changes.

---

## 3. MEDIUM — `.env.example:42` — mic-idle default change never reaches new installs

`MIC_IDLE_DEFAULT` went 5 → 30, but `.env.example` still ships `MIC_IDLE_MINUTES=5`, and
`README.md:11` tells people to `cp .env.example .env`. An explicit value beats the default,
so the "cold mic eats the first second" fix silently does not apply to anyone who follows
the install docs. `SETUP.md:122` also still documents the default as `5`.

**Fix direction:** update `.env.example` and `SETUP.md` to 30.

---

## 4. LOW — `public/pill.html:22` — three-line result pill gets clipped

`padding-bottom: 8px` with `box-sizing: border-box` on a 72 px result window leaves a 64 px
content box. Three lines at 13 px × 1.25 plus 18 px vertical padding is ~67 px. With
`align-items: flex-end` the overflow goes off the **top**, and `body { overflow: hidden }`
cuts it. `main.js:487` documents that the longest reason (pick-your-microphone) needs
exactly three lines, so this case is reachable.

---

## 5. LOW — `main.js:1544` — cleanup failure shows raw jargon on the success pill

`result.notice` replaces the "Success" label. For a non-429 failure that string is:

`The groq cleanup engine returned 404 for llama-3.3-70b-versatile. Text is being typed unformatted.`

Only the 429 message was written for a human to read.

---

## 6. LOW — `main.js:1494` — rescued clip that cleans to nothing is lost

With `deliver: false`, `retranscribeRecording` no longer calls `recordTranscript`. If
`processTranscript` then returns null (noise-only after cleanup), the normal path only calls
`hidePill()` — no history entry, no tray entry, nothing playable. The old `deliver: true`
route recorded the recovered text before returning.

---

## 7. LOW — `main.js:1558` — "likely missed" case hijacks clipboard behind a bare 3 s "Success"

Dropping `uncertain` took this pill from 8 s to 3 s, and `reason` is empty because `pasted`
is true. So the label just reads "Success", clears in three seconds, and 450 ms in the code
silently overwrites whatever the user had copied — with nothing on screen explaining where
their ⌘V went.

---

## Checked and rejected

Stale `lastCleanupError` leaking onto a later clean dictation's pill. Not reachable —
`main.js:1146-1152` is the only caller of `polishTranscript`, and it drains
`takeCleanupError()` unconditionally on every cleanup attempt.

## Tests

`node --test scripts/unit/cleanup-error-report.test.js scripts/unit/settings.test.js`
→ 27/27 pass.

## Note

Findings are from static reading of the diff, not from reproducing on the running app.
Per this repo's hard rule, any fix for these must be observed working on the running app
before it counts as done.

---

# Fixes applied

## 1 — the jam. Fixed at the root, not on the rescue path

The review framed this as a rescue-path bug. It is not: `release()` arms a 500 ms safety
timer that clears `busy`, and `finalize()` only cancels that timer if the transcript
arrives inside those 500 ms. Any dictation whose cleanup + paste runs longer than that —
which is most of them — leaves `main.js:1522/1533/1575` unguarded in exactly the same way.
Patching only the rescue path would have left the ordinary path broken.

So the guard went where both paths route through. `DictationSession` now carries a
`generation` counter, bumped once per **accepted** press (a refused press must not bump it,
or an in-flight handler would skip `done()` and leave `busy` stuck true forever — a
permanently deaf app). The transcript handler snapshots it on entry and, before touching
anything shared:

- pastes into the window **this** press captured, and clears the global only if this press
  still owns the session. Comparing the captured window's *value* instead looked safer and
  was worse: two dictations into the same app back to back capture the same window, so the
  values match, the new press's target gets wiped, and its paste lands with nothing to
  restore focus to — the exact symptom being fixed, in the commonest case there is;
- skips the pill (success, error, and the typing-failed catch) when a newer press owns it,
  parking the text in history instead;
- skips `dictation.done()` on a stale transcript, so the newer session's `busy` survives and
  `fireRelease` still sends `dictation:stop`.

The two `pillFree()` checks inside the rescue block became `stillMine()` for the same
reason: `pillFree()` reads `!busy`, and the new press's own safety timer can clear that
while its dictation is very much alive. The `dictation:failure` handler next door had the
identical shape — `fail()` up front, then seconds of saving and retrying, then a bare
`pillFree()` — and got the same snapshot-and-check.

Left alone on purpose: the `pillFree()` calls inside `retranscribeRecording`. That is a
different boundary — it is also reachable from the tray's "Transcribe again", where there is
no press to belong to.

Not fixed, deliberately: a rescued clip can still paste into the window the user has since
moved to. It needs the paste itself to be abortable mid-`processTranscript`. Annoying, not a
wedge, and pre-existing on the normal path too.

## 2 — outage notice

`cleanupWarned` (one boolean, one notification per run, ever) became a `Set` keyed by
message, so each *kind* of failure announces itself once and a repeat can't spam.

And the routine free-tier 429 no longer raises a system notification at all — the pill
already says it, on the exact dictation it hit, and the cap clears itself within the minute.
Notifications are now reserved for failures that stay broken until someone acts. That is
what stops the everyday hiccup from eating the alert that matters.

## 3 — mic-idle default

`.env.example` value **and** its comment block, plus `SETUP.md`, now say 30. Also
`public/dictation.js:23`, which carried its own hardcoded `5` fallback for a missing or junk
`?micidle=` — a second source of truth for the same number, now matched to
`MIC_IDLE_DEFAULT` with a comment saying so.

## 4 — clipped pill — measured

`PILL_SIZES.success/error` 72 → 84. Measured in a real browser at both sizes with the three
longest reason strings in the codebase:

| window | lines | pill top | clipped |
|---|---|---|---|
| 72 (old) | 3 | **-3px** | yes |
| 84 (new) | 3 | +9px | no |

At 84 the pill is 67 px tall, sits 9 px from the top, and leaves the intended 8 px below —
nothing truncated, action buttons intact. Screenshot confirmed by eye.

## 5 — jargon on the pill

`The groq cleanup engine returned 404 for llama-3.3-70b-versatile…` became **"Tidy-up isn't
working — text typed exactly as you said it."** The status code, provider and model stay in
the `console.error` beside it, where they were already logged.

The network-streak message had the same problem (`Cleanup couldn't reach groq…`) and got the
same treatment: **"Can't reach the tidy-up service — text typed exactly as you said it."**
Both tests updated, plus an assertion that the string contains no status code, model name or
vendor name.

## 6 — rescued clip that cleans to nothing

The noise-only branch now records the clip when it came from a rescue. A plain noise-only
dictation still hides quietly — that part was deliberate.

## 7 — silent clipboard takeover

`likelyMissed` now gets its own pill line, **"Press ⌘V if the text didn't land — it's on
your clipboard."**, and the 6 s hold. It beats the cleanup notice when both are true: having
your clipboard silently swapped is the bigger surprise, and the ternary would otherwise have
dropped one of the two without anyone choosing which.

## Verified

- 153/153 unit tests pass; parity suite passes (4 pass, 2 skipped as before). Two new
  `DictationSession` tests cover the counter, including the refused-press case that would
  have caused a worse bug than the one being fixed.
- Pill geometry measured and screenshotted in a browser, old size vs new (table above).
- The dev build launches clean: relay up, mic bound and live, hotkeys registered, no errors.

**Not verified:** an end-to-end dictation on the running app, and the race in finding 1
reproduced by hand. Both need someone at the keyboard holding the hotkey — the second needs
a second press timed inside another dictation's cleanup window. The guard is covered by unit
tests, not by observation.
