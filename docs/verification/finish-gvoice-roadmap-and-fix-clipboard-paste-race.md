# GVoice roadmap and clipboard race verification

Date: 2026-09-08. Status: **step 1 implemented with passing native Electron regression; named-app acceptance remains pending; steps 2-6 pending**.

## Execution and source state

The requested plan was dispatched sequentially. Step 1 used GPT-6 Astra/high, with one source writer and primary-agent review and desktop verification. Steps 2-6 were not dispatched because they depend on step 1 passing. No installation, push, release upload, deployment, or provider-key change occurred.

Starting HEAD: `43568bbe8ccba0f1662dfd8d26a17d80dec91537`. The only initial untracked file was the requested plan. All implementation changes remain local and uncommitted.

## Step 1 implementation

- Clipboard restoration has no timer. Only exact insertion into the same readable field permits restoration.
- Delivery states are `verified`, `sent-unverified`, `refused`, `failed`, and `superseded`; history persists the state.
- macOS clipboard change counts detect newer copies, including a copy of the identical string. Consecutive dictations cannot restore each other's retained payloads.
- Unreadable targets retain the dictation. A changed destination refuses transport and retains recovery when the clipboard has not been changed by someone else.
- The macOS paste helper rechecks its expected foreground PID immediately before Cmd+V. This narrows the helper-launch race, but checking foreground and sending a global shortcut are not atomic OS operations.
- Transient before/after field text is used for exact insertion verification, not stored. The touched dictation log paths record lengths, states, ownership, and change counts instead of transcript/clipboard values.
- Startup logs include repository revision, source digest, and build time. The digest distinguishes uncommitted source changes at the same HEAD.

## Evidence

| Check | Result | Scope |
| --- | --- | --- |
| Pre-fix regression | Failed as expected, 1/1 | Delayed consumer received the previous clipboard; captured before edits |
| Installed artifact reproduction | Old clipboard inserted after a simulated 400 ms delay | Actual installed `typing.js` evaluated with simulated native transport, not a live native app paste |
| Focused final tests | 29/29 passed | Lease ownership, delivery classification, exact insertion, restore-write failure |
| Electron stress | 400/400 passed | Four simulated AX target modes, 100 each, real OS clipboard and production typing queue |
| Stress pressure/delay | Two CPU workers; observed 301-415 ms consumption delay | Zero old clipboard insertions, zero lost dictations, exact-once delivery on all fixture attempts |
| Electron clipboard boundaries | 7/7 passed | User copy, identical-value copy, refusal, consecutive leases, failure recovery, verified restoration, helper-time focus change |
| `pnpm test` | 260/260 unit tests; parity 4 passed, 2 skipped | Missing `OPENAI_API_KEY` prevents two OpenAI parity checks; not complete provider coverage |
| `pnpm test:electron` | **Passed on coordinated rerun** | Real local Whisper, two native dictations, duplicate/stale IPC, selection capture, preview, Apply and Undo; first run was interrupted by concurrent user activity |
| `pnpm test:profiles-benchmark` | Passed | Existing profile, snapshot, benchmark UI and local-Whisper checks in an isolated profile |
| `pnpm build` | Passed after final helper guard | Unsigned local macOS arm64 artifact |
| `git diff --check` | Passed | Final source and evidence diff |

The 400-attempt stress used simulated readable-editor, Chromium-field, terminal-unreadable, and cmux-unreadable modes. These names do not claim that TextEdit, Google Chrome, Terminal, or cmux received 100 native pastes. The test used real Electron clipboard APIs and a delayed DOM consumer; no native keystrokes or provider requests occurred in that stress run.

Detailed evidence:

- [Pre-fix failing regression](clipboard-race-before.txt)
- [Installed artifact reproduction](clipboard-stale-artifact.json)
- [Focused tests](clipboard-focused-tests.txt)
- [400 delayed attempts, including timestamps and change counts](clipboard-electron-stress.json)
- [Seven clipboard boundary checks](clipboard-electron-boundaries.json)

## Native desktop observations and blocker

The running source Electron app created a tray with nonzero screen bounds and opened Settings. The tray popup API returned successfully, but the menu-bar icon and open popup were not visually confirmed. These API checks alone do not satisfy the tray acceptance requirement.

A disposable TextEdit document, local Chromium textarea, and separate cmux workspace were prepared. CUA could focus controls within the background TextEdit window, but GVoice's system-wide foreground snapshot still reported Finder (PID 619). The native test session's explicit PID guard refused before mutating the clipboard or sending a paste. The user subsequently explained that they were using the computer during testing. Terminal automation was denied by the desktop tool with: `Computer Use is not allowed to use the app 'com.apple.Terminal' for safety reasons.` No alternate route was used to bypass that restriction.

The independent repository desktop suite successfully launched its separate editable Electron target with Accessibility permission. Actual local Whisper decoded the existing quick-fox audio fixture correctly. At delivery, the source log recorded:

```json
{"len":44,"ms":134,"fieldFocused":true,"pasted":false,"verified":null,"deliveryState":"refused","sourcePid":24996,"ownership":"different","clipboardRetained":true}
```

The saved history entry exactly matched the expected 44-character fixture sentence. This proves refusal and recovery during concurrent desktop use, not a paste defect. That first `pnpm test:electron` run exited 1 with `Native paste failed; dictation was preserved in recoverable history`. Its profile was `/var/folders/sw/f6y50w2j4v59nbd87scn9f5m0000gn/T/gvoice-regression-YsoMHK`.

After the user's clarification, the primary requested an untouched desktop and reran the same suite without changing source. **It passed**, including first and warm speech-to-native-paste (observed 1743 ms and 1331 ms after release), duplicate/stale transcript handling, native selected-text capture, offline edit preview, Apply, and Undo. The generated screenshot was visually inspected and showed the exact fixture sentence once in the external target. Passing profile: `/var/folders/sw/f6y50w2j4v59nbd87scn9f5m0000gn/T/gvoice-regression-Y44goE`. These two timings are single fixture observations, not performance guarantees. The existing profiles/benchmark desktop suite passed afterward.

The isolated source/test instances were closed. The original installed app remained running. Scratch TextEdit and cmux targets contain no injected dictation and may be reused. The temporary browser test server was stopped.

## Build and installed-artifact identity

Final local build: `dist/mac-arm64/GVoice.app`.

```json
{
  "revision": "43568bbe8ccba0f1662dfd8d26a17d80dec91537",
  "sourceDigest": "5b6e399172c5682560f9c609d500e13fdc935c68badf5e20b3c2a7c4fde2aa20",
  "builtAt": "2026-09-08T09:26:26.103Z"
}
```

The still-installed `/Applications/GVoice.app` is dated 2026-08-30 and its process (PID 820) started 2026-09-04. Its archive lacks the clipboard-lease module and current source ownership fields. Installed `main.js` SHA256: `d972b3b330192a717c9b2a5808e1da01e48492bec3850e125208d847119206d6`. No rollback or replacement was attempted because the source-build acceptance checks did not pass.

## Remaining work

1. Complete step 1 native sentinel repetitions in TextEdit, a Chromium field, Terminal, and cmux with stable real foreground focus; verify the actual tray and inspect recovery. Terminal needs a permitted or user-operated verification path. Do not remove focus guards to make the test pass.
2. Implement Faithful/Clean/Rewrite processing modes, then verify as planned.
3. Implement and verify the searchable history panel.
4. Implement and verify contextual, explicitly accepted vocabulary learning.
5. Implement and verify allowlisted explicit voice-command mode.
6. Run full integration, including provider prerequisites and profiles/benchmark desktop tests, then preserve rollback and install only after all preceding checks pass. Verify microphone persistence and real capture, installed build identity, and real spoken output. None of these installed/hardware checks is claimed here.

The native-suite failure was resolved by coordinating desktop use, without altering the fix or weakening its focus guard. The plan's separate four-app acceptance checks remain outstanding. An asynchronous question asks whether to keep their original step-1 gate or defer them to the mandatory final installation gate while implementing steps 2-5; no deferral is assumed without the user's answer.
