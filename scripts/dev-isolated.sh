#!/usr/bin/env bash
# Runs GVoice from this checkout with its own data folder, so it shares nothing
# with the copy in /Applications.
#
# Why: both instances used to write one speech-engine marker file under $TMPDIR.
# Starting a dev copy read that marker, saw a live "whisper-server", and killed
# it — taking the installed app's speech engine down while somebody was using it.
# A separate data folder means a separate marker, a separate ownership record,
# and a separate single-instance lock, so both apps run side by side.
#
# Usage: ./scripts/dev-isolated.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export GVOICE_USER_DATA="$ROOT/.dev-userdata"
export GVOICE_DEBUG=1

mkdir -p "$GVOICE_USER_DATA"
echo "GVoice dev launch"
echo "  repo:      $ROOT"
echo "  user data: $GVOICE_USER_DATA"

cd "$ROOT"
exec pnpm start
