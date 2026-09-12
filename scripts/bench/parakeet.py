# Runs NVIDIA Parakeet TDT 0.6B v3 (ONNX int8) over a folder of WAVs and reports
# how long each one took. Called by engine-compare.mjs, or on its own.
#
# Usage: python scripts/bench/parakeet.py <model-dir> <clips-dir> [--json]
#
# The model directory needs the four files from the int8 ONNX bundle — encoder,
# decoder+joint, the mel extractor (nemo128.onnx) and vocab.txt — PLUS a
# config.json the published bundle does not include:
#
#     {"features_size": 128, "subsampling_factor": 8}
#
# Without it the runtime assumes 80 mel bins, the encoder is handed the wrong
# shape, and the whole thing fails with "Got: 80 Expected: 128" instead of
# anything that hints at a missing file.
#
# Needs onnx-asr and onnxruntime:
#     python3 -m venv --system-site-packages <venv>   # reuses a system onnxruntime
#     <venv>/bin/pip install onnx-asr

import glob
import json
import os
import sys
import time

import onnx_asr

MODEL_TYPE = "nemo-parakeet-tdt-0.6b-v3"


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    model_dir, clips_dir = sys.argv[1], sys.argv[2]
    as_json = "--json" in sys.argv

    config = os.path.join(model_dir, "config.json")
    if not os.path.exists(config):
        print(f"{config} missing — see the note at the top of this file", file=sys.stderr)
        return 2

    t0 = time.time()
    model = onnx_asr.load_model(MODEL_TYPE, model_dir, quantization="int8")
    load_ms = int((time.time() - t0) * 1000)

    clips = sorted(glob.glob(os.path.join(clips_dir, "*.wav")))
    if not clips:
        print(f"no .wav files in {clips_dir}", file=sys.stderr)
        return 2

    # Not measured: the first call after a load pays for lazy graph setup, which
    # a running app has already paid.
    model.recognize(clips[0])

    rows = []
    for clip in clips:
        name = os.path.basename(clip)
        # The language tag in the filename, when there is one. Parakeet v3 is
        # multilingual, so this only narrows it, never teaches it.
        lang = name.split("-")[-1].replace(".wav", "") if "-" in name else "en"
        t = time.time()
        text = model.recognize(clip, language=lang if len(lang) == 2 else None)
        rows.append({"clip": name, "ms": int((time.time() - t) * 1000), "text": text.strip()})

    if as_json:
        print(json.dumps(rows))
    else:
        print(f"model load: {load_ms}ms (once, at startup)")
        for row in rows:
            print(f"{row['clip']}  parakeet {row['ms']:5d}ms  {json.dumps(row['text'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
