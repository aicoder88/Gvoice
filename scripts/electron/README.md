# Desktop regression check

Run `node scripts/electron/regression.mjs` from the repository on a macOS desktop
with Electron installed and Accessibility permission for its native paste helper.
Do not interact with other apps during the run: the check focuses a separate test application's textarea
and sends a real paste shortcut. An existing GVoice instance stays running in its
own profile; the regression instance must disable its global hotkey hooks.

The runner uses the repository's local Whisper base model, or the explicit
`GVOICE_TEST_MODEL` absolute path. It uses project-local Playwright, or the explicit
`GVOICE_PLAYWRIGHT_PATH` override.
Missing prerequisites and timeouts fail the run instead of skipping.

Coverage:

- Real Electron windows, synthetic fixture MediaStream into the real capture worklet, local relay,
  local Whisper recognition, native clipboard paste, and textarea DOM readback.
- A repeated start during a hold is rejected.
- Duplicate transcript IPC is delivered once; expired generation IPC cannot
  paste into or finish the next session.
- The text clipboard is restored, the tray exists and has screen bounds, and a
  screenshot records the fixture text in the destination.
- Cold and warm capture both deliver actual local speech recognition to the textarea.
- Native selected-text capture, offline model preview, native Apply and Undo.
  The edit model response is deterministic and test-only; no model network call occurs.

This check uses a synthetic AudioBuffer-to-MediaStream source, synthetic start/release calls, and a
separate Electron destination process. It does not prove physical microphone selection, hotkey
hardware, compatibility with every application's editor, or visible native tray menu
operation. Those require separate running-app desktop checks. A tray object and
bounds assertion is not a visual tray verification.

The runner creates a temporary user-data/config directory before importing the
app, isolates the Whisper PID directory with TMPDIR, and never writes a dotenv file. Temporary logs,
history and the screenshot remain available for investigating failures. The
main-process bridge must exist only in an unpackaged app with the explicit
`GVOICE_TEST_MODE=1` environment switch. Production renderer IPC must not expose
the bridge.

Every native paste requires a focused, accessible, editable test target. An
unverifiable target fails closed. Set `GVOICE_TEST_INSPECT=1` to retain the passed
test instance for 60 seconds for manual tray/menu inspection. The overall run
has a 240-second deadline and shutdown is bounded. `GVOICE_TEST_EDIT_ONLY=1`
runs only native selection capture and edit preview/Apply/Undo.
Add `GVOICE_TEST_SPOKEN_EDIT=1` to verify the actual Speak instruction button,
fixture audio through local Whisper, preview without mutation, Apply and Undo.
`GVOICE_TEST_TRAY_ONLY=1 GVOICE_TEST_TRAY_PROOF=1` skips dictation and editing,
opens the actual tray menu and saves a cropped screenshot from the separate
target process. Its result is `captured`, requiring visual review, rather than
claiming any skipped regression checks passed.
