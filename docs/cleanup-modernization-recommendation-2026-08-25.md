# GVoice cleanup modernization recommendation

Date: 25 August 2026

## Bottom line

Use GPT-5.6 Luna as the main text tidy-up choice. Use Groq's `openai/gpt-oss-120b` as the free backup. Replace the oversized instructions with a short, conservative version. Add a safety check that rejects changed wording. Check both choices when the app starts, so a removed model cannot silently break every dictation again.

This is the best balance of polish, speed, cost, and predictable behavior. The paid choice should cost well under $1 for 1,000 typical tidy-ups. That is cheaper than spending even ten minutes correcting bad punctuation.

Confidence: high on the diagnosis and design. Moderate on GPT-5.6 Luna's exact speed in this app because the saved OpenAI credential was refused, so I could not run a live comparison.

## What is broken now

1. The selected Groq model no longer exists.

   The private settings select `meta-llama/llama-4-scout-17b-16e-instruct`. A live request returned “model not found.” The app handed back the untouched sentence in 177 milliseconds. This explains missing punctuation.

2. The supposed backup is gone too.

   [The built-in Groq choice](/Users/macmini/dev/voice/src/cleanup.js:34) is `llama-3.3-70b-versatile`. The live Groq account no longer lists that model either. The accessible general text choices are now `openai/gpt-oss-20b`, `openai/gpt-oss-120b`, and `qwen/qwen3.6-27b`.

3. Settings cannot repair the problem.

   [The Settings screen](/Users/macmini/dev/voice/public/settings.html:203) still advertises the removed Llama 4 Scout choice. Changing from Groq to OpenAI keeps one shared model name. The app would therefore ask OpenAI for a Groq-only model and fail again. Model names need to belong to each provider separately.

4. The OpenAI credential is not accepted.

   The app has a saved value in the OpenAI field, but OpenAI refused it. No secret is copied into this report. A valid paid credential is required before GPT-5.6 Luna can become the main choice.

5. The cleanup instructions cause both slowness and over-punctuation.

   [The current instructions](/Users/macmini/dev/voice/src/cleanup.js:54) are 8,040 characters and 1,315 words before the dictated sentence is added. They explicitly invite semicolons and long dashes. That directly conflicts with the request for natural, light punctuation.

   One existing cleanup call sends roughly 1,800 to 2,200 input pieces. The long instructions also consume the free Groq allowance after only a few rapid dictations.

6. The quality checks reward lists more than natural prose.

   [The live comparison file](/Users/macmini/dev/voice/scripts/cleanup-test.js:4) has 14 examples. It covers lists, fillers, instruction attacks, and spoken corrections. It does not measure comma density, sentence rhythm, Croatian text, or the owner's actual punctuation preference. A model can pass those examples and still feel wonky in daily use.

## Measured choices available today

These are single-sentence checks, not a full quality contest. They are enough to reject weak or slow choices, but not enough to crown a final winner without real dictations.

| Choice | Current instructions | Short instructions | Finding |
|---|---:|---:|---|
| Removed Llama 4 Scout | 177 ms | Not available | Failed. Returned raw text. |
| Groq GPT-OSS 20B | 2,068 ms | 286 ms | Very fast when shortened, but dropped meaningful words. Do not make it the main choice. |
| Groq Qwen 3.6 27B | Over 2,500 ms | Not measured | Missed the app's wait limit. Reject for this job. |
| Groq GPT-OSS 120B | 2,383 ms | 674 ms | Best available free backup. Preserved the sample well. |
| OpenAI GPT-5.6 Luna | Could not run | Could not run | Best documented fit for high-volume, cost-sensitive text work. Needs a valid credential. |

The speed improvement came mainly from shortening the instructions. The model did not change between the 2,383 ms and 674 ms GPT-OSS 120B checks.

## Recommended design

### 1. Make GPT-5.6 Luna the main cleanup choice

Use `gpt-5.6-luna` with no extra reasoning. This job is controlled formatting, not deep analysis. OpenAI describes Luna as its cost-sensitive, high-volume choice. Its published price is $0.20 per million input pieces and $1.20 per million output pieces. [Official GPT-5.6 Luna details](https://developers.openai.com/api/docs/models/gpt-5.6-luna)

Do not use GPT-5.6 Sol or Terra here. Their extra intelligence buys little for punctuation while raising cost and likely delay.

Estimated cleanup cost with the present long instructions:

- Roughly $0.42 to $0.62 per 1,000 tidy-ups.
- A shorter instruction should reduce that further, likely below $0.30 per 1,000.
- Actual cost depends on dictated length. Measure it in the app after launch.

### 2. Keep Groq GPT-OSS 120B as the free backup

Use `openai/gpt-oss-120b`, with low reasoning, only when Luna is unavailable or the user deliberately chooses free mode. It returned a good sample in 674 ms with shorter instructions.

Do not silently choose any newly listed Groq model. First compare it against the saved examples. An available model is not necessarily a suitable model.

### 3. Cut the cleanup instructions by about 75 percent

The new instruction should say only:

> Format dictated text. Return only the finished text. Keep every spoken word in order, except fillers and words explicitly replaced by a spoken correction. Never rewrite. Add minimal natural punctuation and capitalization. Avoid semicolons and dashes. Keep one paragraph unless the topic clearly changes. Turn only an explicit numbered sequence into a numbered list. Preserve the original language. When unsure, change less.

Keep four or five examples only where wording alone is ambiguous. The current page of list examples is over-training the model toward lists and heavy structure.

### 4. Reject polished text that changes the speaker's words

Compare the proposed result with the raw transcript after removing case and punctuation. Permit only:

- known filler removal;
- repeated-word removal;
- explicit spoken corrections;
- dictionary spelling fixes;
- removal of spoken list markers when they become visible list numbers.

If the result adds, replaces, or rearranges other words, reject it. Paste the raw sentence with simple capitalization and a final period. This prevents a result that looks polished but says something the speaker did not say.

### 5. Separate each provider's model choice

Store one model for OpenAI and one for Groq. Changing provider must select that provider's default. It must never carry a Groq model name into OpenAI.

When the app starts:

- confirm the chosen model exists;
- confirm the credential is accepted;
- move to the approved backup if the main choice is unavailable;
- show one plain warning if neither works;
- never hide the raw dictation.

This fixes the actual failure pattern instead of merely picking another model that may disappear later.

### 6. Compare speech recognition separately

Keep the current speech engine during the cleanup repair. Changing recognition and cleanup at once would hide which change helped.

Then compare 30 to 50 saved voice clips across:

- the current local Whisper choice;
- the existing Deepgram Nova 3 choice;
- OpenAI `gpt-transcribe` for higher accuracy.

OpenAI recommends `gpt-transcribe` for recorded speech. It accepts keyword and language hints, including more than one expected language. Its listed price is $0.0045 per audio minute. [Official transcription guide](https://developers.openai.com/api/docs/guides/speech-to-text) and [official model details](https://developers.openai.com/api/docs/models/gpt-transcribe)

For live text appearing while the user speaks, OpenAI now recommends `gpt-live-transcribe`. It costs $0.017 per audio minute. GVoice only needs the finished text after key release, so the cheaper high-accuracy choice deserves the first trial. [Official live transcription details](https://developers.openai.com/api/docs/models/gpt-live-transcribe)

## Quality gate before release

Create 40 owner-approved examples from real use:

- 15 ordinary prose dictations;
- 8 questions and commands;
- 6 spoken corrections;
- 5 real numbered lists;
- 3 Croatian examples;
- 3 mixed Croatian and English examples.

Score every candidate on:

- no added or changed words;
- punctuation that the owner accepts without editing;
- no needless lists or paragraph breaks;
- correct correction removal;
- response under 1,200 ms for at least 95 percent of tidy-ups;
- no silent failures across 100 rapid requests.

Run each example three times. A model that changes its punctuation between runs should not become the default.

## Suggested delivery order

1. Same day, 30 to 60 minutes: remove the two dead Groq names, repair provider-specific model selection, update Settings text, and add a startup check.
2. Same day, 2 to 4 hours: shorten the instructions, add word-preservation checks, add GPT-5.6 Luna, and keep GPT-OSS 120B as backup.
3. Next half-day: build the 40 real examples and tune punctuation against the owner's preferred outputs.
4. Later half-day: compare the three speech choices on the same saved audio. Change recognition only if it wins on measured accuracy and total wait time.

Expected total: one focused day for the cleanup repair, plus half a day for the speech comparison.

## What I would not do

- Do not chase the largest model. Formatting does not need it.
- Do not keep the present 1,315-word instruction and merely swap the model.
- Do not trust a free model name to remain available.
- Do not automatically adopt whichever model appears newest.
- Do not change speech recognition and cleanup in the same release.
- Do not train a custom model yet. Forty strong examples and a short instruction should solve this first.

## Weaknesses in this recommendation

Worst first:

1. I could not measure GPT-5.6 Luna because OpenAI refused the saved credential. The price and intended use are verified from official OpenAI documentation. Its exact speed and punctuation style remain unverified in GVoice.
2. The Groq timings use one representative sentence on one network connection. Treat them as screening results, not promises.
3. I did not judge the recognizers against real owner audio. The speech-engine recommendation is therefore a comparison plan, not a final switch.
4. I did not change the app. This report answers the requested recommendation only.

## Evidence checked

- The live Groq account's accessible model list on 25 August 2026.
- A live failure using the app's selected cleanup choice.
- One live comparison of three accessible Groq choices with the current instructions.
- One live comparison of GPT-OSS 20B and 120B with short instructions.
- [Cleanup behavior](/Users/macmini/dev/voice/src/cleanup.js:237), [cleanup routing](/Users/macmini/dev/voice/main.js:1198), [Settings behavior](/Users/macmini/dev/voice/src/settings.js:143), and [existing quality examples](/Users/macmini/dev/voice/scripts/cleanup-test.js:4).
- [Official OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model), [GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna), [GPT Transcribe](https://developers.openai.com/api/docs/models/gpt-transcribe), and [GPT Live Transcribe](https://developers.openai.com/api/docs/models/gpt-live-transcribe).
