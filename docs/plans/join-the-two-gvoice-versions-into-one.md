# Join the two GVoice versions into one

Two machines built GVoice in parallel for a week and each rewrote the same paste
path a different way. Neither is wrong. Neither can simply overwrite the other.
This plan joins them, clash by clash, with a named winner for each.

## Where things stand, 12 September 2026

| | This Mac | The other machine |
| --- | --- | --- |
| On GitHub as | branch `gvoice-thismac-2026-09-12` | branch `main` |
| Commits apart | 34 ahead | 3 ahead, 11,790 lines |
| Built and installed | yes, running in the menu bar | not on this Mac |
| Tests | 324 unit, 3 parity, 1 end-to-end, all pass | not run here |

The app in the menu bar right now is this Mac's version.

### What only this Mac has
Cancel that still works after the words arrive. One press, one named session.
A destination guard that refuses to paste into a window the user walked away
from. Microphone picking that survives a restart. The companion socket that
replaced held-down fake keystrokes. The six-engine speech benchmark. A custom
dictionary that replaces a misheard word. Today's merge of the word-preserving
guard with the backup tidy-up model, plus five code-review fixes.

### What only the other machine has
Voice editing: speak a correction at selected text. Per-app output profiles.
A personal accuracy benchmark with its own window. A clipboard lease and
sequence counter. Build identity. A `deliveryState` record per dictation
(verified / sent-unverified / refused / failed / superseded) in place of a
plain pasted yes-or-no.

### Why they clash
Both rewrote how a press is identified and how a paste is judged.

- This Mac names each press (`sessionId`, `dictation.owns(id)`).
- The other machine numbers each press (`gen`, `isStalePress(gen)`), and hangs
  its timing, voice editing and benchmark off that number.

32 clashes, 18 of them in `main.js`. Full list captured, grouped below.

---

## Step 1 – Choose the spine: named press or numbered press [opus/high] DONE

Everything else depends on this one call, so it is made first and on evidence,
not taste. Count what hangs off each scheme before choosing.

- Named press (this Mac): `sessionId`, `owns`, `markCancelled`, `wasCancelled`,
  the companion socket, cancel-after-the-words-arrive.
- Numbered press (other machine): `gen`, `isStalePress`, `latency.start/finish`,
  voice editing, the benchmark, `superseded` handling.

Write the count and the choice into `docs/context/decisions.md` with its
reverse-if line. The loser's behaviour is not dropped: it is ported onto the
winner in Steps 2 to 6.

-> verify: `docs/context/decisions.md` names the winner, the count behind it,
and what would make us reverse it.

## Step 2 – Join the press-identity code onto the chosen spine [opus/high] DONE

Clashes 3, 10, 11, 12, 13, 19, 21, 22, 26, 27 (`main.js`, `preload.cjs`,
`src/dictation-session.js`).

Both behaviours must survive whichever spine wins:
- A cancel that lands after the words arrive still stops the paste.
- A press that was overtaken by a newer one is recorded as superseded, never
  pasted over the live press.
- Timing measurement starts and finishes once per press.

-> verify: `pnpm run test:unit` passes, including
`scripts/unit/dictation-session.test.js` and `scripts/unit/cancel-and-copy.test.js`.

## Step 3 – Join the paste path [opus/high] DONE

Clashes 2, 4, 6, 7, 8, 14, 16, 31, 32 (`main.js`, `src/typing.js`).

This Mac's destination guard (`src/paste-guard.js`, `captureForegroundTarget`)
and the other machine's clipboard lease, sequence counter, output profiles and
`createTextTyper` factory all live in the same few hundred lines.

Both must survive:
- Nothing is pasted into a window the user moved away from; the words wait on
  the clipboard instead.
- An app that Accessibility never sees a text field in (every terminal, every
  custom editor) still gets its paste. This was a code-review finding today and
  must not be undone by this join.
- The clipboard is handed back as one transaction, and a stale clipboard can
  never be pasted.

-> verify: `pnpm run test:unit` passes, including
`scripts/unit/paste-destination.test.js` (all four terminal cases),
`scripts/unit/clipboard-race.test.js` and `scripts/unit/clipboard-transaction.test.js`.

## Step 4 – Join the two ways a dictation is recorded [opus/medium] DONE

Clashes 16, 29, 30 (`src/history.js`, `main.js`).

The other machine's `deliveryState` is richer than a pasted yes-or-no and should
carry the day, but it has no state for this Mac's two cases: a dictation
cancelled after the words arrived, and one copied rather than pasted because the
destination changed. Add them rather than losing them.

-> verify: `pnpm run test:unit` passes, and the tray's "Recent dictations" list
shows the right label for a cancelled, a copied and a superseded dictation.

## Step 5 – Take the union of the foreground reading [sonnet/medium] DONE

Clash 28 (`src/foreground.js`). This Mac needs `pid` for the destination guard;
the other machine needs `path` for per-app profiles. Return both.

-> verify: `pnpm run test:unit` passes, including the destination and profile tests.

## Step 6 – Bring across the features only one side has [sonnet/medium] DONE

Clashes 5, 9, 18, 20, 23, 24, 25 (`main.js`, `package.json`,
`public/dictation.js`, `public/settings.html`).

From the other machine: voice editing and its window, the benchmark window, the
output-profiles panel in Settings, the `test:electron` script.
From this Mac: the Escape-to-cancel wiring, the microphone panel in Settings,
the preferred-device fallback when a chosen mic will not open.

Settings must show every panel both sides added, not one side's set.

-> verify: the app opens, Settings shows the microphone panel AND the output
panel, and both windows open without an error in the log.

## Step 7 – Settle the documents [haiku/low] DONE

Clash 1 (`docs/context/decisions.md`) and the two README and architecture files.
Keep both machines' entries; do not renumber or reword the other machine's.

-> verify: no conflict markers anywhere: `grep -rn '<<<<<<<' --include='*.js'
--include='*.md' --include='*.json' --include='*.cjs' . | grep -v node_modules`
returns nothing.

## Step 8 – Prove it on the running app, not the diff [opus/high] PARTIAL – 5 of 6 seen

This repo's own rule: a fix is not done until it is seen working.

1. `pnpm test`, `pnpm run test:pipeline-smoke`, `pnpm run test:electron`.
2. `pnpm build`, then install to `/Applications/GVoice.app` and launch it.
3. Confirm the menu-bar icon appears.
4. Dictate into a terminal and watch the words land. This is the fix most at
   risk from this join.
5. Pick a specific microphone in Settings, restart, confirm it is still chosen
   and is the one recording. Still unproven from today's session.
6. Speak a correction at selected text and watch the edit apply.

-> verify: every one of the six observed, each written into the run report with
what was seen, not what was expected.

### Step 8 results, 12 September 2026

| # | Check | Result | What was seen |
| --- | --- | --- | --- |
| 1 | All checks | SEEN | 408 unit, parity, end-to-end smoke, and the Electron regression all pass. The Electron run's own screenshot shows "The quick brown fox jumps over the lazy dog." pasted into its test window. |
| 2 | Build and install | SEEN | Built, signed, installed to `/Applications/GVoice.app`; installed file identical to the build. |
| 3 | Menu-bar icon | SEEN | The G-and-bars icon is on screen after launch. |
| 4 | Dictate into a terminal | SEEN, with a limit | Tray-started dictation into a fresh Terminal.app window: "Purple Elephant 7." landed. Press name carried from key-press to paste, app matched, timing recorded. Limit: Terminal.app reports a normal text field, so the hidden-field branch (cmux) was proved only by the unit test running through the real paste engine, not live. |
| 5 | Microphone choice survives restart | NOT SEEN | Settings opens only from the menu-bar menu. A synthetic click on the menu-bar icon starts push to talk instead; it did so twice, the second time aimed at the live cmux, and GVoice was force-stopped before anything pasted. Needs 30 seconds by hand. |
| 6 | Voice editing | SEEN in the Electron run | Its screenshot shows the edit window with the original selection, the replacement preview and Apply. Not tried by hand on the installed app. |

**Behaviour change to know about:** a paste that cannot be confirmed – every
terminal – now leaves the dictated words on the clipboard in place of what was
copied before. Seen live in check 4. Both machines had independently logged the
opposite bug (a timer restoring the old clipboard wiped the only copy of words
that never landed), so this is the deliberate side of the trade.

## Step 9 – GATED: push the joined version [opus/medium] NEEDS YOUR GO

Needs Drago's word on the day. Nothing here runs on `/tier` alone.

Push `main` only after Step 8 reports all six checks seen. Then delete the
branch `gvoice-thismac-2026-09-12`, which exists only to keep this Mac's work
safe until the join lands.

-> verify: `git status -sb` shows main level with origin, and the branch is gone
from GitHub.

---

## If the join goes wrong

Nothing is lost. This Mac's 34 commits are on GitHub at
`gvoice-thismac-2026-09-12`, and the other machine's work is on `main`. Either
can be checked out whole.

/tier /Users/macmini/dev/voice/docs/plans/join-the-two-gvoice-versions-into-one.md
