# Speech-model disk cleanup and the orphaned-download fix — 2026-07-31

## What was on disk

| Item | Size | Action |
|---|---|---|
| `/Users/macpro/Library/Application Support/Google/Chrome/OptGuideOnDeviceModel/2025.8.8.1141` | 4.0 GB | deleted (approved) |
| `/Users/macpro/Library/Application Support/MacWhisper` | 481 MB | deleted (approved) — app no longer installed |
| `/Users/macpro/Library/Application Support/GVoice/models/ggml-medium-q5_0.bin` | 514 MB | deleted (approved) |
| `/Users/macpro/Library/Application Support/GVoice/temp-recordings` | 29 MB | deleted (approved) |
| `/Users/macpro/dev/voice/models/ggml-small-q5_1.bin` | 181 MB | deleted (approved) — untracked, not in git |

Total freed: ~5.2 GB. `GVoice`'s app-support folder went 552 MB → 9 MB.

Also removed the now-dangling `WHISPER_MODEL=` line from
`/Users/macpro/Library/Application Support/GVoice/.env` (backup kept at `.env.bak`).
Active provider is `deepgram` in both that file and the repo `.env`, so nothing
in the running app reads a local model.

## Was anything downloading models on its own?

No. `ensureModel` (`src/model-download.js:136`) has exactly one caller,
`main.js:1850`, inside the `engine:benchmark` IPC handler, which is reached only
from the "test speed on this computer" button (`public/settings.html:472`). The
514 MB medium model came from a manual click with Medium selected in the
dropdown.

Boot paths that could have wanted a model are both gated on the local provider,
so deleting the models is safe while on Deepgram:

- `main.js:2399` — onboarding nag only when `provider === whisper-local|local`.
- `main.js:2509` — whisper-server boot warm, same gate.
- `src/bootstrap-env.js:87` — leaves `WHISPER_MODEL` unset when no model file exists.

## The real leak, now fixed

`engine:benchmark` downloads the model *before* the timed test. If the user then
clicked "Keep cloud", the file stayed forever with no UI to remove it.

Closing the Settings window without answering at all stranded it the same way.

`main.js`:
- New module-scope `benchDownloadedModel` marker, set in the benchmark handler
  only when the model file did **not** already exist.
- `dropUnusedBenchModel()` unlinks that one path, and is a no-op while a test is
  still running so an in-flight download is never yanked out from under it.
- Called from `engine:apply` when the applied provider is not `whisper-local`,
  and from the Settings window's `closed` handler.
- Applying the on-device engine just clears the marker — the file is the engine
  now, so it stays.

Deliberately **not** a "sweep unused models from MODELS_DIR" implementation:
`src/bootstrap-env.js:38` makes `MODELS_DIR` the repo's own `models/` folder in a
dev launch, so a sweep would delete checked-in assets during `pnpm start`.

## Verification (per CLAUDE.md's "see it work on the running app" rule)

`pnpm typecheck` and `pnpm test` both green (3 pass, 3 skipped — the skips need
cloud API keys).

Live run: quit the installed app, launched the dev build with
`--remote-debugging-port`, and drove the real Settings window over CDP. All three
branches observed on the running app, each starting from no model on disk:

- Speed test on Base → `ggml-base-q5_1.bin` appears → verdict "On-device
  transcription took 0.4s" → click **Keep cloud** → file gone.
- Same test → click **Use on-device** → file still present (it is the engine now).
- Same test → close the Settings window without clicking either → file gone.

Menu-bar icon confirmed present after launch (screenshot). Click-to-talk
confirmed working incidentally: an AppleScript click on the tray icon started
and stopped a dictation, with the orange mic indicator going on and off.

Not verified: a full spoken dictation through Deepgram — that needs a human
voice. The Deepgram path was untouched by this change.

## Left alone (not asked for)

- `/Users/macpro/dev/voice/dist` — 586 MB of build output, including a stale
  `GVoice-previous-2026-07-30.app`. Not models.
- The installed `/Applications/GVoice.app` is the **previous** build, and is
  running again now. The fix is committed (`8ce4bbe`, `dbe5412`) but is not in
  the app used daily until a `pnpm build` + reinstall. Nothing pushed.

Test residue removed afterwards: the `WHISPER_MODEL` / `WHISPER_BIN` lines the
apply steps wrote into the repo `.env`, `STT_PROVIDER` back to `deepgram` in both
`.env` files, the 57 MB Base model, and the `.env.bak` copy in the app-support
folder.
