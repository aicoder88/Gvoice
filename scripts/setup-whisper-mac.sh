#!/usr/bin/env bash
# Sets up the free on-device speech engine on macOS: whisper.cpp from Homebrew
# plus a GGML model. Mirrors scripts/setup-whisper-windows.ps1 and is likewise
# idempotent — re-running skips whatever is already there.
#
# Usage: ./scripts/setup-whisper-mac.sh [model-basename]
set -euo pipefail

MODEL="${1:-ggml-small-q5_1.bin}"     # multilingual, ~190 MB
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODELS_DIR="$REPO_ROOT/models"

if ! command -v whisper-cli >/dev/null 2>&1; then
  command -v brew >/dev/null 2>&1 || {
    echo "[setup] Homebrew isn't installed — get it from https://brew.sh, then re-run this." >&2
    exit 1
  }
  echo "[setup] installing whisper-cpp via Homebrew"
  brew install whisper-cpp
else
  echo "[setup] whisper-cli already on PATH, skipping install"
fi

mkdir -p "$MODELS_DIR"
if [ -f "$MODELS_DIR/$MODEL" ]; then
  echo "[setup] already have $MODEL, skipping download"
else
  echo "[setup] downloading $MODEL"
  curl -L --fail --progress-bar -o "$MODELS_DIR/$MODEL" \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$MODEL"
fi

# Absolute paths, always. An app launched from Finder starts with a bare PATH —
# /opt/homebrew/bin isn't on it — so a bare `WHISPER_BIN=whisper-cli` works in
# dev and dies in the installed app. Same for a relative model path.
WHISPER_BIN="$(command -v whisper-cli)"

echo
echo "[setup] done."
# GVoice runs the model through whisper-server (fast, model stays loaded) and
# falls back to one whisper-cli run per clip if the server isn't there.
if [ -x "$(dirname "$WHISPER_BIN")/whisper-server" ]; then
  echo "[setup] whisper-server present — transcription will use the fast server path."
else
  echo "[setup] no whisper-server alongside whisper-cli — GVoice will run the slower"
  echo "[setup] one-process-per-clip fallback. See SETUP.md to build one."
fi
echo
echo "Add these lines to your .env (the installed app reads"
echo "~/Library/Application Support/GVoice/.env; a dev run reads $REPO_ROOT/.env):"
echo
echo "  STT_PROVIDER=whisper-local"
echo "  WHISPER_BIN=$WHISPER_BIN"
echo "  WHISPER_MODEL=$MODELS_DIR/$MODEL"
