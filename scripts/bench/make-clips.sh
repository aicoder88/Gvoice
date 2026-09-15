#!/bin/sh
set -eu
# Speaks every line of sentences.txt straight to a 16 kHz mono WAV, so each
# engine gets byte-identical audio and the words that were actually said are
# known. Croatian lines use the Croatian voice; without it the test would be
# measuring an English voice reading Croatian, which proves nothing.
#
# Usage: sh scripts/bench/make-clips.sh <output-dir>
OUT="${1:?usage: make-clips.sh <output-dir>}"
HERE="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
mkdir -p "$OUT"
i=0
while IFS='|' read -r lang text; do
    [ -n "${lang:-}" ] || continue
    i=$((i+1))
    n=$(printf "%02d" "$i")
    if [ "$lang" = "hr" ]; then voice="Lana"; else voice="Samantha"; fi
    say -v "$voice" -r 175 -o "$OUT/tmp-$n.aiff" "$text"
    ffmpeg -hide_banner -loglevel error -i "$OUT/tmp-$n.aiff" \
        -ar 16000 -ac 1 -c:a pcm_s16le -y "$OUT/clip-$n-$lang.wav"
    rm -f "$OUT/tmp-$n.aiff"
done < "$HERE/sentences.txt"
echo "$i clips in $OUT"
