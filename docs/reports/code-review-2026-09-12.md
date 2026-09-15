# Code review – GVoice, unpushed work on main (2026-09-12)

Reviewed: the 21 unpushed commits on `main`, focused on the daily-use branch merge
(safer paste, cancel, mic choice, companion socket) plus the three commits after it.

Ten findings. Items 1, 6, 7 and 9 were re-checked against the source by hand and the
code matches the description exactly. The rest were not reproduced on a running app.

---

## 1. Companion `stop`/`cancel` with no session id kills any live press

`src/control-socket.js:273` with `main.js:1237`.

`const sessionId = conn.sessionId || asked` is `null` when the companion never got an
ack, and `DictationSession.owns(null)` returns `true` by design ("unstamped counts as
live"), so `hooks.stop` and `hooks.cancel` both sail past the ownership guard.

Scenario: user holds right-Option. Companion's button is pressed, `start` is refused
with `"busy"`, so `conn.sessionId` stays `null`. Button released, companion sends
`{"type":"stop"}` with no session id, `fireRelease("companion:companion")` cuts the
user's dictation off mid-sentence. With `cancel` the words are thrown away.

Fix: treat a null resolved `sessionId` as "nothing of mine to stop" and refuse the
frame, the way `releaseOwnedRecording` already does.

Verified by hand: yes, code reads as described.

## 2. "Click to cancel" is a no-op for the whole paste window

`main.js:1857` and `main.js:2094`.

`dictation.done()` now runs the moment the transcript arrives, so the session is IDLE
while cleanup (up to `CLEANUP_TIMEOUT_MS` 2.5s) and the paste still run. The pill still
reads "Transcribing… (click to cancel)". Clicking it (`pill:cancel` → `cancelDictation`)
or pressing Escape returns `false`, paints nothing, and the text pastes anyway.

The advertised escape hatch does nothing at the one moment the user reaches for it.

## 3. After any cancel, unstamped renderer errors are silently swallowed

`main.js:2062`.

`dictation.wasCancelled(eventSessionId)` falls back to `this.id` when the id is missing,
and `this.id` still holds the cancelled press's name until the next `tryStart()`. So
after a cancel, every unstamped `dictation:error` returns early: no pill, no reason, for
a dead mic or a down relay. That is exactly what the escalate-recovery renderer reload
produces, the case `owns()`'s own comment says must never be dropped. Compare
`mic-warning` just above, which only checks `owns()`.

## 4. Picking the "Default" input rebuilds the capture graph after every dictation

`public/mic-health.js:134` and `public/dictation.js:1017`.

`buildCaptureGraph` stores `track.getSettings().deviceId`, which the OS resolves to the
concrete device; `preferredMicId` keeps whatever id the Settings list offered.
`reportMicState` does not filter the `"default"` pseudo-device out of the list, so the
user can pick it. Then `chooseCaptureDevice` returns `rebuild: currentId !== preferredId`
= `true` on every `checkPreferredDevice` call, after each `finishUtterance` and on each
`devicechange`, tearing down and reopening the mic each time. Settings permanently reads
"yours isn't plugged in".

The same never-converging comparison also loops when `getUserMedia({deviceId:{exact:…}})`
falls back to the default while `enumerateDevices` still lists the preferred id.

## 5. Cancelling leaves the mouse-back toggle thinking the button is held

`main.js:1176`.

`createMouseBackGate` keeps its own `held` flag and `cancelDictation` has no way to clear
it. Escape-cancel a dictation started with the mouse back button, then press that button
again: `down()` sees `held === true`, fires `onRelease` → `fireRelease` →
`dictation.release()` returns `false`, so nothing happens and the user has to press a
second time. `pill:stop` used to go through `release()`, so the gate and the session
agreed; cancel breaks that.

## 6. The companion is told the wrong microphone mode

`main.js:1225`.

`hooks.status` hardcodes `micMode: "balanced"` with a comment saying "step 15 of the plan
makes this a real preference". This work IS that step: `micPrefs.micMode` exists
(`main.js:2369`) and its default is now `"always"`. Any companion reasoning about warm-up
latency gets a stale answer on every heartbeat.

Verified by hand: yes, line 1225 hardcodes `"balanced"` while line 2369 reports the real
preference.

## 7. Croatian word leaked into the English cleanup prompt

`src/cleanup.js:73`.

"Use a comma before but or ali when they join complete thoughts." `ali` is Croatian for
"but". The model gets a rule about a conjunction that does not exist in the input
language, in the one prompt that formats every dictation.

Verified by hand: yes, the word is there.

## 8. The 256-token floor on `max_completion_tokens` can truncate short dictations

`src/cleanup.js:334`.

`Math.max(256, ceil(len/2))` runs together with `reasoning_effort: "low"` on
`openai/gpt-oss-*`, and on that API the completion budget covers reasoning tokens as well
as output. A short dictation gets a 256-token ceiling shared with reasoning; a truncated
reply then fails the new `preservesSpeakerWords` check and falls back to
`formatRawFallback`. Cleanup silently stops working for the shortest utterances instead of
surfacing anything.

## 9. The `.env`-isolation guard is never switched on

`src/bootstrap-env.js:95`.

The comment states "offline checks (test:unit, test:parity, test:pipeline-smoke) set it",
but nothing sets `GVOICE_NO_ENV=1`: not `package.json`, not either test file. Both only
honour it. Those suites load a developer's real `.env` by default, which is the leak the
flag was added to prevent.

Verified by hand: yes, the only two hits in the whole source tree are the comment and the
`if` that reads it.

## 10. The new Microphone section's status messages appear on every other tab

`public/settings.html:329` and `:628`.

`setStatus` writes to all `.statusEl` nodes, and `loadMic()` now runs unconditionally at
boot. A failed mic read puts "Couldn't read your microphones." on the Speech-engine and
AI-cleanup save bars, and `saveMic`'s "Saved." lands there too. Cosmetic, but an unrelated
panel looks like it just saved or failed.

---

## Noted, not filed as defects

- `main.js:1756` records the raw transcript on the cancel path. Every other
  non-delivered path uses `stripWhisperNoiseTokens(...)`, so "Copy last result" after a
  cancel can hand back `[BLANK_AUDIO]`-style tokens.
- `resolveProvider`'s `belongsToAnotherProvider` check silently discards a deliberately
  set `CLEANUP_MODEL` that happens to match another provider's default.
