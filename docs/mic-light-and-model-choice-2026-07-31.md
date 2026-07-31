# Mic light + bigger speech models — what was built and what was seen

Date: 2026-07-31. Branch: `main`. Not pushed.

## 1. The microphone light

**Change (already committed earlier today):** the mic opens on key-down, keeps
capturing for 1s after key-up (`TAIL_MS = 1000` in `public/dictation.js`) so the
final word is not clipped, then closes. `MIC_IDLE_MINUTES` / `MIC_ALWAYS_ON` are
gone; `COLD_MIC` is hard-coded `true`.

**Verified on the built app** (`dist/mac-arm64/GVoice.app`, launched directly,
not the copy in `/Applications`). Measurement was CoreAudio's
`kAudioDevicePropertyDeviceIsRunningSomewhere` on every input device — that is
exactly the condition macOS uses to light the orange dot. A tiny Swift probe
sampled it around a simulated right-Option hold:

| moment | input device running |
|---|---|
| app idle, just launched | no |
| during the 3s hold | yes (MacBook Air Microphone) |
| at key release | yes |
| +0.5s after release | yes |
| +1.7s after release | **no** |
| +3.7s after release | no |

Also confirmed the menu-bar click-to-talk toggle releases the mic when clicked a
second time.

## 2. Medium and large models in Settings

`src/model-download.js` `MODELS` now carries five entries, each with the wording
the dropdown shows (`label`), so the list has one source of truth instead of a
hand-synced copy in the HTML:

| file | size | label |
|---|---|---|
| `ggml-base-q5_1.bin` | 57 MB | Base — smallest and fastest |
| `ggml-small-q5_1.bin` | 182 MB | Small — more accurate |
| `ggml-medium-q5_0.bin` | 514 MB | Medium — more accurate again |
| `ggml-large-v3-turbo-q5_0.bin` | 547 MB | Large turbo — near-best accuracy, still quick |
| `ggml-large-v3-q5_0.bin` | 1031 MB | Large — the most accurate, the slowest |

All five URLs were checked against HuggingFace (HTTP 200 + real
`content-length`) before being added.

`public/settings.html` builds the dropdown from that list at probe time. Adding
a sixth model is now a one-line change in `MODELS`.

Turbo was added unasked: it is the large-v3 encoder with a shrunken decoder —
close to large accuracy at roughly small-model speed, and half the download of
plain large. It is the better default for dictation than plain large.

**Verified on the built app:** all five entries appear in the dropdown, Medium
was selected, the speed test downloaded the 514 MB file, started
`whisper-server` on it, and transcribed the test clip in **3.0s** — vs ~0.7s for
the cloud engine, so the app recommended keeping cloud. Nothing was switched;
the engine setting is untouched.

## 3. Supporting fixes

- `src/providers/whisper-local.js`: `waitForServer` raised from 10s to 60s. A
  1 GB large-v3 model has to be read off disk and pushed to the GPU before the
  server answers; 10s does not cover that cold.
- `public/settings.html`: the dropdown now shows an off-list `WHISPER_MODEL`
  (a hand-edited path, or the bundled `ggml-small.en-q5_1.bin`) so the user can
  see what is in use, but `chosenModelName()` never *sends* an off-list name —
  `engine:apply` only accepts allow-listed names and would otherwise reject the
  whole apply with "Unknown speech model."

## 4. Known ceiling, not fixed

`transcribePcm` posts two forced-language legs (en + hr) per clip and
whisper-server serializes inference, so the second leg waits behind the first.
Each POST has a 15s abort (`whisper-local.js`, `AbortSignal.timeout(15000)`).
The renderer's own watchdog fires at 20s (`DICTATION_FAILURE_MS`), so raising
the 15s alone buys nothing. On large-v3 a long dictation can therefore hit the
watchdog and fall back rather than return text. Medium measured 3.0s on a short
clip here, so this only bites on large + long holds. Fixing it means scaling
both numbers with the model, which is a bigger change than this task.

## 5. Environment note

The installed `/Applications/GVoice.app` was quit during testing so the fresh
build could take the menu bar. The dev build from `dist/mac-arm64/` was
relaunched afterwards and left running.

## Checks

`node --test scripts/unit/*.test.js` — 152 pass, 0 fail.
