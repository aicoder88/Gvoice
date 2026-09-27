# GVoice code review

Reviewed the local file-transcription changes and Transcribe removal record against GitHub main, including the newer cleanup and voice-editing changes through `10cd2b4`.

## Findings resolved

- P2, `src/file-media.js`: video container duration could exceed the selected audio track, causing valid files to fail as truncated. Probe the first audio track used by the decoder and prefer its duration, with a container fallback when track duration is unavailable.
- P2, `src/file-transcription.js`: Resume changed the in-memory state before saving it. A failed write left the job queued without starting work or offering Resume. Save the proposed state before publishing it, and guard duplicate resume requests.

Both regressions failed before the fixes and passed afterward. No remaining blocking finding was identified in the reviewed changes.

## Verification

- `pnpm test`: 433 unit checks and three local parity checks passed. Three external-provider checks skipped because live-provider testing was not enabled.
- `node scripts/electron/file-transcription.mjs`: passed in an isolated running development app using synthetic English speech and the existing local model. Verified a failed Resume save remains paused and can be retried, and a 12-second video with eight seconds of audio completes with visible text.
- The same app run verified dictation priority, pause/restart/resume, three saved sections from a 45.9-second recording, six expected phrase repetitions, TXT/SRT/JSON output, protection of existing destinations, and reopening saved results.
- Light and dark window captures produced; light capture inspected. No new interface styling was changed in this review.
- `git diff --check`: passed.

The installed `/Applications/GVoice.app` was not rebuilt or replaced during this review. The original hotkey incident remains undiagnosed; these findings do not establish its cause or guarantee it cannot recur. Native tray-menu appearance and physical hotkey/paste behavior were not newly verified. No external spending or new model downloads.
