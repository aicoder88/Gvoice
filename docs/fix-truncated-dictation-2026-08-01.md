# Why words went missing again — and what changed, 2026-08-01

Reported: dictations coming back with several seconds of speech simply gone,
"like 10 seconds". Same shape as the bug fixed on 2026-07-30, different cause.

Evidence is in `~/Library/Application Support/GVoice/debug.log` and the saved
clip `temp-recordings/dictation-1785607608404-k3dv.wav`, which is the press that
lost the words and which every measurement below replays.

## What actually happened

Two independent give-up clocks fired early. Both are fixed.

### 1. The flush beat the engine's backlog (the big one)

The relay hands audio to Deepgram as fast as the browser produces it, but
Deepgram transcribes a live stream at roughly real time. When the upstream
connect is slow, the relay queues the audio and dumps the whole backlog the
instant the socket opens — that part was already correct, no audio is dropped.

The bug: **Deepgram's `Finalize` flushes what it has already HEARD and discards
the rest.** On the reported press, Deepgram connected 6.0s after the mic opened
(`18:06:41.914`), so at key-up it was still ~3s behind, and the Finalize threw
that away.

Measured, replaying the 9.5s clip as one burst:

| Finalize sent | transcript |
|---|---|
| immediately after the burst | `Several` (1 word) |
| held back 8s | `Several seconds of words like the last 10 words, sometimes` (10 words) |

No timeout could have fixed this — the audio was already discarded upstream.

**Fix** (`src/providers/deepgram.js`): hold the Finalize until the engine has
actually heard what we sent. The wait is the smaller of two readings — wall
clock (bytes in ÷ 48 = ms of audio) and Deepgram's own progress stamp
(`start + duration` on every Results frame, which it sends even for empty ones).
Capped at 10s, and tracked **per leg**: auto-language mode runs two connections
that open at different moments, and a fast leg must not make a slow one look
caught up, so the slowest leg decides.

Under `FLUSH_NOW_UNDER_MS` (1200ms) of lag it flushes immediately, so the
healthy press pays nothing. That threshold is not a guess: 1200ms is inside the
1000ms tail the renderer already streams after key-up (`TAIL_MS`) plus the
flush's own latency, which is why healthy presses came back complete before this
change and still do — measured 3/3 full transcripts on the installed app with
zero added wait.

The safety timeout was rebuilt around the same idea: it now measures engine
SILENCE (3s), re-arms on every Results frame that arrives after the flush, and
runs from the moment the Finalize actually went out — never from a commit whose
leg was still handshaking. A ceiling of 5s past the Finalize keeps it bounded.

Also fixed while in there: when the hold committed before any leg was open, the
old code sent the Finalize inside the leg's `open` handler, immediately after
dumping the queue — the worst possible moment, and the exact case above. It now
schedules the same backlog-aware flush. And `flushLegs` no longer starts the
answer clock when no leg was live to receive the Finalize; doing so completed a
whole dictation as an empty paste in testing.

### 2. The renderer pasted its own half-built text (`public/dictation.js`)

`DICTATION_FALLBACK_MS` was 1200ms — shorter than the relay's own 3s safety net.
So on any dictation Deepgram took longer than 1.2s to finalize, the renderer
gave up and pasted the accumulated delta text instead of the real transcript.

Three of the last five presses in the log hit it. Press `gen 59` pasted 108
characters at `18:06:31.266`; the real transcript (165 characters) arrived
322ms later and was thrown away.

Raised to 17000ms. The ordering that matters, and the reason each constant is
what it is:

    relay backlog wait (10s) + relay ceiling (5s) < FALLBACK_MS (17s) < FAILURE_MS (20s)

The fallback is a last resort for a relay that answers with nothing, not a race
the engine is supposed to lose. The healthy path still pastes in ~0.5s.

### 3. A second press was binning the first one's words (found while fixing 1+2)

Holding a flush for seconds opens a window the old 1.2s fallback never left
open. `ensureSocket()` closes the previous client socket on every press, which
CloseStreams the relay's legs, and `startRecording` clears the previous press's
watchdogs — so a press landing mid-hold destroyed that dictation with nothing
pasted, nothing saved, and no error. The log shows presses 2–4s apart routinely,
and the trigger is self-reinforcing: nothing pastes, so the user presses again.

**Fix**: the renderer now hands the unanswered audio to main
(`dictation:superseded`) before the new press tears the socket down. Main saves
the clip and logs it to history — deliberately no pill and no batch retry, since
the live press owns the screen and a rescued transcript pasted right then would
land in the middle of it. The words are recoverable from the tray's "Transcribe
again". The new IPC is intentionally NOT stamped with `pressGen`: by the time it
fires, `pressGen` already belongs to the new press, and main must never read it
as the live dictation failing.

## Pill moved (`main.js`, `public/pill.html`)

It was bottom-**centre** — directly over the input line of whatever the user was
dictating into, and the result pill is 760px wide. Now bottom-right, 12px from
the edge (`PILL_SIDE_MARGIN`). `pill.html` had to move too: it centred the pill
inside its own transparent window, so a narrow pill would still have floated
mid-screen inside a 760px box. Now right-anchored to match.

Alternative if that is still in the way: top-right under the menu bar, same
one-line change to `positionPill`.

## What was verified

On the installed `/Applications/GVoice.app`, rebuilt and relaunched:

- The exact clip that lost words, replayed through the running app's relay with
  a 6s simulated slow connect: **full 58-character transcript**. Before the fix
  the same replay returned one word.
- Same clip on a healthy connect, 3 runs in a row: full transcript every time,
  no added wait (the flush went out at commit).
- Menu-bar icon present after the relaunch (screenshot).
- `pnpm test` — 164 unit tests pass, parity 3 pass / 3 skipped (no OpenAI key,
  no local whisper model). New: `scripts/unit/deepgram-flush.test.js` covers the
  wait math, including the two field cases that were wrong and the slow-leg case.

**Not verified on the running app:** the pill's new position, the renderer's
raised fallback, and the superseded-press rescue. All three need a real key
press, which needs a person to speak. One dictation shows the first two; two
quick presses in a row show the third.

## Separate problem, not fixed here

Deepgram is answering with nothing on roughly a third of connections right now,
and connect times in the reported session grew from 0.5s to 6.8s. Replaying the
same clip against the ORIGINAL relay code shows the same empty rate, so this is
upstream, not a regression. The app already rescues an empty stream by
re-transcribing the saved clip through the batch API. Worth watching; if it
persists, the shipped fallback key is the first thing to suspect.
