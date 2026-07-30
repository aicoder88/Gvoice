# Code review — 2026-07-30

**Scope:** `origin/main..HEAD` — 14 commits, 21 files. Covers the mic idle-drop,
the deaf-hotkey watchdog, the Deepgram batch retry, the paste read-back, and the
result pill.

7 findings, worst first. **All seven fixed** — see "Status" at the bottom for
what was verified on the running app and what was only reasoned about.

---

## 1. Every retry failure blames the internet

`/Users/macpro/dev/voice/main.js:1343`

Every batch-retry failure prints "Retry failed — check your internet." A 401 is
a plain `HttpError`, not retryable, so it falls straight into this catch. When
the shipped fallback Deepgram key gets revoked, every empty dictation shows a
30-second red pill blaming a network that works fine. The streaming path already
has the right message for this exact case
(`/Users/macpro/dev/voice/src/providers/deepgram.js:176` — "Deepgram rejected the
key — add your own in Settings"). Same wrong text also shows for a 400 or the
30-second abort.

## 2. Retry ships audio to Deepgram even for OpenAI users

`/Users/macpro/dev/voice/main.js:1305`

The retry only excludes the on-device engine. Someone running
`STT_PROVIDER=openai` gets their saved WAV uploaded to api.deepgram.com, using
the baked-in shared fallback key, on every empty or failed dictation — a vendor
they never chose.

## 3. Late retry can overwrite a clipboard it doesn't own

`/Users/macpro/dev/voice/main.js:1329`

`clipboard.writeText(cleaned)` runs even when `ownsPill()` is false.

Scenario: user has a URL copied. Dictation 1 fails, retry A starts. User
dictates again; that text pastes, and `typeText` restores the URL at +250ms.
Retry A lands at +2s and silently replaces the clipboard with dictation 1's old
text — with no pill, because the retry knows it doesn't own it. Next ⌘V pastes
the wrong thing.

## 4. Silent-miss recovery no longer arms

`/Users/macpro/dev/voice/main.js:1452`

With `verified === false` no longer downgrading `pasted`, the "put the lost text
on the clipboard" fallback never fires for a genuine silent miss. The only
recovery left is the pill's Copy button inside the 8-second `uncertain` linger,
and history records the miss as pasted — no ⚠ in the tray.

## 5. Muted-mic recovery leaves the orange dot lit

`/Users/macpro/dev/voice/public/dictation.js:815`

The muted-mic recovery path returns without arming the idle timer, while
`ensureLiveCapture` has left the last candidate's stream live and `captureReady`
true. Flip a hardware mute switch on and the macOS orange mic dot stays lit
indefinitely — the exact thing this branch ships to fix. The escalation path at
`/Users/macpro/dev/voice/public/dictation.js:823` self-heals via the renderer
reload; this one doesn't.

## 6. Unguarded pill write can stomp a new dictation

`/Users/macpro/dev/voice/main.js:1399` (sibling at
`/Users/macpro/dev/voice/main.js:1492`)

`dictation.done()` now runs before `await saveTempRecording(...)`, which writes
up to ~4MB and prunes 50 files. A key press inside that window starts a new
dictation and paints "Listening…", then this fallback paints a 30-second red "No
speech detected." over it. `retranscribeRecording` guards every pill write with
`ownsPill()`; both callers' fallbacks don't.

## 7. "Transcribe again" can do nothing, silently

`/Users/macpro/dev/voice/main.js:1354`

When the retry can't run for a non-local reason — another retry already in
flight, or the clip already pruned — nothing happens on screen.
`retranscribeOnDemand` only explains itself for the on-device engine, and the
click handler in `pill.html` deliberately skips `lingerAfterAction()`.

---

## Checked and cleared

- uiohook does emit `input` for every event
  (`/Users/macpro/dev/voice/node_modules/uiohook-napi/dist/index.js:156`), so the
  watchdog's mouse-movement fix is sound.
- Result-pill geometry fits: ~742px of content in 760, ~67px in 72.
- `micIdleMinutes` round-trips, and the `MIC_ALWAYS_ON` back-compat holds.
- `VALID_PROVIDERS` has no local engine beyond `whisper-local`, so the
  two-string gate is complete.

---

## Status — all seven fixed

| # | Fix | Verified? |
|---|-----|-----------|
| 1 | Each retry failure names its own cause (`batchFailureReason`, shared with the streaming path's key-rejected wording) | unit-tested |
| 2 | The batch retry runs on the Deepgram engine only — no more silent uploads for OpenAI users | code path + unit suite |
| 3 | A retry that lost the pill no longer writes the clipboard | reasoned, not reproduced |
| 4 | Clipboard fallback arms on `likelyMissed` (field read back with content, ours missing) instead of restoring the downgrade aedc11c removed | reasoned from logged `readLen` |
| 5 | Muted-mic recovery arms the idle timer, so the orange dot goes out | reasoned, needs a hardware mute switch |
| 6 | Both fallback pill writes ask `pillFree()` first | reasoned, not reproduced |
| 7 | "Transcribe again" says why when it can't run | code path |

## Also fixed: the cold-press regression this review didn't catch

The mic idle-drop (cb3de3b) shipped a 3-second hole at the start of every press
that followed an idle stretch. `startRecording` waited for the WebSocket
handshake *before* opening the mic, so nothing was recorded until both finished
— and the pre-roll buffer, which normally covers the gap, was empty because the
mic had been closed.

Measured on the running packaged build, key-down to first captured frame:

- **before: 2939ms**, pre-roll `0B`
- **after: 456ms**

The handshake now runs alongside the mic instead of ahead of it, and the
pre-roll ring holds the whole startup window rather than the last 600ms. The
456ms that remain are `getUserMedia` opening the device — the only way to remove
those is to hold the mic open, which is the orange-dot problem the idle drop
exists to solve.
