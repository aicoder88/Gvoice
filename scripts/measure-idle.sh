#!/usr/bin/env bash
# Five minutes of a freshly launched GVoice sitting idle: processor share,
# memory, how many microphone capture graphs are alive, and how many bytes it
# sent to the network (must be none).
#
# Launches only through dev-isolated.sh, so the installed app is untouched.
# Run: ./scripts/measure-idle.sh [seconds]
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SECS="${1:-300}"
OUT="${GVOICE_MEASURE_OUT:-$ROOT/.dev-userdata/idle-measure}"
mkdir -p "$OUT"
LOG="$OUT/app.log"

cd "$ROOT"
GVOICE_NO_ENV=1 ./scripts/dev-isolated.sh >"$LOG" 2>&1 &
LAUNCHER=$!
echo "launcher pid $LAUNCHER, app log $LOG"

# Wait for the main process to show up under this checkout.
APP=""
for _ in $(seq 1 60); do
  sleep 1
  APP="$(pgrep -f "electron.*$ROOT" | head -1)"
  [ -n "$APP" ] && break
done
if [ -z "$APP" ]; then
  echo "FAILED: no dev app process appeared"
  tail -20 "$LOG"
  kill "$LAUNCHER" 2>/dev/null
  exit 1
fi
echo "dev app pid $APP"

sleep 30 # let launch settle before the idle window starts

START_BYTES_OUT="$(nettop -P -x -J bytes_out -l 2 -p "$APP" 2>/dev/null | tail -1 | awk '{print $NF}')"
echo "bytes_out at start of idle window: ${START_BYTES_OUT:-unreadable}"

SAMPLES="$OUT/samples.tsv"
: >"$SAMPLES"
printf 'elapsed_s\tcpu_pct\trss_kb\tbytes_out\n' >>"$SAMPLES"
ELAPSED=0
while [ "$ELAPSED" -lt "$SECS" ]; do
  CPU="$(ps -o %cpu= -p "$APP" | tr -d ' ')"
  RSS="$(ps -o rss= -p "$APP" | tr -d ' ')"
  BO="$(nettop -P -x -J bytes_out -l 2 -p "$APP" 2>/dev/null | tail -1 | awk '{print $NF}')"
  printf '%s\t%s\t%s\t%s\n' "$ELAPSED" "${CPU:-gone}" "${RSS:-gone}" "${BO:-?}" >>"$SAMPLES"
  sleep 20
  ELAPSED=$((ELAPSED + 20))
done

echo "--- samples ---"
cat "$SAMPLES"
echo "capture graphs built during idle: $(grep -c 'Capture bound to' "$LOG")"
echo "--- app log tail ---"
tail -5 "$LOG"

kill "$APP" 2>/dev/null
kill "$LAUNCHER" 2>/dev/null
