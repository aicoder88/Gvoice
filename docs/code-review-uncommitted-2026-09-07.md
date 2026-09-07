# Code review — uncommitted work, 2026-09-07

Scope: `git diff main...HEAD` is empty, so this reviewed the working tree —
12 modified files plus 20 new source/preload/UI files that ship with them.

10 findings, worst first.

---

## HIGH

### 1. Paste is refused whenever Accessibility can't answer, not just when the app really changed
`main.js:1304`

The guard is `captureForegroundApp() === sourceApp`. `captureForegroundApp()` goes through
`withFocusedElement`, which returns `null` on any AX failure — including the fresh 0.2s
messaging timeout added in `src/foreground.js:225`.

A target app that is briefly busy (Chrome under load, an Electron editor mid-render) returns
`null`; `null === 1234` is false; `typeText` returns `null`; `typed = false`; and a perfectly
good dictation shows the red "Click Copy — the paste didn't land" pill.

Everywhere else in this file the convention is explicit that AX `null` means "couldn't tell,
never hold it against the paste" (`isForegroundWindow`, `readbackPasteTarget`).

Fix: treat `null` as unknown → allow.

---

## MEDIUM

### 2. The clipboard rescue for a failed paste was deleted and only partly replaced
`main.js:1304-1327`

Removed: `if (!result.pasted || result.likelyMissed) setTimeout(() => clipboard.writeText(lostText), 450)`.
Replacement: `releaseClipboard(keepText)`, which does nothing when `clipboardLease` is undefined —
and `typeText` returns `null` (no lease) on exactly the paths where rescue mattered: the ownership
refusal above, and `!text`.

Scenario: user switches apps during the cleanup pass → paste refused → error pill → the text is on
neither the clipboard nor anywhere but the tray.

Same gap on the non-clipboard path (`src/typing.js:143` returns `{ keep: () => false }`), which
additionally makes `releaseClipboard(true)` log a false `paste-clipboard-lost` on every rescue
attempt when `TYPE_VIA_CLIPBOARD=false`.

### 3. Broken caller: the smoke test's clipboard mock no longer satisfies `typeText`
`scripts/smoke/pipeline-smoke.test.js:132`

`createClipboardLease` (`src/clipboard-lease.js:19`) calls `clipboard.availableFormats()`; the mock
only provides `readText`, `readImage`, `writeText`, `writeImage`.

`pnpm test:pipeline-smoke` now throws `clipboard.availableFormats is not a function` inside
`typeText` and the paste-buffer assertion never runs — on any machine where whisper-cli + a model
are installed (otherwise the test skips and hides it).

### 4. A synchronous Accessibility round-trip was added to the key-press path, ahead of the microphone
`main.js:1080`

`captureDictationSource()` is a system-wide AX traversal capped at 0.2s per message
(`src/foreground.js:225`). Before this change nothing AX ran at press time —
`captureForegroundWindow()` returns `null` immediately on macOS.

It now runs before `webContents.send("dictation:start")`, so a busy or unresponsive foreground app
delays mic open by up to ~200ms on every press and can clip the first word. The comment claims it
merged two traversals into one, but on the press path it went from zero to one.

### 5. A failed spoken editing instruction shows both the edit-window error and a stray red pill
`main.js:1910`

The `dictation:failure` handler deliberately returns early for voice-edit generations
(`if (voiceEditor?.owns(gen)) { … hidePill(); return; }`), but `dictation:error` calls
`voiceEditor.fail()` and then falls through to `showPillResult("error", …)`.

Scenario: press the edit hotkey with the mic blocked → the edit window says "Microphone not
available" *and* a dictation error pill appears over the user's work.

### 6. Pressing Cmd+Shift+E while an instruction is being recorded silently destroys it
`src/voice-edit-window.js:36`

The protect list is `['working','preview','applying','undoing']` — it omits `'listening'` and
`'transcribing'`. A second press during recording runs `dispose()` → `cancel()` →
`activeGeneration = null`, so when the transcript arrives `accept()` returns without doing anything.

Because the edit path in `main.js:1651-1655` never calls `recordTranscript`, the spoken instruction
leaves no history entry and no recording either — it just vanishes with no message.

---

## LOW

### 7. The tray "Output profile" item can crash the main process
`main.js:2497`

`destinationProfiles.save()` does `mkdirSync`/`writeFileSync`/`renameSync` and throws synchronously
(read-only or full `userData`, permissions). The IPC path at `main.js:1597` wraps this in try/catch
and returns `{ error }`; the tray click callback does not, so the throw surfaces as Electron's
"A JavaScript error occurred in the main process" dialog.

### 8. The deliberate "don't paste, it's saved" outcome is reported as a paste failure
`main.js:1284` and `main.js:1290`

Both early returns carry `notice: "Saved in Recent dictations."` with `pasted: false`, but the
caller at `main.js:1793` renders `!result.pasted` as an error pill reading "Click Copy — the paste
didn't land" and never reads `notice`.

Reachable when cleanup plus the rescue push past the 30s `canPaste` window with the same press
still current.

### 9. The "Cmd+Shift+E is taken" tray fallback can't appear on first launch
`main.js:2704`

`createTray()` (which calls `rebuildTrayMenu()`) runs before `setupIpc()` assigns `voiceEditor`, and
nothing rebuilds afterwards. The ternary at `main.js:2489` sees `voiceEditor === null`, so the menu
advertises a shortcut that may be dead until some unrelated event rebuilds the menu.

### 10. A file-only clipboard is never restored and keeps the dictated text
`src/clipboard-lease.js:35`

`previousText` is `""`, `previousImage` is empty, `previousFormats` is non-empty, so neither restore
branch fires and GVoice's text stays on the clipboard indefinitely. The old code at least wrote `""`
back. Neither restores the files, so this is a behaviour change rather than new data loss — flagged
because the lease's own comment claims the caller "always ends the hold", implying the clipboard
returns to the user.

---

## Checked and clean

- `startRecordingOperation`'s abandon/timeout path: every `await` after the last `isCurrent()` guard
  is followed by another guard, and the tail from `isRecording = true` through
  `startInFlight = false` is fully synchronous — a timed-out startup cannot flip state under the
  next press.
- `ensureSocket()` is called after `activeProfile = profile`, so realtime events carry the correct
  press generation, and one socket is created per press.
- `claimTerminal` pruning.
- `destinationProfiles` init ordering vs. `startDictation` / `createTray`.
- The cleanup budget-abort path (`lastCleanupError` is not written after an abort).
- `validate()`'s prototype-pollution guards.
- `public/benchmark.js`'s disable / re-enable cycle.
