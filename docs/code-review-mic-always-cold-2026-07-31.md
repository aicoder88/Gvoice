# Code review — "the mic only opens while you dictate" change

Reviewed 2026-07-31. Scope: the pending (uncommitted) changes on `main` — the
removal of `MIC_IDLE_MINUTES` / `MIC_ALWAYS_ON` and the switch to a permanently
cold microphone. Plus one packaging defect that would have shipped in the
rebuild.

Files in the diff: `.env.example`, `CLAUDE.md`, `SETUP.md`, `main.js`,
`public/dictation.js`, `public/settings.html`, `scripts/unit/settings.test.js`,
`src/settings.js`, and the new `scripts/unit/dictation-renderer.test.js`.

---

## Verdict

The change is sound. The setting is gone from every layer that mattered
(`src/settings.js`, the settings window, the `?micidle=` URL parameter, the docs,
the tests) with **no dangling runtime references** — verified by grep across
`main.js`, `src/`, `public/`, the preloads, `server.js`, and `realtime-relay.js`.
The new renderer test covers the one real leak the diff fixes.

Two things fixed in this pass, three flagged and deliberately not touched.

---

## Fixed

### 1. `models/vocab.txt` was missing from every packaged build — CONFIRMED, SHIPPING

`package.json` `build.files` is an explicit allow-list, and it had no `models/`
entry. `src/vocab.js:23` reads `join(__dirname, "..", "models", "vocab.txt")`,
and `seedSet()` wrapped that read in a bare `catch {}` — so in the built app the
seed word list came back **empty and nothing errored**.

Consequences in the shipped app (not in dev, which runs from source):

- `correctTranscript()` lost its "this word is already real English, don't
  rewrite it" guard, so custom-term correction could rewrite ordinary words.
- The "learn this word?" prompt stopped recognising seed words as already known,
  so it could offer to learn words the app already had.

**Fix:** added `"models/vocab.txt"` to `build.files` — named explicitly, not
`models/**/*`, which would drag the 190 MB `ggml-small-q5_1.bin` into every
build.

**Fix 2:** `src/vocab.js` `seedSet()` now logs the failure instead of swallowing
it. A silently-degraded correction engine is exactly the class of bug that made
it into a release once already.

**Verified:** `@electron/asar list` on the new bundle shows `/models/vocab.txt`.
(Note for the record: the earlier audit "confirmed" the absence with `find`
inside the `.app`. `find` cannot see inside `app.asar` — the conclusion was right,
the method was not.)

### 2. Two comments in `public/dictation.js` that would mislead the next reader

The diff added: *"The old idle-timer helpers remain for recovery branches, but
cold mode makes `armIdleTimer` a no-op."* That is wrong in a way that matters —
those "recovery branches" are themselves unreachable (see below), so the comment
implies live code where there is none.

Also `armIdleTimer(ms = 0)`: the default used to be `MIC_IDLE_MS`. Left at `0`,
anyone who ever flips `COLD_MIC` back to `false` gets a timer that drops the mic
**instantly** on the first arm instead of after an idle stretch. Changed the
default to `IDLE_RECHECK_MS`.

To be precise about what that is and isn't: `IDLE_RECHECK_MS` is 5 s, so a
revived warm mode using the bare default would still drop the mic after five
idle seconds — not after a sensible idle period. This is a *less absurd* default,
not a correct one. The comment now says exactly that: reviving warm mode means
passing a real interval, not trusting this default.

---

## Flagged, not changed

### A. `COLD_MIC = true` makes roughly 200 lines unreachable

`COLD_MIC` is now a hard-coded `true`. Consequences:

- `armIdleTimer` returns at its first line ⇒ `idleTimer`, `idleDropped`,
  `IDLE_RECHECK_MS` and `clearIdleTimer`'s timer branch are dead.
- `recoverMic` returns at its cold-mode early exit **every time** ⇒
  `ensureLiveCapture`, `probeLive`, `candidateDeviceIds`, `currentTrackMuted`,
  `captureBusy`, `recovering`, `recoveryMutedSeen`, `liveProbePeak`, `PROBE_MS`
  and `MAX_PROBE_ROUNDS` are all dead.
- Downstream in `main.js`, the escalation ladder (`handleRecoveryEscalation`,
  `recoveryReloadedAt`, `everHadLiveMic`, `lastAutoRelaunchAt`, the
  `dictation:escalate-recovery` and `dictation:mic-recovered` IPC handlers) is
  dead with it — `sendMicRecovered()` can now never fire.

`recoverMic`'s early return is **not** dead: it still sets `captureStale = true`,
which is what makes the first press after sleep/wake do a full rebuild. That part
is load-bearing. Everything past it is not.

**No user-facing bug** results from this — the mic-warning pill auto-hides after
30 s on its own, so a `sendMicRecovered()` that never arrives leaves nothing
stuck.

**Why not deleted here:** this is a ~200-line deletion in the most
regression-prone async file in the repo, and the deleted paths cannot be
exercised without first flipping `COLD_MIC`. Doing it in the same pass as a build
and install that has to be verified live is how a "fixed" bug gets re-reported.
It deserves its own change and its own verification. A `ponytail:` comment now
marks it as dead-but-preserved.

### B. What cold mode gives up (already documented, restated for the record)

With no warm graph there is no background liveness probe. The first press of a
session binds the bare system default input. If that default is a silent virtual
mic (VR, screen share, meeting app), the app can no longer auto-switch away from
it — the user gets the "No sound is reaching GVoice… pick your microphone"
warning instead of a silent self-heal. `public/dictation.js` already carries a
`ponytail:` comment saying so. This is the deliberate trade for the orange light
going out.

### C. `TAIL_MS` 450 → 1000 costs on four axes

The diff more than doubled the post-release drain. The old value carried a note
that 450 ms was measured ("250 still clipped the final word… 450 covers the
worklet's buffered burst plus ~200 ms of trailing speech"). No measurement is
recorded for 1000.

What the extra 550 ms buys: a longer safety margin for someone who releases
mid-word.

What it costs:

1. **+550 ms of latency** on every single transcript, before the engine even
   starts.
2. **+550 ms of trailing room noise** appended to every utterance. Whisper in
   particular is known to hallucinate filler ("Thank you.", "Bye.") on trailing
   silence — worth watching on the local engine.
3. **+550 ms of orange mic light** after every release — partly working against
   the point of the change.
4. **A wider silent-loss window.** `startRecording` cancels a drain in progress
   (`if (draining) { clearTimeout(drainTimer); draining = false; }`) and then
   wipes `recordedChunks`. A new press landing inside the drain therefore
   discards the previous utterance completely: no commit, no transcript, no
   failure pill, no saved recording. That window just went from 450 ms to a full
   second.

Point 4 is pre-existing behaviour (a new press deliberately supersedes the
previous utterance — see commit `1f1924f`), not something the diff introduced.
But the diff doubled the exposure. Left alone because committing the superseded
utterance properly means keeping the old socket alive alongside the new one,
which is a redesign, not a patch — and because discarding is arguably what the
user means when they re-press within a second.

**If clipped final words were not actually the complaint that drove this,
450 ms is the better number.**

---

## Checked and clean

- No `MIC_IDLE_MINUTES` / `MIC_ALWAYS_ON` / `micidle` / `micIdleMinutes` left in
  `main.js`, `src/`, `public/`, the preloads, `server.js`, or `realtime-relay.js`.
  Only historical mentions in `docs/` and `.claude/notes.md` remain, which is
  correct — they are a record.
- `README.md` says nothing about the mic light or the idle setting, so the diff
  introduced no fresh doc contradiction. (The pre-existing README right-Ctrl
  language-cycle claim is still wrong — audit item #27, out of scope here.)
- `src/settings.js` has no orphans: `asBool` and `clampDays` both still have
  callers; `MIC_IDLE_DEFAULT` and `clampIdleMinutes` went out cleanly with the
  function that used them.
- Every path in `startRecording` that opens the microphone now closes it:
  `initCapture` throw → `teardownCapture(true)`; socket handshake reject →
  `dropCapture` (the diff's actual fix); normal release → `finishUtterance` →
  `dropCapture`; dead-mic verdict → `handleMicLost` → `teardownCapture(true)`;
  socket-closed-at-commit → `dropCapture` already ran first. No leak found.
- The settings window's `collect()` no longer sends `micIdleMinutes` and
  `render()` no longer reads it. The inline `#8497a8` on the new informational
  row matches the file's existing pattern (the Shortcuts card does the same).
- `scripts/unit/dictation-renderer.test.js` is a good test and it fails loudly
  rather than silently if the `mic-health.js` import line it patches ever
  changes (the `vm` run would throw on the bare `import`).
- 152 unit tests pass before and after the fixes.

---

## Verified on the running app

Per the hard rule in `CLAUDE.md` — observed on the installed
`/Applications/GVoice.app`, not in dev, not from the diff.

| Check | Result |
|---|---|
| Build packs `models/vocab.txt` | `@electron/asar list` → `/models/vocab.txt` present |
| Installed bundle launches | process running from `/Applications/GVoice.app`, renderer logged `Dictation worker loaded` at 15:49:36Z |
| Menu-bar icon appears | screenshot of the menu bar shows the GVoice waveform icon |
| Full dictation round trip | tray click → `WS open (deepgram)` → `Capture bound to: Default - MacBook Air Microphone` → `Mic started` → tray click → `draining tail (1000ms)` → `Committing buffer` → `Sending commit` → transcript returned (empty, correctly — nothing was spoken) → blank-stream rescue ran |
| Mic closes after the dictation | `Mic released (cold-mic mode)` 1.0 s after release |
| Orange mic light goes out | screenshot of the menu bar after the dictation shows no microphone-in-use indicator |
| Dictation with real speech | spoken audio → `deepgram complete … words=9, conf=0.999` → `Final: Testing the vocabulary list. This is a real dictation.` → `typed {len:54, pasted:true, verified:true, target:"textedit"}` at 15:54:13Z |
| The word list actually loads from the installed bundle | zero `[vocab] seed file unreadable` lines in the log after that dictation — so `readFileSync` resolved `app.asar/models/vocab.txt` at runtime, which an asar listing alone would not prove |
| Microphone permission survived the bundle swap | confirmed — 512 000 bytes captured and a 0.999-confidence transcript; a lost grant produces the exact-zero-peak `Dead mic` verdict instead |

**Note:** two comments in `public/dictation.js` were reworded *after* the build,
so the installed bundle differs from source by comment text only. No functional
change followed the build.

**Not verified:** anything to do with warm mode or active mic recovery — that
code is unreachable (item A) and cannot be exercised without flipping
`COLD_MIC`.

---

## Install

- Old `/Applications/GVoice.app` (293 MB, installed 13:55 today) moved to
  `/Users/macpro/.Trash/GVoice-old-174910.app` — recoverable until the Trash is
  emptied.
- New build copied from `dist/mac-arm64/GVoice.app`, quarantine attribute
  stripped.
- The build is unsigned (`0 valid identities found`) and `mac.target` is `dir`.
  That is unchanged and expected.
