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

# Every process the app runs, not just the main one: a helper can open a socket
# of its own, and reading only the main process would miss it.
app_tree() {
  pgrep -f "$ROOT" | tr '\n' ' '
}

# Bytes this app sent, summed over its whole process tree. Includes loopback:
# see the note where it is printed.
#
# nettop prints a header line whether or not the process has any traffic, so
# taking the last line blindly returns the word "bytes_out" instead of a number
# (that is exactly what the 2026-09-11 run recorded in every row). Keep only
# rows that name one of our pids, and treat "no rows at all" as the zero it is.
read_bytes_out() {
  local total=0 pid row
  for pid in $(app_tree); do
    row="$(nettop -P -x -J bytes_out -l 2 -p "$pid" 2>/dev/null \
           | awk -v p="$pid" '$0 ~ ("\\." p "[[:space:]]") {v=$NF} END {print v+0}')"
    total=$((total + ${row:-0}))
  done
  printf '%s' "$total"
}

# Sockets open to anywhere but this machine. Loopback is the app's own speech
# engine and does not count as leaving the Mac. This, not the byte counter
# below, is the number that answers "did anything go out".
#
# grep -c prints 0 AND exits 1 when nothing matches, so a bare `|| printf 0`
# fallback prints a second zero. Swallow the exit code instead.
read_offbox_sockets() {
  local pids
  pids="$(app_tree | tr ' ' ',' | sed 's/,$//')"
  [ -z "$pids" ] && { printf '0'; return; }
  lsof -nP -i -a -p "$pids" 2>/dev/null \
    | grep -v '^COMMAND' | grep -v '127\.0\.0\.1\|\[::1\]' | grep -c . || true
}

# A capture graph is only ever built by a dictation. With no dictation there is
# nothing to keep warm, so a count of zero proves nothing either way - it has to
# be reported as inconclusive, not as a pass.
DICTATIONS_BEFORE="$(grep -c 'dictation:start' "$LOG" 2>/dev/null || echo 0)"

echo
echo "  >> Dictate once NOW, then leave the Mac alone."
echo "  >> Without one dictation the capture-graph check cannot pass or fail."
echo

sleep 30 # let launch settle before the idle window starts

START_BYTES_OUT="$(read_bytes_out)"
echo "bytes_out at start of idle window: $START_BYTES_OUT"

SAMPLES="$OUT/samples.tsv"
: >"$SAMPLES"
printf 'elapsed_s\tcpu_pct\trss_kb\tbytes_out\toffbox_sockets\n' >>"$SAMPLES"
ELAPSED=0
while [ "$ELAPSED" -lt "$SECS" ]; do
  CPU="$(ps -o %cpu= -p "$APP" | tr -d ' ')"
  RSS="$(ps -o rss= -p "$APP" | tr -d ' ')"
  BO="$(read_bytes_out)"
  SOCK="$(read_offbox_sockets)"
  printf '%s\t%s\t%s\t%s\t%s\n' "$ELAPSED" "${CPU:-gone}" "${RSS:-gone}" "${BO:-0}" "${SOCK:-0}" >>"$SAMPLES"
  sleep 20
  ELAPSED=$((ELAPSED + 20))
done

echo "--- samples ---"
cat "$SAMPLES"
GRAPHS="$(grep -c 'Capture bound to' "$LOG" 2>/dev/null || echo 0)"
DICTATIONS_AFTER="$(grep -c 'dictation:start' "$LOG" 2>/dev/null || echo 0)"
DICTATIONS=$((DICTATIONS_AFTER - DICTATIONS_BEFORE))
if [ "$DICTATIONS" -eq 0 ]; then
  echo "capture graphs: INCONCLUSIVE - nobody dictated, so none was ever built."
  echo "  Re-run and dictate once when told to, or this number means nothing."
else
  echo "capture graphs built: $GRAPHS after $DICTATIONS dictation(s) - one is the target."
fi
# nettop counts loopback, so this number is NOT "bytes that left the Mac" - the
# app's own chatter with its local speech engine lands in it. Read it for churn;
# read the socket count for the question that matters.
echo "bytes sent, its own local engine included: $(read_bytes_out)"
echo "sockets open to anywhere but this Mac: $(read_offbox_sockets) (target 0)"
echo "--- app log tail ---"
tail -5 "$LOG"

kill "$APP" 2>/dev/null
kill "$LAUNCHER" 2>/dev/null
