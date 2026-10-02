# Windows compatibility fixes, 2026-09-15

## Result

Prepared a Windows x64 installer from ba07e73 plus the local compatibility fixes
on `codex/windows-update-compatibility`. The existing installation was not
replaced. Its data, settings and recordings were not migrated.

Installer: `C:/dev/Gvoice/dist/GVoice Setup 1.0.0.exe`.
Installed app: `C:/Users/Drago/AppData/Local/Programs/gvoice/GVoice.exe`.

## Changes

- Windows no longer starts the Unix socket used by the macOS Better Options
  companion. Direct Windows server starts fail explicitly before creating a
  socket directory. Windows keyboard and tray dictation remain available.
- Ownership-marker tests now use native absolute paths. The preference-write
  failure test uses an invalid parent directory instead of Unix chmod behavior.
- Fixed a microphone restart defect discovered in the running Windows app.
  The relay's new port changes browser device IDs. Previously the saved choice
  remained visible while capture fell back to the default microphone. A missing
  saved ID now reconnects through an exact, unique device label. The current ID
  is persisted in preferences.json and used by capture. Existing IDs take
  precedence; absent or duplicate labels never cause an arbitrary selection.
- Added an offline Windows Electron regression for startup, microphone
  persistence, renderer recovery, duplicate transcript delivery, cancellation
  and clipboard restoration. It uses a separate profile and disposable target.

The transport decision follows Node's platform split between Unix sockets and
Windows named pipes: https://nodejs.org/api/net.html#ipc-support.
Device identifiers are origin scoped in the media capture specification:
https://www.w3.org/TR/mediacapture-streams/#dom-mediadeviceinfo-deviceid.

## Verification

- `pnpm test`: 398 unit tests passed, no failures. The Unix companion integration
  suite is explicitly excluded on Windows; its 24 cases are not Windows passes.
  The Windows unsupported-server check and portable socket-path test do run.
- Parity: 2 passed, 4 skipped. Provider and unavailable local-engine checks
  were not run.
- `node scripts/electron/windows-compatibility.mjs`: passed all five checks.
  The microphone test restarts the app, verifies that the relay origin and
  device ID changed, then confirms the same named microphone is actively open.
  Native Windows paste landed once in a separate Electron process and restored
  the previous clipboard. A cancelled late transcript did not paste.
- `pnpm build --win --x64 --publish never`: passed.
- Packaged startup in a fresh isolated profile: Settings, recorder, pill and
  vocabulary windows loaded without crashes or the Unix socket error.
- The four changed distributable source files match the packaged app archive.
  Build identity and installer SHA-256 are recorded in the evidence below.
- `git diff --check`: passed.

## Limits

Microphone checks used Chromium fake media, and paste checks used injected
transcripts. Real speech recognition and physical Ctrl+Shift have not been
verified. Microphone selection may need manual selection when two inputs have
identical labels. No Windows companion transport has been implemented.

The runtime reports a live tray object and nonempty icon bounds. The native
menu-open call succeeds, but the menu was not visually confirmed. Tray visibility
and interaction remain a manual verification item. No signing trust check was
performed. The candidate is built and tested as described, not installed or
fully verified for daily use.

## Local evidence

- `C:/dev/Gvoice/.verification/windows-fixed-tests.log`
- `C:/dev/Gvoice/.verification/windows-fixed-build.log`
- `C:/dev/Gvoice/.verification/windows-compatibility.json`
- `C:/dev/Gvoice/.verification/windows-readiness.json`
- `C:/dev/Gvoice/.verification/windows-package-verification.json`
- `C:/dev/Gvoice/.verification/windows-microphone.png`
- `C:/dev/Gvoice/.verification/windows-paste.png`
