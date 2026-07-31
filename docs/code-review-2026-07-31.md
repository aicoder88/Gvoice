# Code review — 2026-07-31 (whole-repo pass)

Four-area pass: `main.js`, `src/` core modules, providers/relay/server, renderer/preloads.
Findings ordered by severity. Cross-checked overlaps are noted; one renderer-side
claim about the relay was corrected after checking `realtime-relay.js` (WS upgrades
*are* Origin-gated; HTTP endpoints are not).

## High

### 1. `public/realtime-voice-agent.js:201` — second "Start talking" press bricks the page and leaks the mic stream
`startRecording()` calls `await audioContext.audioWorklet.addModule("/audio-capture-worklet.js")`
on every recording with no loaded-guard. Re-registering the same processor name on the
persisted AudioContext throws `NotSupportedError`. `dictation.js:501-506` documents and
guards exactly this ("registering the same processor name twice throws") — the guard was
never ported here. The `addModule` call also sits *outside* the try/catch, after
`getUserMedia` already succeeded: the rejection is unhandled, `isRecording` stays false,
the acquired track is never stopped (orange mic dot stuck), and every later press fails
until reload. Fix: hoist `addModule` into `ensureAudioContext()` behind a `workletLoaded`
flag, inside the try, and stop tracks on the failure path. (If this page is dev-only,
downgrade to medium.)

## Medium

### 2. `main.js:1637-1675, 1906-1915` — `dictation:error` / `dictation:mic-warning` / `dictation:failure` bypass the generation guard
Commit `1f1924f` added `gen`/`stillMine()` to `dictation:transcript` because a late terminal
event can clear a *newer* session's `busy` mid-hold, making `fireRelease` swallow the key
release so the stream never stops. The same hole is still open in the other three
terminal-event handlers: all call `dictation.fail()` unconditionally. Normally impossible
(renderer 20s watchdog fires before the 25s safety timer), but a stalled-then-recovered
renderer (the `unresponsive` case logged at `main.js:872`) can deliver late.
`dictation:failure` even snapshots `gen` (`main.js:1642`) but calls `fail()` before any
`stillMine()` check. Fix: gate `fail()` on the generation snapshot in all three handlers;
when stale, log + record history but leave the session alone.

### 3. `main.js:1028` — `onPress` sends `dictation:start` to a possibly-destroyed webContents
`fireRelease` has an explicit destroyed-window guard (`main.js:998-1001`); `onPress` does
`dictationWindow.webContents.send("dictation:start", profile)` bare. If the renderer died
between presses (`render-process-gone` reloads only after 800ms), `tryStart()` accepts,
the send throws inside the hotkey callback, and the session is left `busy` with the pill
stuck on "Listening…" until the 90s max-hold backstop. Fix: same isDestroyed guard, plus
`dictation.fail()` when the send can't be made.

### 4. `src/typing.js:124-140` — clipboard restore clobbers anything copied within 250ms of a paste
`typeText` snapshots the clipboard, writes the transcript, pastes, then unconditionally
restores the old clipboard in a fire-and-forget `setTimeout(250)`. If the user copies
something new in that window (plausible right after dictating into a document), the
restore silently overwrites their fresh clipboard. No undo. Fix: before restoring,
`clipboard.readText()` and skip the restore if it no longer equals `textToPaste`.

### 5. `src/model-download.js:90-106` — `.part` WriteStream never destroyed on mid-stream failure/abort
In `downloadFile`, if `nodeStream` errors or the `AbortSignal` fires mid-download, the
promise rejects but `out` is left open — an fd leak until GC, and on Windows the
`onRetry` `unlinkSync(part)` silently fails on the open handle, so the retry's new
`createWriteStream(part)` opens a file another handle still holds. Fix: `out.destroy()`
on the error/abort path, and unlink `part` before the retry attempt.

### 6. `src/vocab.js:79-88` — dictionary save is non-atomic; crash mid-write silently wipes it
`history.js` got tmp+rename with a comment explaining why; `vocab.save()` does a bare
`writeFileSync`. A crash mid-write makes the next `load()` hit the catch at
`vocab.js:71-73` and reset to `{ terms: [], dismissed: [] }` — whole custom dictionary
and dismissal list gone with no error. `settings.js:112-117` (`writeEnvFile`, which
holds the API keys) has the same exposure. Fix: tmp + `renameSync`, mirroring `history.js`.

### 7. `src/providers/whisper-local.js:468-541` — `completed` can fire before `local.status connected`, violating protocol invariant 3
The message listener is registered, then `await ensureWhisperServer(...)` (up to 10s+),
and only then is `connected` sent. A quick tap during that window makes the commit handler
emit `...transcription.completed` before any `connected` frame.
`docs/RELAY_PROTOCOL.md:79` states the connected frame always fires first. Fix: send
`connected` immediately (the audio listener already makes buffering safe) or hold commit
processing until after the boot await.

### 8. `src/providers/deepgram.js:225-228` — commit during a slow (>3s) handshake still silently loses the transcript
The 3s safety timeout arms at commit; the clock-restart fix in `open` (:115-123) only
helps if `open` fires before the timer. On a slow/flapping network the timer fires while
a leg is still `CONNECTING`: `emitCompleted("safety_timeout")` latches `completedSent`
with an empty transcript, and the real text arriving later is discarded — the "empty paste
on perfectly good audio" class, still reachable. Also emits `completed` before `connected`.
Fix: in the safety-timeout path, treat `CONNECTING` legs as pending (defer, don't complete).

### 9. `src/providers/whisper-local.js:399,434-451,368-385` — slow-booting server can never come up; wedged-but-alive server has no circuit breaker
- `waitForServer(baseUrl, 10000)` gives a cold model load 10s. On timeout the ready-promise
  rejects, but the still-loading process stays alive until the *next* call's
  `reapStaleServer()` kills it — so a model needing >10s is killed on every retry and
  never boots; every dictation silently pays the slow CLI path forever.
- If the server hangs *after* booting (alive process, dead inference), reset is keyed on
  `exit`, which never fires. Every dictation waits the full 15s timeout then falls to CLI
  — permanently, with no failure counter.
Fix: raise/scale the boot timeout (or don't reap a same-model still-booting server), and
after N consecutive inference failures kill/respawn or unset `WHISPER_SERVER_URL`.

### 10. `server.js:36-73` / `realtime-relay.js:134-138` — HTTP endpoints aren't Origin-gated; only the WS upgrade is
WebSocket upgrades reject cross-origin requests, but `/recordings/*.wav` and all of
`public/` are served to any origin. Saved voice clips are embeddable by any web page that
guesses port + filename (`<audio src=http://127.0.0.1:port/recordings/x.wav>`); DNS
rebinding bypasses hostname assumptions. Loopback bind + OS-chosen port + timestamped
names make this hard to exploit — medium-low. Fix: check `Origin`/`Sec-Fetch-Site` on
`/recordings/` too, or serve only to requests with no Origin. A per-session token on
`/realtime` + `/recordings` would close both this and the CSWSH concern.

## Low

- **`main.js:2377-2381`** — `will-navigate` allowlist permits any loopback port, not just `serverPort`. One-line comparison would make it actually tight.
- **`main.js:140,2245,2271,2510`** — `isQuitting` is write-only. Dead state; remove or use (e.g. idempotent `before-quit` teardown).
- **`main.js:1479-1529`** — `savedForegroundHwnd` never cleared on the empty-transcript path (only success at :1544). Windows-only, cosmetic pill positioning.
- **`main.js:1011` vs `1366-1416`** — pill 25s safety-hide can fire mid-rescue; the empty-transcript rescue (30s transcription timeout) can outlast it. Cosmetic.
- **`main.js:2298-2301`** — no `did-fail-load` path for the dictation renderer; a failed load leaves the hotkey never armed while the app looks ready.
- **`src/typing.js:34-42,144-145`** — a failed nut-js import is memoized forever; every later non-clipboard `typeText` fails until restart. Reset `nutPromise = null` on rejection.
- **`src/settings.js:61-95`** — duplicate keys in a hand-edited `.env` are updated at the wrong line (dotenv is first-wins, the index keeps last), so the save never takes effect after restart.
- **`src/hotkey.js:149-159`** — right-Alt as trigger breaks AltGraph typing on Linux and Option-layer characters on macOS; each accidental hold fires the empty-transcript flow. Document or remap.
- **`src/cleanup.js:44-48,53`** — (a) unrecognized `CLEANUP_PROVIDER` falls back to keyless `openai`, silently returning raw text with no recorded error (the class `lastCleanupError` was built to kill); (b) `TIMEOUT_MS` read once at load while everything else is re-read per call.
- **`src/correction-watch.js:47-51`** — letter reconstruction assumes QWERTY; AZERTY/Dvorak produce garbage words and missed corrections.
- **`src/foreground.js:405-417`** — synthetic Ctrl down/up can desync from physically-held Ctrl on Windows if the chord is re-pressed within 80ms.
- **`src/hardware.js:119-123`** — Windows GPU probe blocks the event loop up to ~6s (acknowledged in comment).
- **`src/providers/deepgram.js:312-319`** — legs in CLOSED/CLOSING state still accumulate audio (~48KB/min per dead leg). Only queue when `CONNECTING`.
- **`src/providers/whisper-local.js:459,473`** — PCM buffered unboundedly (2.9MB/min) for as long as the key is held; a stuck key grows RAM indefinitely. Cap buffered seconds.
- **`src/providers/deepgram.js:169-186`** — error-path fall-through relies on `ws` always emitting `close` after `error` for the final `completed`. Make it explicit.
- **`src/providers/openai.js:93-100`** — binary client frames are stringified into invalid JSON and sent upstream; frames arriving while upstream is CLOSED queue forever. Third-party clients only.
- **`src/providers/deepgram.js:272-275`** — unparseable text frames forwarded verbatim; Deepgram may close the stream. Third-party clients only.
- **`public/dictation.js:721-759`** — mid-build probe failure leaks the last candidate's mic stream: `buildCaptureGraph` sets `mediaStream` at :484 but `captureReady` only at :560, and the idle callback returns early on `!captureReady` (:636), so the claimed `armIdleTimer()` mitigation never fires. Call `teardownCapture(true)` in the `catch` before `continue`.
- **No CSP on any HTML page** — all dynamic DOM goes through `textContent` today (the one `innerHTML` at `vocab-prompt.html:76` is escaped), so defense-in-depth, but a `default-src 'self'` meta per page is cheap insurance.
- **`public/realtime-voice-agent.js`** — `disconnectedCallback` never closes the persisted AudioContext; `stopAndAskForResponse`/`interruptAgent` send without a `readyState` recheck; `agentLabels` imported but unused.
- **`realtime-relay.js:28-31`** (informational) — baked-in Deepgram fallback key in a public repo; deliberate and documented, but card-backed unlike the Groq one.

## Verified non-issues (checked, deliberately not reported)

- Post-`processTranscript` `stillMine()` checks (`main.js:1538-1558`) look late but commit `1f1924f` intentionally pastes into the captured window; only pill/clipboard/history are gated.
- `benchmark-run.js` leaves a warm whisper-server running — safe; `whisper-local.js:304-321` respawns on model-path mismatch.
- `dictation-session.js` default `safetyTimeoutMs = 500` only affects tests; production passes 25000.
- `retry.js` correctly does not retry aborts/timeouts, matching the cleanup.js contract.
- `server.js:61-62` static traversal is safe: WHATWG URL normalization clamps `..` before the `/public` prefix.
- API keys: read fresh per connection, sent only in `Authorization` headers, never logged; upstream error bodies don't echo credentials.
- IPC contract: every channel exposed by the six preloads matches a handler/sender in `main.js`, and return shapes line up in both renderers that consume them.
- Renderer late-transcript race: fresh socket per press + replaced-socket frames ignored (`dictation.js:269-277`) + generation guard — remaining holes are provider-side (#7, #8 above).
- Deepgram batch retry deadline: single 30s `AbortSignal` across retries, not per attempt.

## What looks well done

- **Security posture**: every window `sandbox: true, contextIsolation: true, nodeIntegration: false`; preloads narrowly scoped with no generic passthroughs; `setWindowOpenHandler` denies all popups; relay binds loopback and Origin-gates WS upgrades; `engine:apply` allow-lists with `Object.hasOwn` (prototype-chain bypass considered).
- **macOS accessibility handling**: deaf-hotkey watchdog cross-checking `powerMonitor.getSystemIdleTime()`, `UIOHOOK_ERROR_AXAPI_DISABLED` special case with pref-pane deep link, tray re-assert on wake.
- **`dictation-session.js`**: generation counter with the "rejected press must not bump it" invariant; small auditable state machine.
- **`history.js`**: atomic tmp+rename writes, serialized write chain — the model `vocab.js`/`settings.js` should copy.
- **`hotkey.js`**: deaf-hook detection, swallowed-keyup self-healing via live modifier mask, native error code preserved for the Accessibility prompt.
- **`foreground.js`**: AX error-code classification, single-snapshot terminal+read-back check, CFRelease hygiene.
- **Deepgram leg lifecycle**: per-leg state summary at commit, dead-leg `flushed` marking, `completedSent` latch.
- **whisper-server ownership**: generation guard on spawns, PID-file + `isOurWhisperServer` double-check before killing a recycled PID.
- **`cleanup.js`**: never-throws contract, 429-vs-outage distinction, transient-streak gating, `max_tokens` truncation guard.
- **Pure/IO split** consistently applied; 16 unit suites cover the pure modules, and the untested ones are precisely the Electron/FFI-coupled ones — the right trade.
- **Renderer audio pipeline**: transferable buffers, detached backup copies, AGC/NS/EC off with rationale, worklet load guarded in the dictation renderer, full-context rebuild for the post-sleep wedge.

## Suggested order of work

1. #2, #3 — same bug class as the fix in HEAD, one handler-layer over.
2. #7, #8 — protocol-invariant holes, user-visible as empty/mis-handled dictations.
3. #9 — silent permanent CLI fallback on the local engine.
4. #4, #5, #6 — data-loss/leak fixes with small diffs.
5. #1 if the voice-agent page ships; #10 when touching the server next.
