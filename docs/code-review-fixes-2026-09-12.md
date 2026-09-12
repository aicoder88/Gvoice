# Review fixes, 2026-09-12

Commit 7cabfe6. Not pushed.

## What was fixed, and the proof

| # | Fault | Old code | New code |
|---|-------|----------|----------|
| 1 | Quick second press lost the first sentence | not typed, history "superseded" | typed, "verified" |
| 2 | Cancel just before the paste | clipboard overwritten, "Click Copy – the paste didn't land" | clipboard kept, "Cancelled – nothing pasted" |
| 3 | Cancel during the empty-transcript retry | cancel ignored, recovered words typed | cancel heard, nothing typed |
| 4 | Coding tidy-up with spoken symbols | "dash dash force" rejected | "--force" kept |
| 5 | Mic pick while the list loads | pick lost ("always") | pick saved ("hold", Fake Audio Input 1) |

Races 1-3: `node scripts/electron/delivery-races.mjs` on the real app, run against both versions.
Fault 5: settings panel driven in the real app, both versions.
Fault 4: unit tests plus a live Groq call with the Coding profile.
Also passing: desktop regression (`GVOICE_TEST_MODEL=models/ggml-small.en-q5_1.bin`), 414 unit tests, parity.

## My own faults, worst first

1. Race 1 used test presses, not a held right Option key. The first sentence now pastes while the key is down. System Events may read that as Option+Cmd+V. Needs one real hand test.
2. The live tidy-up model still wrote "main dot js" and "john at example dot com" as spoken. The guard no longer blocks the change, but the model often doesn't make it.
3. The guard is slightly looser: a real "at" or "dot" can drop when an email or file name sits in the same sentence. Joined words ("every day" to "everyday") also pass now.
4. If a second dictation finishes before the first one's tidy-up, the two paste in swapped order. Rare; not handled.
5. The installed app in `dist/` was not rebuilt. Checks ran on the development copy.
6. The regression's default Whisper model file is missing from `models/`; I pointed it at the small English model.
