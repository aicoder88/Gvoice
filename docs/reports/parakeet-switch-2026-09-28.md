# GVoice switched to Parakeet

Installed and started `/Applications/GVoice.app` with `STT_PROVIDER=parakeet-local`.
Its owned `gvoice-parakeet` process loaded the existing Handy/Hugging Face
Parakeet Unified EN 0.6B Q8_0 model; no model was downloaded or copied.
The installed debug log confirms `parakeet warmed at boot`.

Saved `Anker PowerConf C200` as the explicit microphone. The application resolves
the real device by its saved name and refuses another microphone if the selected
one is missing. Handy also remains explicitly set to Anker. AI cleanup retains
its existing configuration, separate from the local recognition engine.

Verification:

- 437 unit checks passed; the final focused rerun passed 20 checks.
- Offline parity: 3 passed, 3 cloud checks intentionally skipped.
- Native runtime: a complete 6.51-second synthetic English sample transcribed
  correctly, 1,332 ms cold and 94 ms warm in the measured standalone run.
- Full GVoice desktop regression: synthetic speech traversed the real audio
  processing, Parakeet, and native paste into a separate app. Both attempts were
  correct, 1,921 ms and 1,041 ms from release to paste. Duplicate/stale delivery,
  clipboard restoration, selected-text capture, and edit Apply/Undo passed.
- The signed packaged app opened its file window and transcribed synthetic
  speech successfully with Parakeet, using separate test data and no secret files.
- Strict recursive signature verification passed. A recursive file comparison
  matched the installed app to the tested bundle. Source digest:
  `8c8aec6059614b017f0b1924498245dabe33654a50ed39d14b7fcba3ff0415fd`.

Limits: the owner's physical microphone speech has not yet been tested after
installation. The native UI inspector timed out on the tray-only installed app;
it also cannot synthesize a modifier-only right Option press. No claim is made
about recognition accuracy for the owner's own speech yet. Two minutes is the
Parakeet provider's per-dictation audio bound; longer recordings use file
transcription. The existing hold-key limit remains 90 seconds.

The original signed app is preserved at
`/Users/macmini/Library/Application Support/GVoice/AppBackups/before-parakeet-2026-09-28/GVoice.app`.
The previous speech-engine choice was `whisper-local`. Its model remains present.
The installed dotenv change used `env-safe-set`; microphone preferences are in
the separate `preferences.json`. No GitHub push or external spending occurred.
