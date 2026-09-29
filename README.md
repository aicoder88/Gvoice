# GVoice

Push-to-talk dictation for your whole computer. Hold a key, speak, release — the words type themselves into whatever text field you're in: Slack, your editor, a browser box, anything.

GVoice is a small menu-bar/tray app built on Electron. Your speech goes to a speech-to-text engine of your choice, an optional cleanup pass tidies up the punctuation and filler, and the result is pasted into the focused app. Your API keys stay on a local relay, never in a browser.

## Quick start

```bash
pnpm install
cp .env.example .env   # then add your API key(s)
pnpm start
```

The app lives in the menu bar (macOS) or system tray (Windows). Hold **right Option** (macOS) or **Ctrl+Shift** (Windows, either side), speak, and release. On macOS, holding **left Ctrl+Cmd** works too, and so does the **mouse back button** — with the Better Options companion running, the button talks to GVoice directly over a local socket instead of faking a key chord. Tap **right Ctrl** to cycle the dictation language (Auto → Croatian → English), or **Escape** to cancel a dictation without pasting it. If the focused window changes mid-dictation, GVoice leaves the words on the clipboard with a "Ready to copy" pill instead of pasting into the wrong app — the tray's **Copy last result** gets them back any time after. Full setup — including the local, no-API-cost Whisper option — is in [SETUP.md](SETUP.md).

First launch with no API key set? GVoice opens its **Settings** window so you can pick an engine and paste a key — no hand-editing files. You can reopen it any time from the tray (**Settings…**).

## Speech engines

Pick one with `STT_PROVIDER` in `.env`:

- **`deepgram`** — fast cloud transcription. Works with no setup: a shared key ships with the app. Set `DEEPGRAM_API_KEY` to use your own.
- **`whisper-local`** — runs entirely on your machine, no per-clip cost (needs whisper.cpp binaries + a model; see SETUP.md). One setup script per platform: `./scripts/setup-whisper-mac.sh` (Homebrew) or `scripts\setup-whisper-windows.ps1`. On Windows the Settings window can also do it for you: it downloads the engine and a model, runs a speed test on your actual hardware, and only suggests keeping local if it's fast enough.
- **`openai`** — OpenAI's realtime transcription (needs `OPENAI_API_KEY`).

## Custom dictionary

GVoice keeps a list of names and made-up words it should spell exactly. How it applies them depends on the engine: for the local Whisper engine the terms are fixed up *after* transcription (a near-miss like "Cloud" is corrected to your saved "Claud"); for the cloud engines (Deepgram keyterm boosting, OpenAI's prompt) they bias recognition up front. Whisper used to be biased up front too, but that made it hallucinate rare words onto unrelated audio (e.g. "a US price" → "a Unsplash price"), so the local path now corrects after the fact instead.

Two ways to fill it:

- **Add them yourself.** Tray menu → **Manage dictionary…** opens a window where you type in your brands, people, and coined terms. This is the reliable way to fix words the engine mishears. Keep entries to genuinely unusual proper nouns — a term that's one letter from an everyday word (e.g. "Stripe" vs "strip") can get over-applied.
- **Let it suggest.** After a dictation, if GVoice spots an unusual name it typed — or notices you hand-fixing a word it got wrong — a small pop-up appears next to your cursor offering to remember it. You're asked once per word; "No thanks" is remembered for good.

## How it works

```
Hotkey held (right Option / Ctrl+Shift)
        │
        ▼
   main.js (Electron)  ──IPC──▶  dictation window (hidden)
        │ shows pill                    │ opens mic, streams audio
        │                               ▼
        │            ws://localhost:<port>/realtime  ──▶  relay  ──▶  speech engine
        │                               │
        │                       transcript comes back
        ▼                               │
Hotkey released ────────────────────────┘
        │
        ▼
   cleanup pass (optional LLM polish)  ──▶  paste into the focused app
        │
        ▼
   "Add to dictionary?" pop-up if a new name showed up
```

## Layout

- `main.js` — Electron main process: hotkey, tray, the floating pill, typing, and the dictionary pop-up.
- `server.js` + `realtime-relay.js` — local HTTP server and the WebSocket relay that keeps your API keys out of the browser window.
- `src/providers/` — one transport per speech engine (`deepgram`, `whisper-local`, `openai`).
- `src/vocab.js` — the custom dictionary: one store, read by every engine, written by the pop-up.
- `src/correction-watch.js` — watches for a hand-typed fix right after a dictation (macOS/Linux).
- `src/hotkey.js`, `src/typing.js`, `src/cleanup.js` — the hotkey listener, clipboard/keystroke output, and the LLM cleanup pass.
- `public/` — the hidden mic window, the status pill, and the dictionary pop-up.

## Settings

The common options — speech engine, default language, AI cleanup, API keys, and recording privacy — are in the **Settings…** window (tray menu). It writes the same `.env` the app reads, leaving your comments and other keys untouched, and changes apply to your next dictation without a restart.

Everything (including the knobs not in the window — models, ports, the dictionary watch window) is still plain environment variables in `.env`; the full table lives in [SETUP.md](SETUP.md).

**Recordings & privacy.** GVoice keeps recent dictation audio on disk so a missed paste stays recoverable. These clips are unencrypted. They're capped at the last 50 *and* auto-deleted after `RECORDING_RETENTION_DAYS` (default 7). Turn saving off entirely, change the window, or wipe them now from Settings (or the tray's **Clear recordings**).

**Dictation history.** The tray's **Recent dictations** menu keeps your last 50 transcripts (they survive restarts), so a paste that missed its target can be copied again — and each entry's audio clip can be played back while recordings are enabled.

## Troubleshooting & logs

Per-event tracing (key presses, paste timing, cleanup) is written to `debug.log` in the app's data folder — on macOS that's `~/Library/Application Support/GVoice/debug.log` (rotated at ~1 MB). Set `GVOICE_DEBUG=1` to also echo those traces to the console while developing.

**Dictation key does nothing on macOS?** Open GVoice from Finder (or `open -a GVoice`) rather than from a terminal. macOS gives the right to watch the keyboard to whatever *started* the app, so a terminal without Accessibility permission leaves GVoice looking healthy and completely deaf. GVoice now spots this itself and tells you within about 30 seconds of you using the machine.

**Mic goes quiet after sleep?** GVoice watches for it. If the system wakes from sleep (or the audio device changes) and the mic starts delivering pure silence, the capture pipeline is rebuilt automatically on the next press — no restart needed.

## Edit selected text (macOS)

Select text in an accessible text field and press **Cmd+Shift+E**, or choose
**Edit selected text…** from the tray. Speak an instruction with **Speak
instruction** (click again to stop), or type it and choose **Generate preview**.
Review the replacement, then click **Apply replacement**. **Undo edit** restores
that selection only if the original field still matches the applied result.

The selected text and instruction go to the currently configured cleanup text
provider. Ordinary dictation keeps its existing fast cleanup path. Editing does
not send messages or press Enter. Unsupported fields, password fields, changed
selections, and changed documents are rejected rather than edited blindly.
Close the preview or click Cancel to discard a pending preview. Once Apply begins,
GVoice checks the result before offering Undo. Native selection
editing currently requires macOS Accessibility access and a text field or text area
exposing a writable value and readable selection; unsupported editors and
Windows show an explanatory message.

## Destination profiles

**Settings → Output profiles** offers Plain, Email, Chat, and Coding profiles.
Pick a default or explicitly map applications with **Detect app in 5 seconds**.
Switch to the destination during that countdown, choose its profile, add the rule,
then save. Unknown destinations use your default. Automatic app detection currently
requires macOS; manual profiles work on other platforms.
Choosing a profile from the tray switches to one profile everywhere; saved app rules
remain available in Settings.

Profiles format through your existing AI cleanup provider and timeout. Enable AI
cleanup to use them. Plain retains the existing cleanup path. A dictation keeps
the profile captured when it began, even if you change settings before it finishes.
App detection reads identity only, without window titles, browser URLs, or selected
text. Browser tabs share an application rule.

## Personal speech benchmark

Open **Personal speech benchmark…** from the tray or Settings → Activity. Choose
one recording, listen, write the correct transcript, and explicitly approve it.
Tag Croatian, English, mixed language, brands, numbers, negation, self-corrections,
and noise to build coverage of how you speak. Nothing is collected automatically.

Run your installed local Whisper engine or import results from other engine/model
combinations. Compare word/character error rates, timing, critical-change flags,
and your own meaning reviews. Reference changes invalidate prior approval and
scores. Benchmark copies have separate retention: remove them in the benchmark
window when no longer needed. See [benchmark guide](docs/benchmark.md) for result
formats, offline execution, timing limits, and coverage guidance.

## Reliability and timing checks

**Settings → Activity → Dictation speed** shows this launch's last 500 attempts,
grouped by speech provider and whether capture was warm or cold. It reports median
and p95 release-to-paste latency plus capture-tail, transcription, cleanup, and
paste stage medians. A p95 from a handful of samples is preliminary. Failed
attempts are counted separately from pasted results. Timing records contain no
transcript text; existing history and recording settings still govern content.
Cleanup retries and model failover share one timeout budget (default 2.5 seconds).

- `pnpm test` runs unit and provider parity checks. Credential-dependent parity
  cases may skip and are reported as such.
- `pnpm test:electron` runs an explicit isolated desktop regression. It requires
  Playwright, Electron, a local Whisper binary/model, and native paste access.
  Missing prerequisites fail the command rather than producing a passing skip.
- See [desktop regression coverage](scripts/electron/README.md) for actual audio
  source details and the separate physical-device verification checklist.

## Transcribe local files

Open **Transcribe files…** in the tray, or **Settings → Activity → Open file transcription**. Choose up to 20 audio/video files at once (WAV, MP3, M4A, MP4, MOV, FLAC, OGG, WebM, MKV, AIFF or AAC). Each recording can be up to six hours. The first integration transcribes English locally; it does not add translation, speaker labels, cloud upload or YouTube import.

File work uses the currently configured whisper.cpp model/server and requires FFmpeg plus FFprobe on PATH. It adds no speech model or Python runtime. Audio is decoded in sections of at most 20 seconds, favoring nearby quiet gaps. Live dictation runs before the next file section; an already-running section is allowed to finish. Pause may therefore take a few seconds to settle. Pause all active file jobs before changing the speech engine or running a benchmark.

Original media stays in its folder. Only text, source identity and progress are saved under the app data folder's `file-transcriptions` directory, with a limit of 100 saved jobs and 4 MB per job. Closing the file window leaves its queue running. Closing GVoice interrupts active/queued jobs; reopening leaves them paused until you choose Resume. A moved/changed source or a different selected model stops that job with an explanation.

Use **Copy text**, **TXT**, **SRT** or **JSON** on a completed or partial transcript. Save to a new filename; existing files cannot be overwritten. SRT times describe whole sections, not words. JSON includes completion status and progress. Existing Transcribe data and its extra workflows remain separate and untouched.

Verification: `node --test scripts/unit/file-transcription.test.js` and `node scripts/electron/file-transcription.mjs`. The desktop check uses generated English speech, isolated app data, and the installed small English model. It never uses personal recordings.
