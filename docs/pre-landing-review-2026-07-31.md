# Pre-landing review — the 9 unpushed commits on `main`

Date: 2026-07-31. Reviewed `git diff origin/main` — 9 commits, 17 files,
768 insertions / 78 deletions. Nothing pushed.

## Scope check: CLEAN (informational)

No plan file, no PR, no `TODOS.md`. Intent taken from commit messages.

**Intent:** five unrelated pieces of work — a new tray icon, two dictation
race fixes, the model-disk cleanup, the bigger whisper model list, plus
atomic writes for the settings and dictionary files.

**Delivered:** exactly that. Every file in the diff maps to one of those
five. No scope creep, no half-finished item.

The atomic-write changes (`src/settings.js`, `src/vocab.js`) and the
`realtime-voice-agent.js` worklet guard don't appear in any commit subject —
they rode along inside the other commits. Worth their own commits next time,
but they are real fixes, not drive-by edits.

## Findings

### 1. The API keys could have landed world-readable — FIXED

`src/settings.js:119`. The new atomic write creates `.env.tmp` with
`mode: 0o600` and renames it over `.env`. Node only applies `mode` when it
**creates** the file. A `.env.tmp` left behind by an earlier failed write (full
disk, crash, force quit) is reused with whatever permissions it already had,
and the rename carries those onto the file holding every API key. The code
comment claims to defend exactly this case and did not.

Proved it, not guessed it:

```
$ node -e "fs.writeFileSync('x','a',{mode:0o644}); fs.chmodSync('x',0o644);
           fs.writeFileSync('x','b',{mode:0o600}); ..."
mode after re-write with mode 0600: 644
```

**Fix applied:** explicit `chmodSync(tmp, 0o600)` between the write and the
rename. Re-tested with a deliberately-planted 0644 `.env.tmp`: the resulting
`.env` is `600`.

Severity: CRITICAL. Confidence 10/10 (reproduced).

### 2. Up to 1 GB of speech model could be stranded on disk — FIXED

`main.js:1917`. `engine:apply` cleared `benchDownloadedModel` (the pointer to
"the model the speed test just downloaded, which wasn't there before") on the
whisper-local branch **before** the two checks below it — the allow-list check
and the "is it actually on disk" check. Any apply that bailed out after that
point, or one that kept a hand-edited off-list model, left the download
untracked. Nothing would ever bin it, and there is no UI to remove it. With
`ggml-large-v3-q5_0.bin` now on the list, that is 1 GB.

**Fix applied:** the pointer is only cleared past every check, and only for the
model being applied. Anything else stays tracked and gets binned when the
Settings window closes, which is the existing behaviour.

Severity: CRITICAL (data/disk). Confidence 8/10.

### 2b. …and one slot could only ever track one model — FIXED

Found on a second pass, after finding 3 was built. `benchDownloadedModel` was a
single variable, overwritten by every new download (`main.js:1896`). That was
survivable while nothing invited testing more than one model. Finding 3's fix
turns the dropdown into a comparison table, so testing several **is** the
designed flow now:

- test Base, test Small, test Large → the pointer holds only Large
- apply Large → correctly kept
- close Settings → nothing left to bin
- Base and Small stranded: 239 MB, untracked, no UI to remove them

Add medium and large-turbo to the comparison and it is over 1.2 GB.

**Fix applied:** `benchDownloadedModels` is now a `Set`. Every download that
wasn't already on disk is added; the model that actually becomes the engine is
removed from it; everything still in the set is binned when Settings closes or
when a cloud engine is applied.

Severity: CRITICAL (data/disk). Confidence 9/10. Not unit-tested — it lives in
`main.js`, which imports Electron. Verify by hand: speed-test two models that
aren't downloaded yet, apply one, close Settings, and check only the applied
file is left in the models folder.

### 3. The engine panel applied a model the user could no longer see — FIXED

`public/settings.html`. After a speed test, `lastBenchModel` was preferred over
the dropdown, and it was never cleared when the dropdown changed. Test "Large",
decide it's too slow, pick "Base", click "Use on-device" — and Large gets
applied. Pre-existing, but this branch takes the list from 2 models to 5, which
turns "change your mind after the test" from unlikely into the normal flow.

**Fix applied** (this is what Mark asked for, beyond the minimal fix):

- Speed-test results are kept per model for the life of the window, so testing
  a second model no longer erases the first one's number.
- Each result is written into its own dropdown option:
  `Base — smallest and fastest (57 MB) — 0.8s here`. The dropdown becomes the
  comparison table.
- What gets applied is what the box is showing. Always.

**WER was asked for and is NOT delivered.** It cannot be, as the code stands:
`src/benchmark-run.js` times the transcription of four seconds of *generated
noise* (`makeSamplePcm`, a deterministic LCG). There is no speech in it and no
reference transcript, so there is no error rate to compute. Adding WER means
bundling a short real speech clip plus its known-correct text, scoring the
output against it, and deciding a normalisation rule (case, punctuation,
numbers). That is a feature, roughly 45 minutes of CC time, not a review fix.

Severity: INFORMATIONAL (user-visible behaviour). Confidence 9/10.

## Checked and clean — no action

Each of these looked like a bug and is not. Evidence, not vibes:

- **Late transcript pasting into the next dictation.** The server boot wait went
  10s to 60s and the dictation safety timer is 25s, so a slow cold boot really
  can outlive its press. The transcript handler already snapshots the press
  (`main.js:1513-1514`) and parks a late transcript in history instead of
  pasting it (`main.js:1602-1609`). Covered.
- **The three new model URLs.** Not trusted from memory — each was fetched.
  All five return 200 with sizes matching the numbers shown to the user:
  medium 514 MB, large-v3-turbo 547 MB, large-v3 1031 MB. Exact.
- **The shipped tray icons vs the generator.** Re-ran
  `node scripts/make-tray-icon.cjs`; both PNGs came back byte-identical to what
  is committed. No drift.
- **The tray icon actually appearing.** Launched the app and photographed the
  menu bar. The G with the soundwave bars is there and legible at 22pt.
- **The `workletLoaded` guard's premise** ("the AudioContext is created once and
  never closed"). Confirmed: `realtime-voice-agent.js:298` uses `||=` and
  nothing closes or nulls it. `public/dictation.js` closes its context and
  correctly resets its own flag (`:569-571`). Symmetric.
- **A deferred mic warning killing a later press.** The 20s grace window looked
  like a hole in the new press-stamping, but `startRecording` calls
  `clearPendingMicWarning()` (`public/dictation.js:869`). Covered.
- **The Settings dropdown being wiped on apply.** `engine:apply` returns the
  settings view, not the probe shape, and the dropdown is built in
  `initEnginePanel` — a different function from the `fill` those handlers call.
  No collision.
- **Stale-press stamping generally.** `generation` only advances in `tryStart`,
  so a background mic warning between presses matches the live generation and is
  still delivered. The `isStale` treatment of `0`/`null`/`undefined` is right and
  already unit-tested.

## Not flagged on purpose

- `waitForServer(baseUrl, 60000,() =>` — missing space after the comma.
  Formatting only.
- No free-disk-space check before a 1 GB download. Pre-existing, applies equally
  to the models that were already on the list.

## Verification

- `pnpm test:unit` — 157 pass, 0 fail (153 before; 4 new).
- `pnpm test:parity` — 3 pass, 3 skipped (skips need a local whisper model and
  an OpenAI key; unrelated to this diff).
- New file `scripts/unit/settings-panel.test.js` runs the **real** inline script
  out of `public/settings.html` against a stub DOM, so it cannot drift from the
  shipped code. Confirmed it is a genuine guard: reverting
  `chosenModelName` to the old "prefer the tested model" logic makes it fail.
- App launched, tray icon confirmed in the menu bar by screenshot. Note: the
  scripted click used to try to open the tray menu started a dictation on the
  throwaway profile before the instance was killed. Harmless — a separate user
  data folder, since deleted — but worth knowing a stray recording happened.

**Not verified on the running app:** the Settings window itself. It is reached
by clicking the menu-bar icon, and Mark's installed GVoice was running
alongside the dev launch, so scripted clicking could not tell the two icons
apart safely. The panel logic is covered by the four new tests against the real
script; the pixels are not. Per `CLAUDE.md`, treat the Settings UI change as
**not eyeball-verified** until someone opens the window and looks at the
dropdown.

## Specialists

The skill's parallel specialist fan-out was not dispatched — this session runs
under a standing instruction not to spawn subagents unless asked. The critical
checklist pass, the adversarial pass, and the outside-the-diff enum/consumer
tracing were all done in-thread instead.
