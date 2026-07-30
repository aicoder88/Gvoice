# Code review — 2026-07-30, third pass

**Scope:** `origin/main..HEAD` — 17 unpushed commits, 22 files, +1855/-86.
Covers the mic idle-drop, the deaf-hotkey watchdog, the Deepgram batch retry,
the paste read-back change, and the parallel socket/mic startup.

Two reviews already ran on these commits
(`docs/code-review-last-6-commits.md`, `docs/code-review-2026-07-30.md`), and
their 16 findings are all marked fixed. This pass deliberately went after what
they missed rather than re-reporting them, and used one specific angle: **both
prior reviews fixed the exact path the finding named and left the sibling
callers alone.** All three findings below are siblings of an already-"fixed"
finding.

3 findings, worst first. **All three fixed.** 134/134 unit tests pass.

---

## 1. A retry that says it stops at 30 seconds runs for 44

`/Users/macpro/dev/voice/src/providers/deepgram.js:385` (pre-fix)

`transcribeWavFile` built `AbortSignal.timeout(30000)` **inside** the function
`withRetry` calls, so every attempt got a fresh 30-second clock. The comment
sitting right on top of it asserted the opposite:

> AbortError isn't retryable, so this is a hard ceiling, not 30s per attempt.

Half true. A clean `AbortSignal.timeout` abort really is unretryable — verified,
it surfaces as `TimeoutError`. But a *socket-level* failure does not: undici
reports it as `TypeError: fetch failed`, and `isRetryableError`
(`/Users/macpro/dev/voice/src/retry.js:24`) matches that string and returns
true. Verified locally against a server that resets mid-request: `name:
TypeError | msg: fetch failed | cause: UND_ERR_SOCKET | retryable: true`.

**Not theoretical — it happened on this machine.** From
`~/Library/Application Support/GVoice/debug.log`, during a window where Deepgram
was degraded (the streaming leg closed with `code=1011 "Deepgram did not provide
a response message within the timeout window"`):

```
[18:39:07.898Z] retranscribe {"path":".../dictation-1785436703507-u50w.wav","len":80,"ms":44373}
```

44,373 ms = 30,000 (attempt 1) + 300 (backoff) + 14,073 (attempt 2). The worst
case is ~60.3 s. The retry does not arm a pill safety-hide, so the pill sits on
"Transcribing…" for the whole minute with no cancel and no explanation.

**Fix:** one `AbortSignal.timeout(30000)` hoisted out of the retry and shared by
every attempt — which is exactly what the comment already claimed. New unit
test `retry shares one deadline instead of restarting the clock` asserts both
calls receive the *same* signal object, so a future edit can't silently
reintroduce a per-attempt clock.

---

## 2. The orange mic light burns forever when recovery gives up

`/Users/macpro/dev/voice/public/dictation.js:841` (pre-fix)

Prior finding #5 caught this on the *muted-device* exit of `recoverMic` and
armed the idle timer there. The **escalation** exit right below it — the one
taken after `MAX_PROBE_ROUNDS` of finding no live device — returns without
arming anything, and `ensureLiveCapture` has left its last candidate's stream
**open**. macOS lights the orange dot for any open stream.

The reason this isn't self-healing: escalation only *sometimes* kills the
renderer. `handleRecoveryEscalation` (`/Users/macpro/dev/voice/main.js:1796`)
reloads the renderer on the **first** escalation of an episode, but two of its
branches just show a warning and leave the renderer running:

- `!everHadLiveMic` — "mic never worked this session" (`main.js:1810`)
- the 5-minute relaunch cooldown (`main.js:1817`)

In both, the dot burns indefinitely over a microphone that is delivering
nothing — the precise thing the whole idle-drop feature exists to prevent.

Same hole feeds the dead-mic verdict in `finishUtterance`
(`/Users/macpro/dev/voice/public/dictation.js:1065`), which `return`s before the
arm/drop block and hands off to `recoverMic` — landing on this same exit.

**Fix:** `armIdleTimer()` before `requestEscalation`, matching the recovered and
muted exits. One line closes both paths.

---

## 3. "Transcribe again" during a live dictation uploads audio and bins the result

`/Users/macpro/dev/voice/main.js:1380` (pre-fix)

Prior finding #7 made `retranscribeOnDemand` explain itself for three ways a
retry can't run: no clip, one already in flight, wrong engine. It missed the
fourth — **a dictation is live right now**. The tray's "Transcribe again" and
"Transcribe last recording again" are clickable at any moment, including while
a press is being transcribed.

`retryCanRun` passes, the clip uploads, and then every output is thrown away:
`retranscribeRecording` gates its pill write *and* its clipboard write on
`pillFree()`. The click costs a round trip and shows nothing — exactly the bug
#7 was about. The error branch of `retranscribeOnDemand` had the mirror problem:
its `showPillResult` is ungated, so a can't-run message would paint over a live
"Listening…".

**Fix:** one `if (!pillFree()) return;` at the top. The live pill the user is
already looking at is the honest answer.

---

## Checked and cleared

- **Late transcript vs. batch retry.** The relay's new `armSafetyTimeout` re-arm
  can push relay completion past the renderer's 20 s `FAILURE_MS`, and the same
  diff makes that failure trigger a batch retry — a setup for one clip producing
  two transcripts and two history entries. It can't:
  `/Users/macpro/dev/voice/public/dictation.js:398` drops a late `completed` on
  `alreadyFinalized || failureHandled`. The re-arm is also bounded at two legs.
- **`main.js` importing `realtime-relay.js`** for `resolveDeepgramKey` adds no
  side effects — the module is imports plus exported functions, no top-level work.
- **`AbortSignal.timeout` retryability**, tested directly rather than assumed:
  a clean timeout is `TimeoutError`, not retryable; `httpError(401)` builds a
  plain `HttpError`, so a revoked key fails fast instead of burning two attempts.
- **`MIC_IDLE_MS` parsing.** A missing `?micidle=` lands on 5 minutes, not on
  `Number(null) === 0` (which would silently mean cold mode). Covered by the
  parse guard and by `settings.test.js`.
- **`setup-whisper-mac.sh`** — `set -euo pipefail`, every variable quoted,
  `curl --fail`, download to `.part` then `mv`. No injection surface worth
  flagging (the one argument is a filename the user types themselves).
- **`recoverMic`'s other exits** (cold/idle-dropped, hold-in-progress,
  already-recovering) all leave the arming to a path that does it — no leak.

---

## Not done in this pass

- **Specialist subagents were not dispatched.** The `/review` skill fans out to
  parallel specialist reviewers; this session's operating rules forbid spawning
  agents unasked. The diff was read end to end inline instead, which is the same
  input those specialists would have read.
- **Codex cross-model pass could not run.** The install is broken:
  `spawn .../codex-darwin-arm64/vendor/aarch64-apple-darwin/codex ENOENT` — the
  native binary is missing from the npm package. `codex --version` fails the same
  way. Reinstall `@openai/codex` to get cross-model coverage back.

---

## Status

| # | Fix | Verified? |
|---|-----|-----------|
| 1 | Batch retry shares one 30 s deadline across attempts | unit test (`calls[0].init.signal === calls[1].init.signal`); the retry path ran live and returned in 3.5 s; the 44.4 s failure is in debug.log |
| 2 | Recovery escalation arms the idle timer before handing off | code path — needs a machine with no working mic, twice in one episode |
| 3 | On-demand retry stands down while a dictation is live | **live** — tray "Transcribe last recording again" clicked on the running dev build, passed the new guard, recovered 53 chars in 3.5 s (`retranscribe ... len:53, ms:3469`) |

Tests: **134/134 unit** (was 133; one added for #1).

### Checked on the running app (dev build, this session)

Per the project's hard rule, the packaged instance was quit and `pnpm start` run
with these edits in place:

- Menu-bar icon appears and its menu opens, including the new **"Transcribe last
  recording again"** item and no stray ⚠ entries (hotkey healthy).
  Screenshot: `traymenu.png` in the session scratchpad.
- Hotkey arms: `Global hotkeys active: hold right Option (⌥), left Ctrl+Cmd, or
  mouse back button`.
- Startup mic recovery reaches the recovered branch and arms the idle timer:
  `Mic live on: Default - MacBook Air Microphone (Built-in)` → `mic recovered
  (auto)`.
- The on-demand retry path ran end to end through the new `pillFree()` guard.

### Still unverified on the running app

Fix 2 needs a machine with no working microphone escalating twice inside one
episode — not reproducible here without unplugging hardware. Fix 1's *failure*
was observed in production logs and its fix is covered by a test that fails
without it, but the >30 s abort case itself was not re-triggered live.

### Loose end, no action taken

`docs/client-feedback-mic-likght-and-mac-setup-plan.txt` is untracked and
duplicates the committed `docs/client-feedback-mic-light-and-mac-setup-plan.md`
(note the typo, "likght"). Delete or ignore — your call.
