# Review fixes — 2026-07-31

Follow-up to `docs/code-review-2026-07-31.md`. Fixed the findings that held up
after checking them against the code; three did not hold and were dropped.

## Fixed

### 1. A late error from a finished press could kill the live one

**Files:** `main.js`, `preload.cjs`, `src/dictation-session.js`

`dictation:transcript` already snapshots the generation so a slow handler can't
stamp on a newer press (commit 1f1924f). The three sibling terminal events —
`dictation:error`, `dictation:mic-warning`, `dictation:failure` — called
`dictation.fail()` unconditionally. A terminal event arriving after
`release()`'s safety timer had cleared `busy` and the user had pressed again
would end the *new* dictation and paint an error over its "Listening…".

The root cause is that the events carried no way to tell which press they came
from. Fix:

- `main.js` `startDictation()` puts `gen: dictation.generation` in the
  `dictation:start` profile.
- `preload.cjs` records that number in `pressGen` on every `dictation:start` and
  passes it as a second argument on `sendError`, `sendMicWarning`, and
  `reportFailure`. Kept in the preload rather than `public/dictation.js` so no
  send site can forget it.
- `DictationSession.isStale(gen)` — new, one line — is true when the stamped
  press is no longer the current one. An unstamped event (non-numeric `gen`, e.g.
  a background mic warning raised outside any press) counts as current, so
  nothing is silently dropped.
- The three handlers still log, still save the clip, still fire the system mic
  notification. Only `fail()` and the pill are guarded.
- `dictation:failure` additionally skips `retranscribeRecording()` when stale —
  the rescued text would otherwise paste into the middle of the live dictation.
  The clip is still saved and logged, so the tray can replay it.

Test: `scripts/unit/dictation-session.test.js` — "isStale() tells an overtaken
press's terminal event from the live one".

### 2. Second "Start talking" broke the browser demo page

**File:** `public/realtime-voice-agent.js`

`audioWorklet.addModule()` re-runs the module script (and `registerProcessor`)
on every call; the second registration of the same name throws, leaving the mic
stream open. `public/dictation.js:483` has guarded this since it was hit there;
the guard was never ported. Added `this.workletLoaded`, same shape. The
`AudioContext` here is created once (`||=`) and never closed, so an instance
flag is enough.

### 3. Dictionary and API-key files could be wiped by a crash mid-write

**Files:** `src/vocab.js`, `src/settings.js`

`src/history.js` writes tmp + rename; `vocab.js` `save()` and `settings.js`
`writeEnvFile()` did not. A truncated file parses as invalid JSON (vocab) or a
truncated env, so a crash or full disk during a save silently resets the whole
dictionary — or costs every API key the user ever pasted in. Both now write
`path + ".tmp"` and `renameSync`.

## Dropped — the finding did not hold

- **`main.js:1028` "onPress sends to a possibly-destroyed webContents".** The
  guard is at the top of the same function (`main.js:1025`), and everything
  between is synchronous. No bug.
- **"`server.js` serves recordings to any origin".** The server binds
  `127.0.0.1` only (`server.js:91`), so it is unreachable from the LAN. A local
  browser page could still hit it on a guessed random port; that is low, not
  medium, and not what the finding described.
- **"Deepgram's 3s safety timeout fires while a leg is CONNECTING".** The timer
  is re-armed by any leg that opens afterwards (`src/providers/deepgram.js:217-227`),
  which is exactly the case the finding claims is unhandled. Would need a live
  repro to reopen.

Also downgraded: the worklet bug was filed as the one high-severity item, but
`public/realtime-voice-agent.js` is loaded by `public/index.html` — the relay's
browser demo page, not the shipped dictation window. Fixed anyway; it is three
lines.

## Verified on the running app

Rebuilt (`pnpm build`) and launched `dist/mac-arm64/GVoice.app`.

- Menu-bar icon present (found at 928,4 via the accessibility API) and its
  toggle starts/stops dictation.
- Six real dictations. The press log shows the stamp incrementing:
  `press {"profile":{...,"gen":1}}` … `gen:6`. Full round trip each time —
  mic bound, relay connected, commit, transcript. The last one returned a real
  25-character transcript.
- Forced the error path by turning Wi-Fi off for ~10s (restored immediately;
  provider is Deepgram, so the renderer's offline pre-flight fires):
  `dictation-error {"message":"Offline — …","gen":5,"live":5}` — the stamp round
  trips through the preload correctly and the live error is *not* dropped. The
  next press was accepted as `gen:6`, so `fail()` still re-opened the session.
- No stray `.tmp` files left in the app's support folder.
- `pnpm test:unit` 153/153. `pnpm test:parity` 3 pass, 3 skipped (no whisper
  model on disk, no `OPENAI_API_KEY`) — same as before the change.

**Not verified on a running page:** the worklet guard. Exercising it needs a
real browser with microphone permission on the relay's demo page; the guard is a
literal copy of the one proven in `public/dictation.js`, so it was not worth a
fake-media-device harness.

Nothing pushed.
