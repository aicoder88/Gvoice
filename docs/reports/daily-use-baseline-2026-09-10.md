# Daily-use baseline — 2026-09-10

Worktree: `/Users/macmini/dev/voice/.claude/worktrees/daily-use` (branch `worktree-daily-use`, off local `main`, not pulled).

## GVoice — `pnpm install --frozen-lockfile`

Exit 0. Lockfile up to date, 401 packages installed (`koffi`, `uiohook-napi` native builds succeeded).

## GVoice — `pnpm test:unit`

Command: `node --test scripts/unit/*.test.js`

Exit 0. All files pass, no `ERR_MODULE_NOT_FOUND`.

- tests: 164
- pass: 164
- fail: 0
- cancelled/skipped/todo: 0
- duration: 701.9 ms

The earlier draft's "5 of 20 files fail with `Cannot find package 'ws'`" no longer applies now that packages are installed. Full pass, per-file breakdown not needed since nothing failed.

## Better Options — `scripts/check-settings.sh`

Exit 0. All checks passed (round trip, saved bindings, binding names, changing a binding, no-settings-file fallback, mice — see full log for the itemized list, every line `ok`).

## Better Options — `swift build`

Exit 0. `Build complete! (0.10s)`.

---

# Step 4 — the numbers before anything changed (2026-09-10)

Everything below was measured on this Mac mini (Apple M4), offline, against the
local Whisper engine `models/ggml-small.en-q5_1.bin`. Microphone in use: `Default -
Anker PowerConf C200 (291a:3369)`. Ten runs each; the median is the headline, every
run is listed so a later re-run can be compared honestly.

Two departures from the step as written, both deliberate:

- `scripts/verify-warm-standby.mjs` was **not** used. It boots the relay and spends
  Deepgram audio over the network. This step's own wording says "through the local
  Whisper engine", and offline checks must not touch a key, so a local equivalent
  (`scripts/measure-engine.mjs`) drives the same fixture through the same engine.
- No `.env` was renamed or moved. The worktree has no `.env` at all, only
  `.env.example`, so every command below already ran with no keys present.

## The five medians

| What | Median | Runs | Command |
| --- | --- | --- | --- |
| Press to first audio, microphone already open ("warm") | **85 ms** | 85, 85, 85, 85, 85, 85, 85, 85, 86, 85 | `npx electron scripts/measure-mic.cjs 10` |
| Press to first audio, microphone closed ("cold", today's state after 120 s idle) | **442 ms** | 574, 445, 443, 442, 441, 440, 423, 442, 443, 441 | `npx electron scripts/measure-mic.cjs 10` |
| Release to result (audio committed → transcript back from the engine) | **222 ms** | 219, 217, 217, 222, 223, 224, 222, 224, 222, 218 | `WHISPER_MODEL=/Users/macmini/dev/voice/models/ggml-small.en-q5_1.bin node scripts/measure-engine.mjs 10` |
| Paste duration (80 ms release wait + clipboard write + ⌘V round trip) | **225 ms** | 205, 193, 231, 231, 231, 226, 223, 224, 222, 231 | `npx electron scripts/measure-mic.cjs 10 --paste` |
| Five minutes idle — processor share | **0.0 %** | 0.0 at all 16 samples, 20 s apart | `ps -o %cpu= -p <pid>`, cross-checked with `top -l 3 -pid <pid> -stats pid,cpu,mem` |
| Five minutes idle — memory in use | **72.15 MB** (70.77 – 73.06 MB) | see `docs/reports/daily-use-idle-samples-2026-09-10.tsv` | `ps -o rss= -p <pid>` |
| Five minutes idle — bytes uploaded | **0** | cumulative total held at 612 bytes for the whole window | `nettop -P -x -J bytes_out -l 2 -p <pid>` |

Supporting numbers from the same runs:

- Building the capture graph from cold (open the microphone, start the audio
  context, load the worklet, connect) is **178 ms**; the remaining ~264 ms of the
  cold 442 ms is waiting for the first 4096-sample batch to fill.
- Warm press-to-first-audio is one batch period. At a 48 kHz context and a 4096-sample
  batch that is 85 ms, and the measurement lands exactly there every run.
- The engine starts in **461 ms** from a cold `whisper-server` spawn to first answer
  ready (`scripts/measure-engine.mjs` prints this as "engine ready").
- `src/benchmark-run.js` agrees independently: `runLocalBenchmark` reports
  `elapsedMs: 240` warm on its own 4 s clip, verdict `fastEnough: true`.

## What the medians mean for step 17's targets

- Step 17 wants warm press-to-first-audio ≤ 150 ms. Today's warm number is 85 ms,
  so "Always ready" has room; the number to beat for the cold path is 442 ms.
- Step 17 wants release-to-result within 10 % of baseline. Baseline is 222 ms, so
  the ceiling is 244 ms.

## Idle: measured on the installed app, not on a dev launch

The dev app **cannot launch from this worktree right now**, so the idle window was
measured read-only on the installed GVoice (pid 60242, started 2026-09-10 01:46),
which is this pass's "before" code. Nothing was launched, killed or written.

The blocker, found by this step and not fixed here because it belongs to step 3:
commit `befd973` ("Offline checks never touch keys or provider allowances") moved
`const envFile` inside an `if (process.env.GVOICE_NO_ENV !== "1")` block but left
`export const ENV_FILE = envFile;` outside it. `envFile` is block-scoped, so the
export always throws:

```
ReferenceError: envFile is not defined
    at src/bootstrap-env.js:106:25
```

It throws with the flag set and without it — checked both ways under Electron. Every
launch of `scripts/dev-isolated.sh` dies on it before a window opens. `pnpm test:unit`
never imports `bootstrap-env.js`, which is why step 1's green run said nothing about
it. Step 3 owns the fix.

Because of that, one figure the step asked for is missing:

- **UNMEASURED — number of live capture graphs after five minutes idle.** It needs
  the running app's own renderer, and macOS exposes no outside signal for it
  (`ioreg -c IOAudioEngine`, `IOUserAudioDevice` and the Control Center media log all
  return nothing on this machine). To close it a person must: fix the
  `bootstrap-env.js` export, run `./scripts/measure-idle.sh 300`, and read the
  "capture graphs built during idle" line it prints; a live graph also lights the
  orange microphone dot beside the menu-bar clock, which is the eyeball version.

## How each thing was measured

- `scripts/measure-engine.mjs` — starts its own `whisper-server` in its own data
  folder, pushes `scripts/parity/fixtures/tone-1500ms.pcm16` (deterministic 1.5 s,
  24 kHz) through it once to settle caches, then ten more times and times each.
  The installed app's engine (pid 60265) was alive before and after, checked with
  `ps -p 60265 -o lstart=`.
- `scripts/measure-mic.cjs` (+ `scripts/measure-mic-preload.cjs`) — runs under the
  repo's own Electron in a hidden window and builds the capture graph exactly the way
  `public/dictation.js` does. Cold runs tear the graph down completely between
  attempts; warm runs keep it and time the gap to the next batch. With `--paste` it
  opens a small window of its own, checks that window is genuinely in front, and
  sends the real `osascript` ⌘V into it — so the keystroke can never land in whatever
  the person was working in.
- `scripts/measure-idle.sh` — launches the dev app through `scripts/dev-isolated.sh`
  only, settles for 30 s, then samples processor share, memory and bytes uploaded
  every 20 s. Written and left in place for step 17 to re-run; it has never completed
  a run because of the launch crash above.
- Idle samples for the installed app: `docs/reports/daily-use-idle-samples-2026-09-10.tsv`.
