# Menu-bar icon: click to talk, right-click for the menu

Date: 2026-07-31. Commit: `27bc9a0`.

## What was asked

"Make the icon appear in the menu bar, so I can right click and close it and
left click to open/close the mic."

## What was found

Two separate things were tangled together.

### 1. The icon is not missing from the app — the Mac is drawing it blank

The menu-bar item exists, holds its space, and responds to clicks. It just
paints nothing.

Evidence:

- At 15:32 a screenshot of the menu bar showed the GVoice soundwave icon
  rendering normally (the old `/Applications/GVoice.app` build).
- From roughly 15:45 onward the same slot went blank on every build tried.
- macOS accessibility reports the item as alive the whole time:
  `position 809,4 size 40,24`, role `AXMenuBarItem`, subrole `AXMenuExtra`.
- Pressing that item via accessibility fires the app's click handler and starts
  a dictation (`press` / `release` entries in `debug.log`), so the item is real
  and clickable — only invisible.
- The image itself loads fine: `nativeImage.createFromPath` on
  `public/trayTemplate.png` returns a non-empty 22×22 image with the `@2x`
  variant present.
- **The unmodified code is blank too.** `git stash` → run → still blank. So the
  new click handling is not the cause.
- **The original untouched `/Applications/GVoice.app` is blank too** — the same
  binary that rendered correctly at 15:32.
- A throwaway Electron app with the identical three lines of icon code rendered
  its icons at ~15:44 and stopped rendering later in the same session.
- Setting a plain text title (`tray.setTitle("GV")`) on a test item also drew
  nothing — so it is not an image, tint, template, or size problem. The item
  draws nothing at all.
- Restarting `SystemUIServer` did not restore it.

Conclusion: this is macOS menu-bar / window-server state on this machine, not
app code. Nothing in `main.js` can repaint another process's status item, and
the same code path renders or doesn't render depending only on when it is run.

Recommended fix: **restart the Mac.** If it comes back and then goes blank
again, that is worth reporting to Apple, not patching here. Deliberately did
NOT add a resize / setTitle fallback / periodic re-assert — none of them can be
shown to fix a fault that isn't reproducible on demand, and each would be dead
code pretending to be a fix.

Note: `main.js` already re-asserts the tray image on wake from sleep and
recreates the Tray if the object died (`setupPowerMonitor`). That covers the
case where the Tray object is genuinely lost. It does not cover this one.

### 2. The click behaviour — this is the actual change

Before: the tray had a context menu attached with `setContextMenu`. On macOS
that opens the menu on **both** left and right click, and Electron then never
emits the `click` event at all. So there was no way to wire a left-click
action.

After:

- `rebuildTrayMenu()` stores the menu in a module variable instead of calling
  `tray.setContextMenu(menu)`.
- `createTray()` wires two handlers:
  - `click` → toggle dictation. First click starts the mic, second click stops
    it, transcribes, and pastes. Control-click is routed to the menu, because
    macOS reports control-click as a left click with `ctrlKey` set.
  - `right-click` → `tray.popUpContextMenu(trayMenu)`. Reads the variable at
    click time so a menu rebuilt after a dictation is the one that opens.
- Handlers are wired inside `createTray()`, not at boot, so the sleep/wake
  recovery path that recreates the Tray keeps them.

### Why the press/release code moved

`onPress` / `onRelease` bodies lived inside `setupHotkey`'s `try` block as
closures. Two problems for a tray toggle:

1. If `startHotkey` throws (macOS Accessibility not granted), the function bails
   before those closures are usable. That is precisely the run where a
   click-to-talk fallback matters most.
2. Every identifier they used was already module-level, so the closure bought
   nothing.

They are now module-level `startDictation()` and `fireRelease(source)`. The
hotkey callbacks are one-liners that call them. `startDictation()` gained one
guard the hotkey path used to get from `setupHotkey`'s early return:
`if (!dictationWindow || dictationWindow.isDestroyed()) return false`.

### The 90-second cut-off, and why the click path gets its own

`MAX_HOLD_MS = 90000` is the lost-key-up safety net: if a push-to-talk hold
never reports a release, end it rather than leave the session jammed. It never
fires in real use because a hold is a few seconds.

A toggle changes that. Click, talk, click — the user is invited to leave the mic
open, and at 90 seconds it would cut off, transcribe, and paste half a sentence.
So `startDictation()` now takes the ceiling as an argument. The hotkey keeps
90s; a tray click gets `CLICK_MAX_HOLD_MS = 600000` (10 minutes). Still capped,
so a forgotten "on" click can't hold the mic open all day, but well past any
real dictation.

### A click that can't start the mic opens the menu instead

If `startDictation()` returns false — renderer gone, or the previous dictation
still transcribing — the click pops the menu. Without this the icon would sit
there doing nothing, which reads as a dead app. It also matters because the app
is dockless (`LSUIElement`): with no window and no dock icon, the tray menu is
the only route to Quit and Settings.

### Why a separate `trayHolding` flag

`dictation.busy` cannot be the toggle state. It stays true through
transcription — the session's safety timeout is 25s — so a second click during
transcription would read as "stop" when nothing is recording. `trayHolding` is
true only while a left-click is holding the mic open, and is cleared at the top
of `fireRelease` so a keyboard release or the max-hold watchdog resets it too.

## What was verified, on the running packaged app

Build: `pnpm build` → `dist/mac-arm64/GVoice.app`, launched and left running.

**Click-to-talk, end to end:** focused an empty TextEdit document, pressed the
tray item, played speech at the mic, pressed it again. Result in `debug.log`:

```
transcript {"len":73,...}
typed {"len":73,"ms":621,"fieldFocused":true,"pasted":true,"verified":true,"target":"textedit","readLen":74}
```

and the document contained
`Testing one two three. The quick brown fox jumps over the lazy dog again.`

Repeated after the rebuild that added the longer click ceiling:
`typed {"len":56,"ms":615,"fieldFocused":true,"pasted":true,"verified":true,"target":"textedit","readLen":57}`

**Focus is not stolen.** The concern was that clicking a menu-bar item would
make GVoice frontmost and the text would paste into the wrong place. Measured
the frontmost process immediately before and immediately after the tray press:
unchanged both times. `hwnd:null` in the log is normal — `captureForegroundWindow`
is Windows-only (`src/foreground.js:340`); on macOS the paste goes through the
clipboard into whatever is frontmost.

**Unit tests:** 153 pass.

## What was NOT verified

**Right-click opening the menu.** Could not be exercised without a real mouse:

- Accessibility exposes only `AXPress` on the item, which synthesizes a plain
  left click — it started a dictation, confirming no modifier reached the app.
- `System Events`' `click at {x,y}` hit-tested to the frontmost app's menu bar
  instead of the status item.
- A small Swift helper posting `CGEvent` right-clicks was compiled and run; the
  events were dropped, because the shell posting them does not hold
  Accessibility permission. A synthetic left click through the same helper was
  dropped too, confirming the helper — not the app — was blocked.

The wiring is the standard Electron pattern (`tray.on("right-click", ...)` plus
`popUpContextMenu`), and it is only reachable when no context menu is set,
which is now the case. But it has not been seen working.

**This matters more than an unverified nicety.** Before the change, left-click
opened the menu, so Quit was always one click away. Now left-click dictates, and
the app is dockless — no window, no dock icon, so `buildAppMenu`'s Cmd+Q is not
reachable either. If `right-click` turns out not to fire, the only ways out are
the fallback above (click while the mic can't start) and Force Quit.

Needs one human right-click on the icon to confirm the menu with **Quit** opens.
If it doesn't, the fix is small — pop the menu on `double-click` as well — but
it should be added against a real observation, not guessed at now.

## Other notes

- The tooltip now reads "Hold right Option to dictate, or click this icon to
  start and stop."
- The new build is at
  `/Users/macpro/dev/voice/dist/mac-arm64/GVoice.app` and is the copy currently
  running. `/Applications/GVoice.app` is still the old build and was left
  untouched — replacing it is a install-time decision, not part of this change.
- Nothing pushed.
