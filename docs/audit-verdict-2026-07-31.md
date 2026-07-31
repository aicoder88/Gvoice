# Verdict on the 28-item audit — verified against the code, 2026-07-31

Read-only pass. Every claim below was opened in the actual file (and, for the
packaging item, inside the built `dist/mac-arm64/GVoice.app`). No code changed.

**Short answer: mostly agree on the shape, disagree hard on the ranking.** The
audit's #1 is a decision you already made on purpose. Its #5 is a nuisance, not
a top-five. Meanwhile the only defect that is *shipping and broken right now*
is buried as a sub-bullet inside item #24.

Line numbers in the audit drift by 1–3 lines in several places (e.g. it cites
`main.js:1060` for the hotkey handlers, which are at 1062–1063). The findings
still land on the right code — trust the audit's shape, spot-check its
specifics.

---

## Corrected priority order

| # | Item | Why it moves |
|---|------|--------------|
| 1 | `models/vocab.txt` missing from the build (audit #24) | Only currently-shipping runtime defect. Fails silently. One-line fix. |
| 2 | Microphone preference never persisted (audit #3) | The one place the code contradicts this repo's own hard rule in `CLAUDE.md:39`. |
| 3 | Full transcripts written to the log file (audit #2) | Real privacy exposure, cheap to fix. |
| 4 | Doc contradictions — language cycle, "nothing leaves the machine" (audit #27) | Two of these are user-facing false statements, not tidiness. |
| 5 | Settings save during an active hold reloads the renderer (audit #4) | Real, narrow, and a queue fixes it. |

Everything else in the audit is either correct-but-minor, partly wrong, or a
decision you already took.

---

## Item-by-item

### ALREADY DECIDED — not findings

**#1 — Embedded Deepgram key.** Correct that it exists (`realtime-relay.js:28`,
XOR pad `0x5A`) and ships via `package.json`. But the comment directly above it
spells out the entire risk: public repo, recoverable from the `.app`, bills to
the owner's account, may be scanner-revoked, and names the Groq key in
`src/cleanup.js` as the same pattern with no spend risk. This is a documented
owner decision with the downside already written down. Closing it as
already-decided.

### CONFIRMED

**#24 (sub-bullet) — `models/vocab.txt` is not in the packaged app.** ⚠️ *The
one item to fix today.*
`package.json` `build.files` lists no `models/` entry. `src/vocab.js:23` reads
`join(__dirname, "..", "models", "vocab.txt")`. `find` inside
`dist/mac-arm64/GVoice.app` returns nothing — the file is genuinely absent from
the shipped bundle. `src/vocab.js:95–102` wraps the read in `try { … } catch {}`,
so the seed set comes back **empty and nothing errors**.

Consequences in the built app: `correctTranscript()` (`src/vocab.js:271,278`)
loses its "this is already a real word, don't rewrite it" guard, so custom-term
correction can rewrite ordinary English; and `vocab.js:327` stops recognising
seed words as known, so the app can offer to learn words it already knows. Dev
runs from source and looks fine — exactly the class of bug `CLAUDE.md` was
written about.

Fix: add `"models/vocab.txt"` to `build.files`. Name the file explicitly, not
`models/**/*` — that would drag `ggml-small-q5_1.bin` into every build.

**#3 — Microphone preference is renderer-memory only.** `public/dictation.js:143`
holds `lastGoodDeviceId` as a module variable; `src/settings.js:105–155` has no
mic key; `public/settings.html` has no microphone picker at all. Restart,
renderer reload, provider switch, or crash-reload all reset it, and the recovery
scan at `dictation.js:702–745` may land on any input producing sound. This is
the audit's most important structural finding and it directly contradicts
`CLAUDE.md:39`.

**#2 — Transcripts land in the log.** `public/dictation.js:405` logs `"Final: " +
text`; `main.js:867` funnels renderer console output into the app log;
`main.js:1129` and `main.js:1139` log original and corrected text. Anything
dictated — passwords, client data, medical or legal content — persists in
`debug.log`. Correct as written.

**#4 — Settings save reloads the recording renderer.** `main.js:2371` calls
`reloadDictationWindow()` whenever the dictation URL changes, with no check for
an in-flight hold. The page owns the mic stream, the socket, and the buffers, so
navigating mid-hold loses the recording. Real; the fix is to defer the reload
until the generation ends.

**#27 — Documentation contradicts the code.** `README.md:15` still advertises
"Tap right Ctrl to cycle the dictation language (Auto → Croatian → English)";
`main.js:903` hard-locks `DICTATION_LANGUAGE = "en"` at module load. `SETUP.md:9`
says "nothing leaves the computer" for local Whisper, while `SETUP.md:58` on the
same page says cleanup ships with a Groq key and is on by default. `SETUP.md:11`
tells macOS users to run setup from inside the app; `SETUP.md:58` says that panel
"isn't wired up yet" on macOS. Three user-facing false statements.

**#9 — `whisper-cli` has no deadline.** `src/providers/whisper-local.js:715`
(`runWhisper`) resolves only on `close` or `error`. No timeout, no kill path, no
disconnect handling. A native hang holds the child, its temp WAV, and its CPU
until app exit.

**#10 — Clipboard restore is unconditional.** `src/typing.js:134` restores after
250 ms with no check that the clipboard still holds what GVoice wrote. Copy
something in that window and it's gone. Guarding on the injected payload is a
two-line change.

**#11 — Settings writes are not atomic.** `src/settings.js:112` (`writeEnvFile`)
does a bare `writeFileSync` over the live `.env`. `src/history.js` already
demonstrates temp-file-plus-rename in this repo — reuse it rather than inventing
anything.

**#21 / #25 — No CI, no lint, no typecheck.** No `.github/`, no `lint` or
`typecheck` script in `package.json`. Accurate.

**#20 — No CSP.** No `Content-Security-Policy` anywhere in `server.js` or the
HTML. Five of seven pages carry an inline `<script>`. Accurate, and currently
unreachable — every page loads bundled local markup.

### PARTLY RIGHT

**#5 — Hotkey/tray hold ownership. Overranked.** True that `main.js:1062` ignores
`startDictation()`'s return value while the tray at `main.js:2114` respects it.
But `fireRelease()` (`main.js:1031`) gates on `dictation.release()`, so a release
with no active hold is already a no-op. The actual damage: releasing the hotkey
stops a tray-started recording — a stop, caused by the user pressing the stop key.
Low severity, not top five.

**#8 — Socket left open when the mic fails. Overstated.** The mic-failure path at
`dictation.js:946` does return without closing the socket from
`ensureSocket()`. But `socket` is a single module-level variable and
`ensureSocket()` closes the previous one on the next press
(`dictation.js:230–232`). So this is one idle socket at a time, replaced on the
next attempt — not accumulating sessions, and Deepgram bills streamed audio, not
idle connections. Worth tidying; not a cost risk.

**#14 — The wipe control. Mostly already fixed.** The button already reads
"Delete all recordings" (`public/settings.html:251`) and the confirm dialog
matches (`:352`). Only the row *label* still says "Wipe everything now" — a
one-word edit, not a redesign. The valid half stands: `history.json` and the logs
survive that button, so there is no true delete-everything action.

**#13 — "On-device" is not fully offline.** Correct that local Whisper still
sends the transcript to Groq for cleanup by default (`main.js:1143`,
`src/cleanup.js:44`). This is the same fact as the `SETUP.md:9` contradiction —
one fix, not two items. Whether it needs a new "Fully offline" mode or just
honest wording is your call; the wording is the cheap half.

**#7 — Renderer crash handling.** `main.js:873` does reload on
`render-process-gone` and does log it. What it doesn't do is fail the active
`DictationSession`, so a hold in flight waits out the 25 s safety timer
(`main.js:1053`). Real, but the recovery exists — this is a slow recovery, not a
dead app.

**#6 — macOS paste target.** Accurate that `captureForegroundWindow()` is a
Windows-only stub (`src/foreground.js:11–17`). But the comment states the
reasoning: Electron doesn't steal focus during IPC on macOS the way it does on
Windows. The residual risk is only the user switching apps *during* transcription.
A documented tradeoff, not an oversight.

**#12 — Recording save/delete race.** `clearRecordings()`
(`src/recordings.js:103`) swallows `unlink` failures and returns the count found,
not the count deleted — that half is correct and worth fixing, since a privacy
delete should never claim success while files remain. The save-during-delete race
needs two dictations overlapping a wipe click; theoretical.

**#22 — Test command determinism.** Correct that `pnpm test` runs unit plus
parity, and parity contacts live Deepgram and starts local Whisper. Splitting
offline from live is right. `--test-force-exit` only appears on the parity run,
not the unit run.

**#15 — Relay authentication.** Correct that `realtime-relay.js:106` allows any
loopback origin and all originless clients. The exposure is any *other* process
already running on this Mac. A per-launch token is cheap; treat it as
defense-in-depth, not an open door.

**#17 — Keys returned to the renderer.** `src/settings.js:146–147` does return
full keys. The comment says this is deliberate so the field stays editable. Moving
to `safeStorage` is a genuine improvement but it is a redesign of the settings
window, not a patch.

**#19 — macOS entitlements.** Read the file: `allow-jit`,
`allow-unsigned-executable-memory`, and `allow-dyld-environment-variables` are
Electron's own requirements under hardened runtime, and
`disable-library-validation` is there for the rebuilt native modules with a
comment saying so. The mac target is `dir` and the app isn't signed or notarized
today, so this changes nothing until you ship signed builds.

**#26 — Split the monoliths.** The sizes are right (`main.js` 2562,
`public/dictation.js` 1166). `docs/REFACTOR.md` already exists. Do this behind
tests, after the correctness items — not before.

### UNVERIFIED

**#16 — Windows binary digests.** `src/model-download.js` contains no `sha`,
`digest`, `checksum`, or `hash` — the absence is confirmed. Not confirmed:
whether the download source already provides integrity another way, and this only
affects the Windows setup path.

**#18 — IPC sender checks.** Not audited handler by handler. The navigation half
is confirmed: `main.js:2417–2419` allows any `file://` and any loopback port.

**#23 — Missing lifecycle tests.** The gap is real — 16 unit test files, all over
pure helpers, none over `main.js` or `public/dictation.js`. The listed scenarios
are a good list. Not independently verified as the *highest-value* ten.

**#28 — Dependency weight.** `pnpm audit` not re-run. `@nut-tree-fork/nut-js` is
in `dependencies` and, per `src/typing.js:143`, only used on the non-clipboard
typing path. Removing it is plausible; confirm no Linux/direct-type path depends
on it first.

---

## Where the audit is right about the codebase overall

The favourable half of the report holds up: `contextIsolation` on, `nodeIntegration`
off, `sandbox: true` on the dictation window; the relay binds loopback;
`DictationSession` generation-guarding is real and used; recording retention is
bounded; `src/history.js` already writes atomically; native commands use argument
arrays. The defensive intent is genuine and the comments explain *why*, not *what*
— that is why several audit items resolve to "already decided" rather than
"missed".

## If you want an order to actually work in

1. Add `models/vocab.txt` to `build.files`, rebuild, confirm the file is inside
   the `.app` and vocabulary correction behaves.
2. Persist the chosen microphone (setting + picker), then restart-test it per
   `CLAUDE.md:39`.
3. Replace logged transcripts with character counts and timings; delete existing
   `debug.log` copies on upgrade.
4. Fix the three false doc statements — right-Ctrl language cycle, "nothing
   leaves the computer", macOS setup panel.
5. Queue the settings-triggered reload until the hold ends.

Items 6 through 28 after that, in the audit's own order.
