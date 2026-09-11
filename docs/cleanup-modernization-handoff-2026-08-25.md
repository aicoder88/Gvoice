# GVoice cleanup modernization handoff

Date: 25 August 2026

## Bottom line

GVoice now uses Groq GPT-OSS 120B as its free cleanup choice. The retired Groq names no longer break old installations. Cleanup asks for lighter punctuation, rejects wording changes, keeps number words intact, treats only explicit sequences as lists, and reports free minute and daily ceilings accurately.

The signed 292 MB app is installed and running from `/Applications/GVoice.app`. The older 292 MB copy is recoverable at `/Users/macmini/.Trash/GVoice-before-cleanup-update-2026-08-25.app`.

## What changed

1. Replaced both removed Groq choices with `openai/gpt-oss-120b`.
2. Automatically ignores either retired Groq name in an existing private settings file.
3. Prevents a built-in Groq model name from following the user into OpenAI, and vice versa.
4. Replaced the former 1,315-word instruction with a compact, conservative instruction.
5. Removed semicolons and dashes from the requested style. Chose light commas, consistent final-list commas, and explicit commas before English `but` and Croatian `ali` only when they join thoughts.
6. Keeps `like`, `you know`, `sort of`, `okay`, and `so`. Removes only clear filler sounds and repeated stutters.
7. Keeps spoken number words as words. Spoken corrections and explicit three-item sequences have focused examples.
8. Added a local safety check. It rejects added, replaced, translated, reordered, or silently dropped words. Approved dictionary spelling fixes remain allowed.
9. When that safety check rejects a result, GVoice applies only local trimming, first-letter capitalization, and final punctuation.
10. Added separate warnings for the free minute ceiling and the free daily ceiling. Raw speech always survives.
11. Added a repeat setting so identical input is more consistent.
12. Updated the live Settings label and both private settings files to the new free choice.

## Measured cleanup result

- The existing 13-case live behavior check passed 13 of 13. Average wait: 560 ms.
- A complete 40-case, three-try run passed 39 of 40. The slowest 5% took 754 ms. The only miss was an optional comma in mixed Croatian and English.
- The rule added for that comma passed its focused repeats.
- Grocery prose and customer prose each repeated identically across ten focused tries after their final style rules. Slowest runs: 545 ms and 540 ms.
- Correction, list-wrap, Croatian, and mixed-language fixes passed focused repeats.
- The final uninterrupted 120-call run could not finish. Repeated tuning exhausted Groq's 200,000-piece daily free allowance after 17 final cases. Every later call preserved the original sentence and showed a daily-reset warning.
- The reusable set contains 15 prose cases, 8 questions or commands, 6 corrections, 5 numbered lists, 3 Croatian cases, and 3 mixed-language cases.
- These examples are representative but synthetic. They are not honestly owner-approved until the owner reviews the punctuation.

Detailed quality status: `/Users/macmini/dev/voice/docs/cleanup-quality-results-2026-08-25.html`

## Speech comparison

Compared all 25 saved recordings that still exist, totaling 9.43 audio minutes.

| Choice | Middle wait | Slowest 5% | Similarity to saved history |
|---|---:|---:|---:|
| Current on-device Whisper | 690 ms | 1,550 ms | 96.0% |
| Deepgram Nova 3 | 1,483 ms | 3,641 ms | 87.7% |

The engines agreed by 91.7% on average. Saved history came from the earlier on-device path, so that similarity is biased and is not human ground truth. Deepgram showed no measurable reason to accept more than double the wait. The app therefore keeps the on-device speech choice.

The private listen-and-compare page is at `/Users/macmini/Library/Application Support/GVoice/transcription-comparison-2026-08-25.html`. It contains private speech and stays outside the project.

OpenAI transcription was not compared. OpenAI refused the saved credential. The wider live check confirms that only the OpenAI speech path fails; local Whisper and Deepgram work.

## Checks completed

- 177 focused checks pass.
- A simulated 100-call free-limit burst preserves all 100 sentences and reports every failure.
- Local Whisper and Deepgram complete their real speech checks.
- The 25-recording comparison completed without errors.
- The signed app passes macOS signature verification.
- The installed app and the verified package have the same SHA-256 value: `780195a9d5e119b9c7f90492731f04cb7cc4c7592b2f40fd80a1be3a1784a14c`.
- The installed app launched from `/Applications/GVoice.app` and listened only on the local computer.
- The running app served the Settings page titled `GVoice settings`.
- The running Settings page visibly selected `Groq · GPT-OSS 120B (free, default)`.
- The menu-bar icon was visible in the running desktop app.

## Flaws found in the final self-review

Worst first:

1. The final 40-by-three run is incomplete because today's free daily allowance was exhausted. The earlier complete result plus focused reruns are strong evidence, but they are not one clean final run.
2. The recoverable old app consumes 292 MB in Trash. It was kept intentionally rather than deleted.
3. The 40 punctuation examples need the owner's taste approval.
4. Speech accuracy remains unproven without a human-written answer for each recording. The comparison supports keeping the faster current choice, not claiming perfect accuracy.
5. OpenAI speech remains unavailable until its saved credential is replaced. This does not affect the selected free cleanup or on-device speech.

## Files changed

- `/Users/macmini/dev/voice/src/cleanup.js`
- `/Users/macmini/dev/voice/public/settings.html`
- `/Users/macmini/dev/voice/scripts/cleanup-test.js`
- `/Users/macmini/dev/voice/scripts/cleanup-quality-test.js`
- `/Users/macmini/dev/voice/scripts/fixtures/cleanup-quality-cases.js`
- `/Users/macmini/dev/voice/scripts/compare-transcribers.js`
- `/Users/macmini/dev/voice/scripts/unit/cleanup-preservation.test.js`
- `/Users/macmini/dev/voice/scripts/unit/cleanup-error-report.test.js`
- `/Users/macmini/dev/voice/.env.example`
- `/Users/macmini/dev/voice/SETUP.md`
- `/Users/macmini/dev/voice/docs/ARCHITECTURE.md`
- `/Users/macmini/dev/voice/package.json`
- Private settings: `/Users/macmini/dev/voice/.env`
- Private installed-app settings: `/Users/macmini/Library/Application Support/GVoice/.env`

No saved recordings, history, credentials, or unrelated work were removed or moved. Only the approved old app was moved to Trash during installation.
