# Speech engines measured on this Mac (2026-09-12)

Every number here was measured on this machine today, with each engine warm.
Nothing is quoted from a spec sheet.

This replaces the ten-clip run written earlier the same day, which asked for
exactly this rerun. That version is still in the repo history.

## What changed since the earlier run

- Thirty sentences instead of ten: 24 English (307 words), 6 Croatian (60 words).
- Three more local models measured: medium, large-v3-turbo, large-v3.
- Fifty of Drago's own recordings run through every engine.
- A second scoring pass that stops charging an engine for writing "90" when the
  sentence said "ninety".

That last one matters more than it sounds. See "The scoring trap" below.

## Test rig

Sentences spoken by macOS voices (Samantha for English, Lana for Croatian)
straight to file at 16 kHz mono, so every engine got byte-identical audio and
the spoken words are known.

Each whisper model got its own server with the flags a real dictation uses
(`-t 4 --no-fallback -fa`), warmed on one clip before the clock started, so no
model-load time is counted. Deepgram ran through the app's own
`transcribeWavFile` with the key the app resolves. Parakeet ran through
`onnx-asr` on onnxruntime 1.29 with CoreML.

## The scoring trap

The first pass said every big model made 18 English errors and the small one 22.
Reading the actual transcripts, most of those were not mistakes:

| spoken | written | charged |
|---|---|---|
| ninety seconds | 90 seconds | 1 error |
| two percent | 2% | 2 errors |
| 68 dollars | $68 | 2 errors |
| net thirty | net 30 | 1 error |
| seven seven three | 773 | 3 errors |

The pasted text says the same thing. Counting those buries the real differences,
because the big models normalise numbers far harder than the small one. The
"meaning" column below canonicalises both sides first. `scripts/bench/rescore.mjs`
does that pass and prints both figures.

## Results, clean clips

Literal is the raw word-level edit distance. Meaning is the same thing after
number formatting is normalised. Meaning is the honest column.

| engine | where | English literal | English meaning | Croatian meaning | median | slowest |
|---|---|---|---|---|---|---|
| whisper small.en q5_1 (what you run) | this Mac | 7.2% | 3.6% (11/307) | 101.7% | 460 ms | 473 ms |
| whisper medium q5_0 | this Mac | 5.9% | 2.6% (8/307) | 13.3% | 1,909 ms | 1,962 ms |
| whisper large-v3-turbo q5_0 | this Mac | 5.9% | **2.0% (6/307)** | 10.0% | 3,248 ms | 3,351 ms |
| whisper large-v3 q5_0 | this Mac | 5.9% | 2.3% (7/307) | 11.7% | 3,694 ms | 3,929 ms |
| deepgram nova-3 | cloud | 6.8% | 3.9% (12/307) | **1.7%** | **357 ms** | 969 ms |
| parakeet tdt 0.6b v3 | this Mac | 7.8% | 5.5% (17/307) | 6.7% | 392 ms | 1,497 ms |

Croatian median latency is worse for the cloud: 1,683 ms, slowest 2,261 ms.
Parakeet pays a one-time 4.5 s model load at startup, then holds it in memory.

Whisper's latency barely moves with clip length because whisper.cpp pads every
clip to thirty seconds. Deepgram and Parakeet scale with how long you spoke.

## The finding that decides this

Every English word the installed model got wrong was a name.

| spoken | what the live engine wrote |
|---|---|
| Purrify | Purify (twice) |
| Anker | anchor (twice) |
| PowerConf | power conf |
| Deepgram | Deep Gram |
| GVoice hotkey | G Voice Hot |

GVoice has a custom dictionary. It is empty: `custom-vocab.json` holds
`"terms": []`. Nobody has ever put a word in it.

**Correction, added after the dictionary was actually filled.** The table below
shows what a perfect name fix would buy. GVoice's dictionary does not deliver it.
Tested against the running app's own code, the four names fix none of these five
errors. See "Why the dictionary does not fix them" below. The rest of this
section is what the engines could do, not what they will do today.

Re-scoring with just those four names corrected:

| engine | English meaning, names fixed | median |
|---|---|---|
| whisper small.en q5_1 | **0.0% (0/307)** | 460 ms |
| whisper large-v3-turbo | 0.0% (0/307) | 3,248 ms |
| whisper large-v3 | 0.0% (0/307) | 3,694 ms |
| whisper medium | 0.3% (1/307) | 1,909 ms |
| deepgram nova-3 | 2.0% (6/307) | 357 ms |
| parakeet tdt 0.6b v3 | 2.6% (8/307) | 392 ms |

The model you already run, with four names typed in, transcribed all 307 English
words correctly. So did the model that takes seven times longer.

## Why the dictionary does not fix them

The four names are now in `custom-vocab.json`. Measured against the app's own
code, here is what they reach.

A saved term travels three roads, and all three are blocked for these five
errors:

1. **`vocab.correctTranscript`** repairs a garbled non-word. Verified working:
   "ankor" becomes Anker, "powerconff" becomes PowerConf, "gvoise" becomes
   GVoice. But it refuses to touch a word that is already real English, by
   design, and it works one word at a time. Every error measured was either a
   real word ("purify", "anchor") or a name split in two ("Deep Gram", "power
   conf", "G Voice Hot"). None qualifies.
2. **The cleanup pass** does get the terms, and the model does make the fix.
   Then `preservesSpeakerWords` throws it away and restores the wrong text,
   logging "Cleanup changed speaker wording". The guard that stops the AI
   rewriting your words cannot tell a name correction from a rewrite. This is
   the one that matters: the fix is made and then discarded, every time.
3. **Deepgram keyterms** work, but only on the Deepgram engine. You run
   whisper-local, so this road is closed.

There is also a smaller fault. "Purrify" already appears in `models/vocab.txt`,
and `correctTranscript` skips any term that is in that seed file. So adding
Purrify to the dictionary is a no-op even for a garbled spelling: "purrfy" stays
"purrfy". The other three names are not seeded and do work.

**Repaired the same evening, at Drago's word.** Road 2 is now open: a saved name
may stand in for the word or words it was misheard as. Verified end to end with
a real clip, the live small.en engine and his own dictionary file:

| whisper heard | GVoice now pastes |
|---|---|
| The anchor microphone keeps dropping out | The Anker microphone keeps dropping out |
| the tracking numbers for the Purify orders | the tracking numbers for the Purrify orders |
| The anchor power conf sits on the desk | The Anker PowerConf sits on the desk |

306 unit tests pass, 4 of them new and covering this. Road 1 was deliberately
left alone: it runs blind on every transcript with no model reading the context,
so loosening it would rewrite ordinary speech. The reasoning and the condition
that would reverse it are in `docs/context/decisions.md`.

This is built but not installed. `/Applications/GVoice.app` still runs the old
code until the new build replaces it.

## Results, Drago's own recordings

Fifty real dictations, converted to 16 kHz so every engine saw the same input.
Nobody knows the exact words, so nothing is scored. Twenty-one clips carry real
speech. Twenty-nine are failed recordings: room noise, a bang, music, silence.

| engine | words found on the 21 real clips | invented a sentence on a failed clip | median |
|---|---|---|---|
| whisper large-v3-turbo | 174 | 8 of 29 | 3,165 ms |
| whisper large-v3 | 167 | 11 of 29 | 3,599 ms |
| deepgram nova-3 | 144 | 0 of 29 | 334 ms |
| whisper medium | 140 | 7 of 29 | 1,854 ms |
| whisper small.en q5_1 | 134 | 0 of 29 | 410 ms |
| parakeet tdt 0.6b v3 | 126 | 0 of 29 | 168 ms |

The earlier note said every engine heard nothing on the failed clips. That holds
for the small model, the cloud and Parakeet. The big models do not stay quiet.
They invent:

| what was on the tape | large-v3 wrote | small.en wrote |
|---|---|---|
| room noise | "Thank you for watching." | [BLANK_AUDIO] |
| room noise | "Kör på de fleste styrken." | [SOUND] |
| music | "It's coming off the soil of the earth." | [MUSIC] |
| applause | "It seems to have been a good time." | [Applause] |

That is whisper repeating the YouTube captions it was trained on. For a tool
that pastes straight into whatever window is in front, a confident fake sentence
is worse than nothing.

The big models do also recover real speech the small one truncates. Three cases
were genuine, confirmed because the cloud engine heard the same words:

| small.en wrote | large-v3-turbo wrote | deepgram agreed |
|---|---|---|
| "wheelchair intermittently." | "wheelchair intermittently she's not" | yes |
| "You should test yourself." | "You should test yourself on this if you're sounding" | yes |
| [BANG!] [Inaudible] | "It doesn't exist yet. It's slowing down to" | yes |

So on real microphone audio turbo rescues about three clips and fabricates on
about three others. That is not a win.

## Outliers worth knowing

- **Croatian on the installed model is not weak, it is dangerous.** It does not
  just garble. It writes fluent English that was never said: "We will continue
  to learn the language of God" for "molim te pošalji ponudu do petka jer klijent
  čeka odgovor". The app is set to `WHISPER_LANGUAGE=auto` with an English-only
  model, so Croatian has nowhere to go.
- **Deepgram mangled a number once**: "order number is 4800And21" for 4821. No
  other engine did.
- **Parakeet is the weakest on real audio.** It answered "Yeah." and "That's
  fantastic." to clips where five other engines heard "Testing one two three".
  Its 168 ms median is the fastest measured, and it is the only engine that
  never invented on a failed clip, but it drops real words.
- **Nothing separates the engines on ordinary English words.** Once names are
  out, the spread across all six is 0.0% to 2.6%, on 307 words. Six wrong words
  is the whole range.

## Recommendation

Keep the model you already run. Then repair the dictionary, because it is broken.

The engine trade-off in plain terms: moving from small.en to large-v3-turbo
costs about 2,790 extra milliseconds on every single dictation, nearly three
seconds of waiting after you let go of the key, and buys five fewer wrong words
out of 307. On a sample this size that gap is noise. Moving to medium costs
about 1,450 ms for three fewer wrong words, also noise. On your own recordings
the bigger models start writing sentences you never said, on eight of
twenty-nine failed clips. No model in this table is worth the wait.

That leaves names, which are the whole of the remaining error, and the
dictionary is the right tool that currently does not work. The fix is made and
then discarded by a guard. Repairing that is a small, contained change to one
function, and it would take English from six wrong words to zero without costing
a single millisecond. It is the only change in this whole report that buys
anything.

The one thing no dictionary fixes is Croatian. The installed model cannot do it
and never will, because it is English-only. Drago confirmed on 2026-09-12 that
he does not dictate Croatian, so this stays a note, not a decision.

## What switching costs

- **Another whisper model**: one setting. The app reads `WHISPER_MODEL` and
  falls back to `models/ggml-small.en-q5_1.bin`. Point it at a different file in
  `models/` and restart. All four models are downloaded and verified byte for
  byte. Minutes.
- **Deepgram**: already built, already keyed. One setting, `STT_PROVIDER`. Your
  audio leaves the machine.
- **Parakeet**: not built. It needs a new provider in the relay talking to a
  local Python server, plus that server's lifecycle, health and restart handling.
  A day of work, for an engine that came last on your real recordings.

## Caveats

- 307 English words and 60 Croatian is still a thin sample. Any English gap under
  roughly 3 points here means nothing, and after the dictionary fix every gap is
  under 3 points.
- The clean clips are synthetic speech, not Drago's voice. They measure the
  engine, not the microphone. The real-recording section is the one that speaks
  to his actual setup, and it is unscored by necessity.
- Twenty-nine of fifty real recordings carried no usable speech. All six engines
  agree on that, cloud included. The microphone and the room broke those
  dictations, not the model. That is worth more attention than any engine choice
  in this report.

## What was left on the machine (2026-09-12)

Drago answered both questions the same evening: he does not dictate Croatian,
and yes to filling the dictionary.

- Kept: `models/ggml-small.en-q5_1.bin` (181 MB), the live engine, and
  `models/ggml-large-v3-turbo-q5_0.bin` (547 MB), the one that scored best, kept
  on purpose for a second look.
- Deleted at his word: `ggml-large-v3-q5_0.bin` (1.0 GB),
  `ggml-medium-q5_0.bin` (514 MB), `~/models/parakeet-tdt-0.6b-v3-int8` (640 MB)
  and `~/venv-parakeet` (20 MB). About 2.2 GB freed, 11 GB to 13 GB.
- Every deleted file is re-downloadable. The whisper addresses and the Parakeet
  repo `istupakov/parakeet-tdt-0.6b-v3-onnx` all answered on the day.
- Added to `custom-vocab.json`: Purrify, Anker, PowerConf, GVoice. Purrify is
  inert for the reason above.

Note for a future run: the published Parakeet bundle now ships its own
`config.json` with the right 128 mel bins. The hand-written file the old notes
called for is no longer needed.

## Raw results

- `docs/reports/data/engine-benchmark-2026-09-12-clean.json`
- `docs/reports/data/engine-benchmark-2026-09-12-real.json`
