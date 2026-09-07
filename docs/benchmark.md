# Personal speech benchmark

Open **Personal speech benchmark** from the GVoice tray menu. The corpus starts empty. No history, existing recordings, clipboard text or provider responses are imported automatically. Importing audio or results invokes no model. The explicit local-run button processes approved WAV clips with your installed Whisper engine, without sending audio over a network.

1. Select **Add one recording**, choose a file, and confirm keeping a local copy of that specific recording. Supported audio: WAV, MP3, M4A, OGG, WebM, at most 20 MB per file and 100 clips. Prefer short clips. Listening support depends on Electron's audio codecs.
2. Load and listen to the audio. Write a human reference of what the transcript should say, up to 2,000 characters. Preserve meaningful numbers, negation and intended self-corrections. Add an optional English translation for reviewers; translation is never used for scoring.
3. Tag the clip Croatian, English, mixed, brand, numbers, negation, self-correction or noise. Enter protected names or phrases separated by commas.
4. Save, then explicitly choose **I reviewed this reference - approve for scoring**. Saving any later edit revokes approval and removes earlier results for that clip, so stale references cannot silently change a score.
5. Choose **Run local Whisper on approved clips** to use the existing configured local engine and model (or the installed base model), without a terminal or downloads. WAV clips are required for local runs. Cancel local run or close the window to stop. The overall run is limited to ten minutes. Alternatively, run an engine locally or import already obtained results in the format below. Import never invokes cloud APIs. Human review values in imported JSON are ignored; all imported results begin pending review.
6. Inspect each reference/output pair and record whether meaning was preserved or changed, with notes. Heuristic flags are reminders, never a semantic verdict or a model-switching decision.

The corpus and copied audio live under Electron's user data directory in `benchmark/` (`~/Library/Application Support/GVoice/benchmark` on a typical packaged macOS installation; development naming may differ). `corpus.json` is saved by atomic rename, and the app creates its store with private directory permissions. **Remove local copy** deletes the benchmark audio copy, reference and associated results; the original file stays where you selected it. Export includes reference text and results, not audio data. Keep exports where you intend to keep your speech transcripts.

## Result format

Export the corpus or read the clip ID and `referenceRevision` shown in the window. Every result must match an approved clip's current revision. A results file is a JSON array or an object with a `results` array (1-500 rows, maximum 2 MB):

```json
{
  "results": [
    {
      "clipId": "copy-the-approved-clip-id-here",
      "referenceRevision": 2,
      "engine": "whisper.cpp/model-name",
      "cleanupModel": "none",
      "runLabel": "local CLI cold, includes model loading",
      "output": "The actual output of this engine and cleanup combination.",
      "elapsedMs": 430
    }
  ]
}
```

These are schema placeholders, not real recordings or measured results. `elapsedMs` must describe the total engine-plus-cleanup wall time under the conditions in `runLabel`. Use `none` when no cleanup ran. To compare cleanup models, import separate actual outputs and timings per combination. This MVP does not call cleanup providers; you must obtain those results through a separately authorized evaluation. Never replace an observed output with the reference.

## Offline whisper.cpp runner

Use your already installed `whisper-cli` and an already downloaded local model. No model is downloaded and no relay/provider environment or app selection is changed. The runner invokes the same whisper.cpp CLI flags as the existing local provider fallback, directly, without using its potentially remote server URL. Only approved clips are run. References and protected terms are never fed into the model as hints.

```sh
node scripts/benchmark/run-local.mjs '/path/to/GVoice/benchmark' '/path/to/whisper-cli' '/path/to/model.bin' '/path/to/new-results.json'
node scripts/benchmark/compare.mjs '/path/to/GVoice/benchmark' '/path/to/new-results.json'
```

The local runner requires WAV recordings accepted by your whisper.cpp build (16-bit PCM mono 16 kHz is a safe choice). Convert unsupported audio locally yourself and re-import it explicitly. All approved clips are checked for WAV headers before running. Each clip has a 180-second timeout; if any clip fails, no partial result file is published. The runner's cold process times include model loading on each clip. They are not the app's warm streaming latency. Hardware, audio duration, model version and thermal state affect results. Run repeated trials with clear labels if studying timing variance.

The compare CLI is read-only and prints JSON with aggregate and per-clip scores. Import the actual result file into GVoice to persist comparisons and human semantic reviews. Existing output files are never overwritten by the runner.

## Reading the scores

WER is total word edit distance divided by total reference word count. CER uses the same calculation over normalized characters including inter-word spaces. Unicode letters and digits are preserved; text is case-normalized and most punctuation removed. Croatian diacritics remain distinct. Insertions can make WER exceed 100%. These conventions differ from some published benchmarks.

The comparison groups by engine, cleanup model and run label. Coverage shows distinct clips and result count; hover over coverage to see exact clip IDs. Compare identical clip sets and timing conditions. Repeated outputs count as repeated observations unless every identity field is identical. Different coverage or unequal repetitions prevents a fair ranking; the app deliberately does not choose a winner.

Meaning-risk flags compare numeral tokens, a limited English/Croatian number-word vocabulary, a limited English/Croatian negation vocabulary, and protected phrase occurrence counts. Unrecognized number forms, rephrasing, grammar and context can defeat these rules or produce false alarms. Human review counts and meaning-changed counts stay separate from WER/CER. Do not treat absence of flags as proof that meaning survived.

## Optional recording prompts

These are prompts only. No recording or human approval is bundled.

- English, brand, numbers: “Send 12 Purrify bags to Zagreb on Friday.”
- Croatian, negation, numbers: “Nemoj poslati 12 vrećica; pošalji samo dvije.”

  ---

  English translation: “Do not send 12 bags; send only two.”
- Mixed, brand: “Pošalji Purrify order confirmation today.”

  ---

  English translation: “Send the Purrify order confirmation today.”
- Self-correction: “Book Tuesday, sorry, Thursday at 14:30.”
- Noise: record one of your own short phrases in ordinary background noise, with the consent of anyone whose speech is captured.

## Verification

`node --test scripts/unit/benchmark-personal.test.js` checks consent and approval gates, stale-result rejection, persistence, exact metric cases, numeric/negation/protected-term flags, and imported-review isolation. Electron verification should use an isolated user-data folder and a synthetic fixture, never claim that the user's real speech corpus has been collected, and test audio import/cancel, approval, comparison and restart persistence through the running window.
