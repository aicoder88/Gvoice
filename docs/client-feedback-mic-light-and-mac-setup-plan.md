# Plan — kill the always-on mic light, stop the silent dead hotkey, document the Mac local engine

Three fixes from client feedback, in impact order. Each goal ends with a check
you can run on the **built app** (`dist/mac-arm64/GVoice.app`), not just `pnpm start`.

Suggested: Opus 5, medium effort. Goal 2 is the only one with real thinking in it.

---

## STATUS — all three built and checked on the built app (30 Jul 2026)

Commits: `cb3de3b` (Goal 1), `4c375d8` (Goal 2), `c48e0c0` (Goal 3).
Full test suite green (130 unit, 3 parity, 0 fail).

**Goal 1 — done, watched working.** With one minute set: mic warm at launch
(orange dot on), a real dictation transcribed and pasted, dot went out on its
own exactly 60s after the commit, next press reopened the mic in ~130ms and
captured real audio with no false "no sound is reaching GVoice", timer re-armed
and dropped again. Changing the setting in Settings reloaded the dictation
window live (`…&micidle=15`) and persisted to `.env`; "Only while I hold the
key" still tears down per hold; tray icon present throughout. Separately, an
app launched and then not used at all went dark 60s after startup with no press
ever — the "I opened it this morning and forgot about it" case.

**Goal 2 — done, warning path watched firing.** The watchdog stays quiet on a
healthy launch (verified across several launches with real key events). Forced
deaf, it reported within 30s: tray menu switched to "⚠ Not hearing your
keyboard — open from Finder" + "Open Accessibility settings…", and the
notification was raised (its banner was suppressed by the Mac's Focus mode, so
the banner itself wasn't eyeballed — the tray change was). On a machine left
untouched for 11 minutes it stayed silent, which is the idle cross-check doing
its job.

One fix on top of the plan: the "is the user here" signal and the "did we hear
anything" signal have to count the same input. System idle time counts mouse
MOVEMENT and scrolling; the four key/button events the plan listed do not. So a
perfectly healthy app would have accused itself the first time somebody read a
page for half a minute without typing. It listens on uiohook's `input`
catch-all instead — measured: 12 mouse moves produce 12 `input` events and zero
key events.

**Goal 3 — gate run, and it came back better than the plan assumed.**
Homebrew's `whisper-cpp` (1.9.1) **does** ship `whisper-server` — the plan's
"no server on the brew path" premise is out of date. So brew is the documented
Mac path *with* the fast server, and the source build is now only a footnote.
Proven on the packaged app: a 34-second saved dictation transcribed by the
brew binaries in 5.1s through the server path, matching the cloud transcript.

**Two premises in the plan that would have caused bugs, corrected in the code:**
- `recoverMic` must NOT switch to `!captureReady`. Startup warming calls it
  before anything is built, so that guard would stop every mode from warming
  the mic at launch. It branches on cold-mode-or-idle-dropped instead.
- The `holdStartedAt` reset must NOT switch to `!captureReady` either — it runs
  *after* `initCapture()`, where that is always false. The press snapshots
  "did I have to open the mic myself" before the rebuild instead.

**Not checked, and why:** the mouse-only false alarm couldn't be driven
end-to-end — synthetic events reach the key hook but do NOT reset the OS idle
clock (measured: idle kept climbing through both synthetic keys and synthetic
mouse movement), so that condition needs a real hand on the trackpad. The fix
was verified one level down instead, on the event stream itself. The
lid-sleep/wake press for Goal 1, and Goal 3 with WiFi physically off, also
weren't run.

---

## Goal 1 — Mic drops itself after 5 minutes idle, adjustable (the orange dot ick)

**What the client sees:** macOS shows the orange "mic in use" dot all day, even
when they aren't dictating.

**The behaviour we want:** mic stays warm while you're working, closes itself
after **5 minutes** with no dictation, reopens on the next press. Instant first
word all through a working session; dot dark when you walk away; only the first
press after a break pays the open cost. Length adjustable in Settings, including
the two ends (never close / only while holding).

**Where it stands:** the app already has both halves — a warm mode and a
release-after-every-press mode (`MIC_ALWAYS_ON`, `public/dictation.js:13`,
`main.js:849`). It's a hidden on/off in `.env`. This goal turns that into a
timer with a number on it.

Nothing else in the dictation window holds the mic — `public/mic-health.js` is
pure math, and `realtime-voice-agent.js` is only loaded by the demo page
`public/index.html`, never by the dictation window. So closing this one stream
does put the dot out.

**Changes**

1. `src/settings.js` — replace the boolean with one key, `MIC_IDLE_MINUTES`:
   - `5` — default. Any number of minutes.
   - `0` — only while holding the key (today's cold mode).
   - `never` — keep it open all the time (today's default).
   Back-compat in the same function: an existing `MIC_ALWAYS_ON=false` reads as
   `0`, `MIC_ALWAYS_ON=true` reads as `never`, so nobody's `.env` changes meaning.
   Add it to `settingsView()` / `patchFromView()`, clamped like `retentionDays`
   already is.
2. `public/dictation.js` — the mic-idle timer:
   - Pass the value through as `?micidle=` instead of `?hotmic=` (read once at
     load, same as today).
   - On release, arm a timer for N minutes; on press, clear it.
   - Timer fires → the exact teardown cold mode already does at line 974
     (`teardownCapture()` + `audioContext.suspend()`), so the dot goes out.
     Never fires mid-hold: it's only armed on release and cleared on press.
   - Arm it once at startup too, so an app you launch and don't use goes dark.
   - Next press rebuilds through the existing `initCapture()` path — no new
     open/rebuild code.
   - `recoverMic` (line 697) and the `holdStartedAt` reset (line 863) currently
     branch on the mode flag. Switch both to the real condition — *is the capture
     actually torn down right now* (`!captureReady`) — so warm-but-idle-dropped
     behaves correctly instead of falling into the wrong arm of a mode check.
3. `public/settings.html` — a dropdown in the **Privacy** section: "Close the mic
   when idle" → *Only while I hold the key / After 1 minute / After 5 minutes
   (default) / After 15 minutes / Never*. One line under it: *the orange mic
   light goes out when it closes; the first press after that takes a moment
   longer.*
4. `main.js` `applyEnvPatchLive()` (~line 2035) — reload the dictation window
   when `MIC_IDLE_MINUTES` changes, not only when the engine changes. The
   renderer reads it once at load, so without this the setting does nothing until
   a restart.
5. `scripts/unit/settings.test.js` — round-trip the new key, both back-compat
   readings, and the clamp.

**Verify (on the built app)**

- Set 1 minute, dictate, wait → dot goes out on its own about a minute later.
- Press again → mic opens, text pastes, no "no sound is reaching GVoice" warning.
- Dictate twice inside the minute → dot never blinks off, first word instant
  (the whole point of keeping it warm).
- Set "Only while I hold the key" → dot only during holds. Set "Never" → dot
  stays on, old behaviour intact.
- Quit, relaunch → setting persists.
- Sleep the lid, wake, first press → real audio (the `captureStale` guard at
  `public/dictation.js:706` covers this — confirm it still holds once the mode
  flag becomes a state check).

---

## Goal 2 — The app must say when the dictation key isn't reaching it

**What the client sees:** launched from a terminal, everything looks fine —
tray icon, "Ready" — but the key never arms. Launching detached fixes it. Took
them several goes to work out.

**What I checked, so we don't fix the wrong thing.** I ran a probe with this
repo's own `uiohook-napi` under Electron, launched from a terminal:

```
TRUSTED=true   HOOK_START=ok   KEYDOWNS_SEEN=6
```

So on this Mac the hook works fine from a terminal, and
`systemPreferences.isTrustedAccessibilityClient()` says nothing useful here — a
permission check alone would not have caught the client's case. The existing
`UIOHOOK_ERROR_AXAPI_DISABLED` path (`main.js:939`) only fires when the hook
refuses to start; the client's hook started and then delivered nothing.

**So fix the class, not the theory:** the app should notice that it is armed but
receiving no keyboard events *while the user is clearly active*, and say so.
This also covers the Windows "frozen hook" failure the code comments already
worry about (`src/hotkey.js:6`).

**Changes**

1. `src/hotkey.js` — set a `sawEvent` flag on the first event of any kind
   (keydown/keyup/mousedown/mouseup), expose it to the caller.
2. `main.js` — after the hotkey starts, poll every 15s: if `sawEvent` is still
   false **and** `powerMonitor.getSystemIdleTime() < 5` (the user is typing or
   moving the mouse right now) for two checks in a row, the hook is dead.
   No idle-user false alarm, because system idle time is the cross-check.
   On that verdict: tray tooltip + one notification —
   *"GVoice isn't hearing your keyboard. If you started it from a terminal, quit
   and open it from Finder instead — or allow that terminal under Privacy &
   Security → Accessibility."* Plus the existing tray item that opens the
   Accessibility pane. Stop polling the moment any event arrives.
3. Leave `hotkeyFailed` alone — `main.js:1997` gates the ready path on it. New
   flag, tooltip and notification only.
4. `SETUP.md` + `README.md` — one troubleshooting line: launch with
   `open -a GVoice`, and if you launch from a terminal, that terminal needs
   Accessibility, not GVoice.

**Verify (on the built app)**

- Remove the launching app from System Settings → Privacy & Security →
  Accessibility, launch GVoice, then type normally → warning appears within ~30s
  and names the terminal fix.
- Grant it back, relaunch, type → no warning ever, dictation normal.
- Idle test: launch, walk away 5 minutes without touching the machine → no
  warning (proves the idle cross-check).

---

## Goal 3 — A Mac path for the free on-device engine

**What the client hit:** `scripts/setup-whisper-windows.ps1` is Windows only and
SETUP.md's local option is headed "on Windows". They built whisper.cpp from
source to get running.

**Gate — run, and it settled the question.** `brew install whisper-cpp` (1.9.1)
installs **both** `whisper-cli` and `whisper-server` into `/opt/homebrew/bin`.
The formula no longer builds with `-DWHISPER_BUILD_SERVER=OFF`, so the CLI
fallback at `src/providers/whisper-local.js:536` never comes into it on a brew
install. Verified on the packaged app: server warmed at boot, a 34-second clip
back in 5.1s.

→ brew is the documented Mac path, on the fast server. The source build with
`-DWHISPER_BUILD_SERVER=ON` is now only a note for people who build their own.

**Changes**

1. `scripts/setup-whisper-mac.sh` (~30 lines, mirrors the PowerShell one):
   install `whisper-cpp` via brew if `whisper-cli` isn't already on PATH,
   `curl` the GGML model into `models/`, skip anything already present, print the
   exact `.env` lines at the end.
2. **Absolute paths in those printed lines.** A Finder-launched `.app` does not
   get your shell's PATH, so `/opt/homebrew/bin` isn't there and a bare
   `WHISPER_BIN=whisper-cli` works in dev and dies in the installed app. Resolve
   with `command -v whisper-cli` and print the full path.
3. `SETUP.md` — retitle Option A to cover both platforms, add the Mac steps, the
   no-`whisper-server` note, and the source-build alternative.
4. `README.md` — drop "On Windows" from the local-engine line.

**Verify**

- Run the script on a machine without whisper installed, paste the printed lines
  into `.env`.
- Launch the **built** app (not `pnpm start` — that's the PATH trap), turn WiFi
  off, dictate → text pastes.
- Re-run the script → skips both downloads, exits clean.

## Goal 4 — the in-app panel works on a Mac (done 30 Jul 2026)

Was parked; built on request. The panel used to hard-block anything but
Windows. Only the *binary* step was ever Windows-shaped — the model download,
the speed test and the apply step were already cross-platform — so that one step
now branches: Windows downloads the binaries, a Mac points at Homebrew's
`whisper-cpp`, everything else still says "not on this platform".

- No Mac install yet → the panel says the one command that fixes it
  (`brew install whisper-cpp`) instead of a dead end.
- `whisper-cli` present but `whisper-server` missing → still usable, but the
  panel warns, because the speed test would then time the reload-per-clip path
  and could fail a machine that's actually fast.
- Apply always writes an **absolute** `WHISPER_BIN` — a Finder-launched .app
  gets none of your shell's `PATH`.

**Watched working on the built app:** Settings → speed test → Homebrew's
whisper-server warmed with the Metal backend, 749 ms, "fast enough to use
locally"; "Use on-device" wrote `WHISPER_BIN=/opt/homebrew/bin/whisper-cli` plus
an absolute model path; "Keep cloud" put Deepgram back.
