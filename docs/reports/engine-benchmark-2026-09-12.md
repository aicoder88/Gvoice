# Speech engines measured on this Mac (2026-09-12)

Every number below was measured here tonight, on this machine, with the engine
warm. Nothing is quoted from a spec sheet.

## Test rig

Ten sentences, eight English and two Croatian, spoken by macOS voices (Samantha,
Lana) straight to file at 16 kHz mono – so every engine got byte-identical audio
and the words actually spoken are known. Word error rate is word-level edit
distance after stripping punctuation and case. 97 English words, 19 Croatian.

Whisper ran against GVoice's OWN already-running server (`-t 4 --no-fallback
-fa`), so no model-load time is counted – the same conditions a real dictation
gets. Deepgram ran through the app's own `transcribeWavFile` with the key the app
resolves. Parakeet ran through `onnx-asr` on onnxruntime 1.29 with CoreML.

## Results

| engine | where | English WER | Croatian WER | median latency |
|---|---|---|---|---|
| whisper small.en (what you run) | on this Mac | 2.0% | 94.7% | 454 ms |
| deepgram nova-3 | cloud | 2.0% | 0.0% | 390 ms |
| parakeet tdt 0.6b v3 | on this Mac | 3.1% | 5.3% | 257 ms |

Latency spread per clip: whisper 403–523 ms, parakeet 122–301 ms, deepgram
203–685 ms with one 6,236 ms outlier (the tether, not the service).

Parakeet pays a one-time 3.6 s model load at startup and holds the model in
memory afterwards.

### What the 2.0% vs 3.1% actually is

Two errors versus three, out of 97 words. At this sample size that gap is noise
and must not be read as "whisper is more accurate". The differences that are NOT
noise:

- **Croatian.** 94.7% versus 5.3% versus 0.0% is not a sampling artifact. The
  installed model is `ggml-small.en-q5_1.bin` – English only. It wrote
  "Stranica es premna alizien treba yosh yed nam praviariti" for "Stranica je
  spremna ali cijenu treba još jednom provjeriti", and "(speaking in foreign
  language)" for the other one.
- **Latency order.** Parakeet was fastest on all ten clips, without exception.

Every English error any engine made was a proper noun or a homophone: "Purify"
for Purrify (whisper, deepgram, parakeet), "anchor" for Anker (all three),
"palette" for pallet (parakeet). GVoice can feed those words to whisper as a seed
prompt and to Deepgram as keyterms – and **the custom dictionary is empty**, so
neither is being used today. That is the cheapest accuracy win available.

## The same three engines on Drago's own recordings

Four clips off the real microphone, converted to 16 kHz so all three saw the same
input. `real-1` and `real-2` are the two dictations that failed at 17:34.

| clip | whisper | deepgram | parakeet |
|---|---|---|---|
| real-1 (17:34 failure) | "(screaming)" | "" | "Uh" |
| real-2 (17:34 failure) | "(screaming)" | "" | "I have a" |
| real-3 (15:38) | "[BANG!] [Inaudible] [Inaudible] [Inaudible]" | "" | "" |
| real-4 (15:38) | "Yeah." | "" | "Yeah." |

**This is the finding that matters.** Deepgram – the engine that got Croatian
perfect – heard literally nothing in all four. Three independent engines cannot
all be wrong in the same way: the audio in those clips contains no intelligible
speech. No model change fixes them. The microphone and the room are the
bottleneck, not the ear.

For contrast, the same sentence that came out as "get a play right" through the
real microphone was transcribed perfectly by the installed whisper when spoken
into a clean file: "Not going to get it quite right." – 0% error.

## Not measured, and why

**Whisper medium or large, quantized.** Neither is on this Mac. The only whisper
model here is small.en (181 MB), and the app's preference list wants
`ggml-small-q5_1.bin` first, which is also absent. Medium q5 is roughly 540 MB
and large-v3 q5 roughly 1.1 GB to fetch. No number is given for them here
because none was measured, and the scaling from small cannot be assumed –
especially on Metal. Fetching either takes about ten minutes on the tether, after
which the same test rig gives a real answer.

## Parakeet: what using it would actually take

It is not a drop-in. GVoice's on-device path is whisper.cpp, which reads ggml
files; Parakeet is three ONNX graphs plus a vocabulary, driven from Python.
Getting it running tonight needed:

- the bundle copied out of the Trash (`~/.Trash/parakeet-tdt-0.6b-v3-int8`, 640 MB,
  deleted today at 16:13), which is complete: encoder, decoder+joint, the 128-bin
  feature extractor, vocabulary;
- a `config.json` the download never included – `{"features_size": 128}`. Without
  it the runtime assumes 80 mel bins and the encoder refuses the input outright;
- `onnx-asr` in a virtual environment (onnxruntime was already installed).

Wiring it into GVoice means a new provider in the relay talking to a small local
Python server, plus its own start/stop and health handling – a day of work, not a
setting. The reward is the fastest option measured, fully offline, with Croatian
working.

## Files

Test clips, transcripts and scripts:
`/private/tmp/claude-501/-Users-macmini-dev-voice/cec1cd82-c2ef-4496-8002-1044580ff7a7/scratchpad/bench`
(scratch – copy anything worth keeping into this repo).
