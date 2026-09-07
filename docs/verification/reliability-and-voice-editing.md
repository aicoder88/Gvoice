# Reliability and voice editing verification

Local verification on macOS Apple Silicon, 2026-09-05. Changes are uncommitted;
no push, deployment, or replacement of an installed app was performed.

## Implemented

- Utterance generations follow asynchronous microphone acquisition, socket events,
  terminal IPC, cleanup, recovery, and paste. Duplicate terminal events cannot
  deliver twice; older work cannot finish a newer session.
- Microphone/socket startup and cleanup have bounded completion. Cleanup retries
  and model failover share the existing 2.5-second default budget.
- Clipboard leases serialize delivery and restore only an owned clipboard. Failed
  paste recovery no longer writes over a newer user copy on a delayed timer.
- Settings / Activity reports content-free release-to-paste and stage timing,
  grouped by provider and warm/cold capture, with median, p95, and failure counts.
- Cmd+Shift+E captures a selection for a spoken or typed editing instruction.
  Preview precedes explicit Apply. Native readback enables guarded Undo.
  Supported macOS text fields use a checked full-field value update preserving
  text outside the selected range; unsupported fields fail with an explanation.

## Automated checks

- Unit tests: **220 passed, 0 failed**.
- Provider parity: **4 passed, 2 skipped**. The skipped OpenAI cases require credentials.
- `pnpm build`: passed; output `dist/mac-arm64/GVoice.app`. No Developer ID
  signing identity is configured, so this is an unsigned local build.
- `git diff --check`: passed.

## Desktop evidence

The regression runner creates isolated app/config/history and Whisper PID
directories and a separate editable target process. It uses synthetic audio
through the real capture worklet, local relay and local Whisper. The editing
model response is an offline fixture; no live editing-provider request is tested.

Native selection capture, preview, partial-selection Apply preserving surrounding
text, and Undo passed in the separate target.
Earlier runs exposed Chromium's no-op selected-text setter; the implementation
now uses writable field values and asynchronous verification, including readback
after a setter timeout that may have delivered the mutation. A proposed native
paste shortcut optimization failed exact-text verification and was removed.

`GVOICE_TEST_EDIT_ONLY=1 GVOICE_TEST_SPOKEN_EDIT=1 GVOICE_TEST_TRAY_PROOF=1 pnpm test:electron`
passed. Local Whisper recognized **"rewrite this text using fewer words."** The
runner verified preview-before-mutation, partial Apply preserving prefix/suffix,
and Undo for both typed and spoken instructions. The edit window was also inspected
through the native accessibility interface, showing **Original text restored**.
Native screen crops visibly confirmed the GVoice tray icon and its open menu.
See [preview](edit-preview.png) and [applied selection](edit-applied.png).

The complete desktop suite is **not passing on this host**. Its final run correctly
transcribed the exact quick-fox fixture, then the native paste helper hit its
existing four-second deadline. No text reached the external test field; the app
recorded the transcript as recoverable. This is not a passing end-to-end result.
Earlier running-app checks verified native paste and duplicate/stale IPC against
an in-process test editor, but that does not replace the failing cross-process run.

## Limits

Physical microphone selection across restart, physical hotkey handling, Windows,
and compatibility with other applications' editors are not verified by these
fixtures. Desktop timing samples are local fixture measurements, not a production
latency guarantee. Slow macOS paste-helper timeouts occurred under host load and
correctly left transcripts recoverable instead of claiming delivery.
