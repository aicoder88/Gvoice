# Prompt: pick the speech engine on measured numbers

Paste the block below into a fresh session opened in `/Users/macmini/dev/voice`.
Written 2026-09-12, after the first run (`docs/reports/engine-benchmark-2026-09-12.md`).
Everything it points at was verified that night: the rig runs, the three URLs
answer HTTP 200 at the stated sizes, and Parakeet transcribes.

---

Benchmark the speech engines for GVoice in /Users/macmini/dev/voice and tell me which one to run for speed against accuracy. The rig is already in the repo at scripts/bench. Measure, report, recommend, stop. Do not change which engine the app uses, do not push, do not install anything into /Applications.

**Step 0 — rescue the Parakeet model first.** The only copy is in the Trash, and emptying the Trash destroys it:

    cp -R ~/.Trash/parakeet-tdt-0.6b-v3-int8 ~/models/parakeet-tdt-0.6b-v3-int8   # 640 MB

It needs a config.json the published bundle never included. Without it the runtime assumes 80 mel bins, the encoder refuses the input, and the error says "Got: 80 Expected: 128" with no hint that a file is missing:

    printf '%s\n' '{"features_size": 128, "subsampling_factor": 8}' > ~/models/parakeet-tdt-0.6b-v3-int8/config.json

Its runtime (onnxruntime 1.29 is already installed system-wide, so reuse it):

    python3 -m venv --system-site-packages ~/venv-parakeet
    ~/venv-parakeet/bin/pip install onnx-asr

**Step 1 — fetch the three whisper models** into /Users/macmini/dev/voice/models. The app's own downloader (src/model-download.js) does NOT resume — on failure it deletes the part file and starts over, and it retries only once. This Mac is on an iPhone tether that drops every ~20 minutes, and Hugging Face serves byte ranges, so use curl and let it resume:

    cd /Users/macmini/dev/voice
    for m in ggml-medium-q5_0.bin ggml-large-v3-turbo-q5_0.bin ggml-large-v3-q5_0.bin; do
      curl -L -C - --retry 20 --retry-all-errors --retry-delay 5 \
        -o "models/$m" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$m"
    done

Expected sizes, confirmed against the server: medium 514 MB, large-v3-turbo 547 MB, large-v3 1031 MB. About 2.1 GB in total. If a file comes up short, run the same command again — it picks up where it stopped. A truncated model makes whisper-server die on load rather than transcribe badly, so a size check plus one successful clip is proof enough.

**Step 2 — make the clean clips.** Ten sentences (eight English, two Croatian) spoken straight to 16 kHz mono files, so every engine gets byte-identical audio and the spoken words are known:

    sh scripts/bench/make-clips.sh /tmp/bench-clips

**Step 3 — run everything against everything:**

    node scripts/bench/engine-compare.mjs --clips /tmp/bench-clips --deepgram \
      --parakeet ~/models/parakeet-tdt-0.6b-v3-int8 --venv ~/venv-parakeet \
      --out /tmp/bench-clean.json

It spawns its own warm whisper-server per model with the flags a real dictation uses (-t 4 --no-fallback -fa), throws away the first request so no model-load time is counted, scores word-level errors against what was spoken, and prints medians and the slowest clip. Readiness is by knocking on the port, not by reading the log — which stream the "listening" line lands on differs between whisper.cpp builds.

**Step 4 — run the same engines over Drago's real recordings.** They are 24 kHz, so convert them first and let every engine see the same input:

    mkdir -p /tmp/bench-real
    for f in ~/Library/Application\ Support/GVoice/temp-recordings/*.wav; do
      ffmpeg -hide_banner -loglevel error -i "$f" -ar 16000 -ac 1 -c:a pcm_s16le \
        -y "/tmp/bench-real/$(basename "$f")"
    done
    node scripts/bench/engine-compare.mjs --clips /tmp/bench-real --deepgram \
      --parakeet ~/models/parakeet-tdt-0.6b-v3-int8 --venv ~/venv-parakeet \
      --out /tmp/bench-real.json

Nothing is scored there — nobody knows the exact words. The question is which engine recovers the most words from the real microphone, and whether the big models pull speech out of clips where the small one heard only noise labels like "(screaming)" and "[BANG!]".

**The baseline to beat**, measured 2026-09-12 on the same rig, 8 English clips (98 words) and 2 Croatian (19 words):

| engine | English errors | Croatian errors | median | slowest |
|---|---|---|---|---|
| whisper small.en-q5_1 (installed) | 2.0% | 94.7% | 440 ms | 462 ms |
| deepgram nova-3 (cloud) | 2.0% | 0.0% | 383 ms | 6236 ms |
| parakeet tdt 0.6b v3 | 3.1% | 5.3% | 248 ms | 342 ms |

Parakeet also pays a one-time 3.6 s model load at startup.

**Ten clips is a thin sample.** One wrong word moves a percentage by several points, so no gap under roughly 3 points means anything yet. Before believing a close result, add 20 more sentences to scripts/bench/sentences.txt in the same `lang|text` shape — ordinary work sentences, names and numbers included, a couple of Croatian ones — and rerun. Croatian and the latency ordering were the only differences big enough to trust on the first run.

**Report** to docs/reports/engine-benchmark-<today>.md: the table, the outliers, and ONE recommendation that names the trade-off in plain words — how many extra milliseconds bought how many fewer wrong words. Say which engine you would run and why. End with what it would cost to switch: the whisper models are a settings change, while Parakeet means a new provider in the relay talking to a local Python server, which is a day of work and not a setting.

**Two things already known** that belong in the report: GVoice's custom dictionary is empty, so every name error all three engines made ("Purify" for Purrify, "anchor" for Anker) is free to fix — the dictionary feeds whisper its seed prompt and Deepgram its keyterms. And on Drago's real failed clips, all three engines including the cloud one heard nothing at all, which means the microphone and the room, not the model, are what broke those dictations.
