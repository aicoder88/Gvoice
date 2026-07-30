# Code review — last 6 commits (retry, paste, Accessibility, pill)

Reviewed: working tree vs `origin/main`, 6 commits ending `aedc11c`. 9 findings, worst first.

## Status (2026-07-30)

| # | Problem | Fixed | Seen working |
|---|---------|-------|--------------|
| 1 | Accessibility help never shows | yes | no — needs the permission revoked to trigger |
| 2 | Hotkey deaf during retry | yes | yes — new press accepted mid-retry, log line 3036 |
| 3 | Retry always used Deepgram | yes | code path only (on-device engine not installed here) |
| 4 | Pill stuck on "Transcribing…" | yes | code path only (needs two retries overlapping) |
| 5 | No time limit on the upload | yes | yes — unit test asserts the abort signal |
| 6 | Cold mic loses first press after sleep | yes | partly — same rebuild flag seen firing at startup, no real sleep cycle |
| 7 | Stray `deepgram.js` at repo root | no | waiting on the go-ahead to delete |
| 8 | Reason text cut off on the pill | yes | yes — screenshot of the running app |
| 9 | Successful retry looked like an error | yes | yes — green dot in the preview render |

Tests: 128/128 unit, 3/3 parity (3 skipped — no local whisper model, no OpenAI key).

---

## 1. The "turn on Accessibility" message can never appear

`/Users/macpro/dev/voice/main.js:940`

`/Users/macpro/dev/voice/src/hotkey.js:255` rethrows a brand-new error
(`new Error("uIOhook.start failed: " + err.message)`), which throws away the `code`
the native library set. So the check `error.code === "UIOHOOK_ERROR_AXAPI_DISABLED"`
is never true.

**What a user sees:** fresh Mac, Accessibility permission not granted yet. They get
"Quit and reopen the app", no menu-bar item, no clickable notification. The entire
point of commit `eb4e8aa` is dead.

**Fix:** match on `error.message` instead (the text
"Failed to enable access for assistive devices." does survive), or copy `code`
onto the wrapper error in `hotkey.js`.

---

## 2. Hotkey goes deaf while a retry runs

`/Users/macpro/dev/voice/main.js:1279`

`dictation.finalize()` already cleared the 25-second safety timer, and
`dictation.done()` now sits behind `await retranscribeRecording(...)`. So
`dictation.busy` stays true for the whole round trip.

**What a user sees:** every key press during that window is silently thrown away
("PRESS ignored") — no pill, no beep, nothing. 2–5 seconds on a good connection.
Worst case the network library waits 300 seconds per try, twice.

---

## 3. Retry always goes to Deepgram, even for local-only users

`/Users/macpro/dev/voice/main.js:1225`

The retry ignores `STT_PROVIDER`. Someone who chose `whisper-local` picked
on-device on purpose (privacy, or no internet). Now every empty transcript
uploads their recorded audio to api.deepgram.com using the built-in fallback key.
Offline it can't work at all, and a rejected key or dead network replaces the
correct "No speech detected." with "Retry failed — check your internet."

---

## 4. Second failure in a row leaves the pill stuck on "Transcribing…"

`/Users/macpro/dev/voice/main.js:1214`

`retranscribeRecording` returns empty before it touches the pill when the audio
file is missing or another retry is already running (`retryInFlight`), but
`/Users/macpro/dev/voice/main.js:1378` now hands it the whole pill.

**What a user sees:** two failed dictations a few seconds apart. The second one's
retry is blocked, so the plain-English reason never gets shown — the pill just
says "Transcribing…" until the 25-second backstop hides it.

---

## 5. Network call with no time limit

`/Users/macpro/dev/voice/src/providers/deepgram.js:350`

`fetch` has no abort signal or timeout. A half-open connection (hotel wifi
portal, VPN drops) hangs for 300 seconds, doubled by the retry wrapper. Together
with finding 2, one bad dictation can jam the hotkey for minutes while the pill
hides at 25 seconds showing nothing.

---

## 6. Cold-mic mode loses the first dictation after sleep/wake

`/Users/macpro/dev/voice/public/dictation.js:706`

`teardownCapture`'s own comment says macOS wedges the audio engine after sleep, and
only the full teardown recovers it. On wake, main sends `dictation:rebuild-capture`
to `recoverMic`, which now returns immediately when `MIC_ALWAYS_ON=false`. Cold
mode's per-hold teardown (line 969) is the partial one that keeps the wedged engine.

**What a user sees:** first press after opening the lid records silence and shows
"No sound is reaching GVoice. Open System Settings → Sound → Input…" — which is
wrong advice, nothing is wrong with their mic. Second press works. The commit's
note only admits losing the liveness probe, not this.

---

## 7. Stray duplicate file committed by accident

`/Users/macpro/dev/voice/deepgram.js:1`

An old copy of `src/providers/deepgram.js` landed at the repo root in `aedc11c`.
Nothing imports it, and it couldn't run if anything did — its `./_shared.js` doesn't
exist at the root and `../vocab.js` points outside the repo. It will silently drift
out of date, and anyone opening "deepgram.js" edits the wrong file. Delete it.

---

## 8. Widening the pill didn't fix the cut-off message

`/Users/macpro/dev/voice/public/pill.html:55`

The window went 560 → 700 wide, but `body.has-actions .label` is still capped at
`max-width: 160px` with a 2-line clamp, so the text cuts at the same place. The
extra 140px went to the new "Transcribe again" button. "No sound is reaching GVoice.
Open System Settings → Sound → Input and pick your microphone, then press again."
still clips before the instruction.

---

## 9. Successful retry shows as a red error pill

`/Users/macpro/dev/voice/main.js:1236`

"Got it on retry — press ⌘V." is rendered in the `"error"` state (red dot), because
that state was the easy way to buy the 30-second linger. The colour tells the user
it failed when it worked.
