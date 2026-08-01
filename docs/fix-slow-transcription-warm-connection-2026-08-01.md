# Why dictation went slow again — and what changed, 2026-08-01 (evening)

Reported: "this transcribing is very slow again". The press that carried that
sentence took **6.9 seconds** from key-up to paste. Another one that evening took
**9.9 seconds**.

## What the log actually shows

Every slow press in `~/Library/Application Support/GVoice/debug.log` has the same
shape: the Deepgram connection opened LATE, so at key-up the engine was still
seconds behind, and the backlog hold added by the previous fix (correctly) waited
for it.

| press (UTC) | connect took | engine behind at commit | key-up → transcript |
|---|---|---|---|
| 20:46:05 | 4.6s | 4377ms | 9860ms |
| 20:52:30 | 1.0s | 597ms | 730ms |
| 20:53:25 | 4.1s | 2559ms | 7691ms |
| 20:53:46 | 0.6s | 1024ms | 715ms |
| 20:54:00 | 0.6s | 768ms | 654ms |
| 20:54:55 | 0.7s | 1024ms | 694ms |
| 20:55:28 | 2.4s | 2986ms | 3713ms |
| 20:56:26 | 5.6s | 3583ms | 6905ms |

The split is clean: a fast handshake gives a sub-second dictation, a slow one
costs 4-10s. **The flush logic is not the bug — it is the alarm.** Removing the
hold would bring back the words-go-missing bug fixed earlier the same day
(`docs/fix-truncated-dictation-2026-08-01.md`).

### It is not the network

Same machine, same key, same URL, from a plain node process — measured across
30s / 60s / 90s / 120s idle gaps:

```
dns 9-155ms   tcp 161-240ms   tls 332-480ms
websocket open: 509, 531, 556, 584, 588, 626, 657, 749, 803, 853, 955ms
```

Never above 1s after the first connect of a process. The app's 2.4-5.6s waits
are the app paying a handshake at the worst possible moment — in the middle of a
press, while the user is already speaking — not Deepgram being slow.

## The fix: never handshake during a press

`src/providers/deepgram.js` now keeps a **standby connection** parked and ready:

- When a dictation's client socket closes, the relay immediately opens the
  connection the NEXT press will use and holds it open with a `KeepAlive` every
  4s (Deepgram drops an idle socket after 10s — NET-0001).
- The next press takes that socket instead of dialling: no handshake, no
  backlog, so the flush goes out immediately and the transcript comes straight
  back.
- The parked connection is keyed by its full stream URL, so a language toggle, a
  model change or a new dictionary word can never hand a press the wrong
  settings — a mismatched standby is dropped, not used.
- `main.js` prewarms one at launch, so the first dictation of the day is warm
  too.
- A standby that nobody uses for 10 minutes closes itself. One that dies
  (sleep/wake, network drop) is simply forgotten — the next press dials fresh and
  parks a new one. Deliberately no reconnect loop: a revoked key or a dead
  network would spin forever.

Cost: nothing. Deepgram bills the audio you send, not the time a socket is open,
and KeepAlive frames are not billed.

## What was checked before building it

Two assumptions had to hold, both verified against the live API on 2026-08-01:

1. **A parked socket still transcribes.** After 30s and after 90s idling on
   KeepAlives, a real clip replayed through it came back correct
   (`"This transcribing is very slow again."`), with the first interim 519ms
   after the audio went out.
2. **Idling does not corrupt the catch-up math.** `unheardMs()` subtracts
   Deepgram's own progress stamp (`start + duration`) from the audio we sent. On
   a socket that had idled 90s, the first Results frame still reported
   `start=0` — the stamp counts from the first audio byte, not from connect. So
   the backlog guard behaves identically on a warm socket.

## Verified on the running app

`pnpm build`, installed to `/Applications/GVoice.app`, relaunched, then a real
recorded clip replayed through the running app's own relay:

```
[relay] deepgram connected model=nova-3 lang=en (warm)
[relay] deepgram commit (audio=3584ms, engine 0ms behind)
[relay] deepgram complete pick=en (reason=from_finalize) en:words=6,conf=1.000,len=37
engine ready after 33ms
transcript after 248ms: "This transcribing is very slow again."
```

Engine 0ms behind at commit — the condition that used to trigger the multi-second
hold no longer happens.

**Read that 248ms as the relay path only.** It is a recorded clip replayed
through the running app's relay: no mic opening, no pill window, no paste. It
proves the handshake and the hold are gone from the press, which is what the
6905ms was made of. It is not a measurement of a real key press end to end —
only Mark holding the key can produce that number.

Repeatable check: `node scripts/verify-warm-standby.mjs [clip.wav]`. It boots the
real relay and runs three dictations: prewarmed, warm-reuse, and one where the
parked connection is killed at the TCP level first (network drop / sleep-wake) —
that one must still transcribe, on a freshly dialled socket. Measured: 6ms, 3ms,
779ms of connect, all three transcripts correct. Exits non-zero if any of that
stops holding. (Not in `pnpm test` — it needs the network and spends a few
seconds of Deepgram audio.)

## Still open

- **The first press after 10 idle minutes** still pays a handshake (~0.5-5s).
  Making the standby permanent would fix that at the cost of holding a socket
  open all night; the 10-minute window is the compromise.
- **Why the app's handshake is 3-8x slower than the same handshake from a plain
  node process** was never explained — only routed around. If it shows up
  somewhere else (the cleanup call, the batch retry), that is the thread to pull.
- **The menu-bar icon is hidden behind the notch**, not missing: macOS reports
  GVoice's status item alive at x=723 on a 1470-point-wide screen, which is dead
  centre. Too many menu-bar icons on this machine, not a GVoice bug.
- The previous installed build is parked at
  `/Users/macpro/dev/voice/dist/GVoice-previous.app` (~200MB) — delete it when the
  new one has earned trust.
