# GVoice updated on the MacBook Air - 2026-09-09

## What was wrong
The GVoice in /Applications was built 2026-08-30. Ten days of work were missing
from the app actually running, including the clipboard paste-race fixes.

Three gaps found:
1. Installed app: built Aug 30 (revision unknown, pre build-identity).
2. Work folder: a Sep 8 build sat in dist/ and was never installed, plus
   uncommitted clipboard work still on this laptop.
3. GitHub: origin/main carried 935c3a9 (2026-09-09 18:27 Montreal), not pulled.

## What was done
- Fast-forwarded main 43568bb -> 935c3a9. No conflict: the remote change touched
  scripts/unit/voice-edit-window.test.js, which was not among the dirty files.
- `pnpm build` -> dist/mac-arm64/GVoice.app, stamped
  revision 935c3a92b3d83fab6d15fc45670b63421ebdc415, builtAt 2026-09-09T21:27:57Z.
- Quit the running app, copied the old /Applications/GVoice.app to
  ~/.claude/archive-2026-08/GVoice-app-backup-2026-09-09 (293M), logged it in
  ARCHIVE-LOG.md, installed the new bundle, cleared quarantine, relaunched.

## Verified on the running app
- build-info.json inside the installed app.asar reads 935c3a9 / 2026-09-09T21:27:57Z.
- debug.log startup-build line at 21:28:31 confirms the same revision at launch.
- Menu-bar icon present (screenshot of the menu bar).
- Full dictation round trip at 21:28:59: press -> deepgram nova-3 -> final
  transcript -> pasted, releaseToPasteMs 972.

## Not verified
- Microphone persistence for the Anker input. The Anker is not connected right now
  (system_profiler lists only the built-in mic, Immersed and Teams virtual devices),
  so the known regression spot could not be exercised. Capture bound to
  "Default - MacBook Air Microphone (Built-in)".
- Nothing was pushed. The uncommitted clipboard work is still uncommitted, and the
  new app carries it because the build packages the working tree, not HEAD.

## Flaws in this work
- The installed app now contains uncommitted source. If that work is later dropped,
  the running app and the repo history will disagree with no record of what shipped.
- The build is unsigned (no Developer ID identity on this machine), so macOS
  Gatekeeper state depends on the quarantine clear that was applied.
