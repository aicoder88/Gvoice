# GVoice saved-edit reconciliation, 2026-10-03

The saved Parakeet and audio-delivery work has been reconciled with all previously prepared committed branches. This is local branch integration; the running GVoice app has not been rebuilt, started, restarted or observed. No microphone, paste, keychain, paid-provider or deployment test was run. Spending: US$0.

The source main before work was `095c38b5b6af97255ea202ace12320196b26bc3c`. A SHA-256 manifest captured every tracked and visible untracked file before work. Twenty-eight changed or newly added code/document paths were reviewed and preserved in checkpoint `2893372`; the source's unrelated reports and untracked plans remain in place.

The checkpoint includes the local Parakeet provider and native worker sources, existing deletion of the Python benchmark, 16 kHz capture selection, partial-buffer acknowledgement and final resampling, selected-microphone safety, file transcription, packaging support and unit fixtures. The deliberate relay provider fallbacks and environment configuration were not replaced or removed.

Prepared integration `b223022` was merged into that checkpoint. Three conflicts were resolved: both decision histories remain; the renderer imports both the saved explicit-input resolver and the Windows origin-change ID resolver; its unit fixture handles both imports. Windows skips the unsupported Unix socket, retains sender validation, and reconnects persisted preferences by a unique exact microphone label. The saved strict capture path still refuses an unavailable explicitly selected input rather than silently using another microphone.

## Verification

- `pnpm run test:unit`: 451 passed, 1 skipped, 0 failed, 452 total.
- `node --check`: 29 changed JavaScript modules passed.
- `git diff --check`: passed.
- Source file manifest checked again immediately before checkpoint application.
- All prepared committed branch tips remain ancestors of the reconciliation result.

Unit tests use fake workers, media and HTTP dependencies. They prove merge consistency and covered pure behavior; they do not prove native worker compilation, installed app compatibility, microphone selection after restart, tray visibility or real dictation endings. Those running-app checks remain unverified under the explicit no-launch boundary for this task.

The checkpoint may make existing code files tracked, but unrelated untracked plans and reports retain their original bytes. No existing user material was deleted by this task; the removed legacy Python benchmark was already deleted in the saved source edits.
