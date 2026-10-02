# Decisions

One entry per structural decision, newest first. Each carries the reason it was
made and the condition that would reverse it.

## 2026-09-12 – A saved dictionary name may replace the word it was misheard as

`preservesSpeakerWords` in `src/cleanup.js` compared the cleanup model's output
to the raw transcript word for word. Any replaced word meant a rewrite, and the
whole result was thrown away. That guard is right for ordinary words and wrong
for names: measured this day on six speech engines, every English error GVoice
made was a name ("purify" for Purrify, "anchor" for Anker, "Deep Gram" for
Deepgram), the cleanup model proposed the correct fix for all of them once the
terms were saved, and the guard reverted every one. The dictionary feature could
not work at all through this path.

The guard now lets a run of up to three transcript words collapse into a single
saved term, via `vocab.isTermSubstitution`. A rejoined split name must match
near-exactly; a single word swapped whole gets a looser bar, because the model
has already judged the sentence and the only thing it may insert is a term the
user typed themselves.

Verified end to end the same day: real clip, whisper small.en hears "The anchor
microphone", GVoice pastes "The Anker microphone".

**Reverse if:** the cleanup model starts swapping ordinary speech for dictionary
terms, for example a spoken "answer" arriving as "Anker". The exemption is
bounded by the saved term list, so the first repair is to prune the dictionary
to rare proper nouns. If that is not enough, tighten the single-word rule in
`isTermSubstitution` to require an exact rejoin, the same bar multi-word runs
already use, and accept that "anchor" for Anker goes back to being unfixable.

**Not changed:** `correctTranscript` still runs blind on every transcript and
keeps its strict rules. Loosening that one would rewrite ordinary speech with no
model reading the context.

**Known gap:** a term that also appears in `models/vocab.txt` is skipped by
`correctTranscript`, so "Purrify" gets no blind repair. The cleanup path now
covers it, so this is cosmetic rather than urgent.

## 2026-09-12 – Two machines' versions get joined, never picked between

Two machines built GVoice in parallel and each rewrote the same tidy-up pass and
the same paste path. Twice now a session has faced "which version wins" and the
honest answer both times was neither.

**Decided:** where both machines solved the same problem, keep both halves and
make them work together, rather than taking one and deleting the other. Done
once today for the tidy-up pass: the backup model from one machine and the
word-preserving guard from the other now both run. A retired or busy engine
falls through to a backup; whatever answers is still thrown away if it changed
the speaker's words.

**Also decided:** a join bigger than about ten clashes stops and becomes a
written plan first. The second join that surfaced today is 32 clashes across two
different designs of the same paste path, so it went to
`docs/plans/join-the-two-gvoice-versions-into-one.md` instead of being attempted
on the spot. This Mac's 34 commits went to the branch
`gvoice-thismac-2026-09-12` so nothing depends on either machine staying alive.

**Reverse if:** the parallel work stops. Once one machine is the only one
building GVoice, this costs effort and buys nothing, and a plain merge is right
again.

## 2026-09-12 – The named press wins, because it already contains the numbered one

The join plan's first step asked which way a press should be identified: this
Mac names each one, the other machine numbers them. It turned out not to be a
choice.

**The evidence:** this Mac's session object already carries both. `generation`
is a counter that only ever climbs, and `id` is minted from it as
`"<generation>-<random>"`. Every place the other machine keys off a number can
keep doing so, unchanged, against the same counter. The name adds what a bare
counter cannot do: recognise one specific press after it has ended, which is
what cancelling a dictation whose words already arrived depends on.

Counted references: 128 on the name, 40 on the number, plus the other machine's
timing, voice editing and benchmark hanging off the number indirectly. All of
them survive, because the counter survives.

**Decided:** the named press is the spine. `claimTerminal` is the one thing the
other machine's session had and this one did not, so it comes across rather
than being dropped.

**Reverse if:** the name ever stops being minted from the counter. The moment
those two drift apart, code keying off the number is no longer safe and the
whole scheme has to be picked apart again.

---

## From the other machine, 7 to 9 September 2026

Written on the other machine before the two versions were joined. Kept as written.

### 2026-09-07 – When we cannot tell which app is in front, we do NOT paste

`src/paste-confidence.js` → `decidePasteOwnership`

A dictation is pasted only into the app that owned the field when the hotkey was
pressed. If the system's focus read comes back with nothing (asked twice), the
paste is refused rather than sent blind. The refusal is not reported as a
failure: the text goes on the clipboard and the pill says where it is.

Why: the mistakes are not the same size. A wrong refusal costs one ⌘V. A wrong
paste puts a dictation inside another application's window and cannot be undone.
Confirmed by the owner 2026-09-07, asked as a plain yes/no after the change was
built. Measured 2026-09-07 on this machine: the app that most often answers a
system-wide focused-element read with nothing is Chrome – so "couldn't tell" and
"a different app is in front" are usually the same situation. Built the opposite
way first (the code review recommended it) and it pasted a test sentence into a
live Chrome window.

Reverse if: users report dictations routinely not landing while they never left
the app – i.e. the unknown answer turns out to be common on healthy machines.
Watch the `ownership` field in the paste log. To reverse: `decidePasteOwnership`
returns `"same"` instead of `"unknown"` when `currentPid == null`.

### 2026-09-07 – A refused paste puts the text on the clipboard

**Reversed 2026-09-15** by "A dictation never keeps the clipboard" below.

`main.js` → `releaseClipboard`

When a paste is refused or typed by keyboard, nothing of ours has reached the
clipboard, so the dictation is written there and one ⌘V recovers it.

Why: without it the pill said "Click Copy" about a clipboard that never received
the text. The earlier fixes pass (2026-09-07, first pass) deliberately left this
out – "you moved on, and quietly replacing whatever you copied would be worse" –
and put it to the owner as an open question. He answered it directly on
2026-09-07, told the cost in plain words: keep it.

Cost: a dictation you walked away from replaces whatever you had copied.

Reverse if: the owner finds his clipboard being taken over. To reverse: drop the
no-hold branch at the end of `releaseClipboard` in `main.js`.

## 2026-09-12 – An unconfirmed paste keeps the words on the clipboard

**Reversed 2026-09-15** by "A dictation never keeps the clipboard" below.

`src/clipboard-lease.js` → `finish`

When GVoice cannot confirm a paste landed, the words stay on the clipboard in
place of what was copied before. That covers every terminal, cmux included,
because a terminal's text cannot be read back. The old clipboard comes back
only after a verified paste.

Why: a timer that put the old clipboard back after an unconfirmed paste could
wipe the only copy of words that never landed. Both machines logged that bug
separately. Losing a copied snippet costs one re-copy; losing a dictation
cannot be undone. Confirmed by the owner 2026-09-12 as a plain yes, told the
cost: every terminal dictation replaces what he had copied. Sibling of the
2026-09-07 entry "A refused paste puts the text on the clipboard".

Reverse if: the owner finds terminal dictations eating clipboard contents he
needed. To reverse: in `finish`, restore the snapshot for `'sent-unverified'`
as well as `'verified'`, and accept that an undelivered dictation can then be
wiped.

## 2026-09-12 – A terminal paste shows plain Success, not "Delivery unverified"

`main.js` → `processTranscript`, the `notice` line

A paste into a recognised terminal (cmux, Terminal, iTerm and the rest in
`src/paste-confidence.js`) can never be read back, so it always ends
"sent-unverified". The pill no longer says "Delivery unverified" for those. It
says Success. The words still stay on the clipboard, per the entry above.
Other apps whose text can't be read still get the warning.

Why: the owner dictates into cmux all day and saw the warning on every
working paste. His words, 2026-09-12: "Get rid of that warning when I'm using
it in terminal."

Reverse if: a terminal paste goes missing and the plain Success hid it. To
reverse: drop the `pastedIntoTerminal` clause from the `notice` line.

## 2026-09-15 – A dictation never keeps the clipboard

`src/clipboard-lease.js` → `finish`; `src/typing.js` → `refusedDelivery`;
`main.js` → `processTranscript`, `retranscribeRecording`

The clipboard is borrowed only for the paste keystroke. Whatever you had copied
comes back after every dictation: at once after a paste GVoice read back, 600 ms
later after one it could not (every terminal). A dictation that is not pasted
never touches the clipboard at all. The words live in Recent dictations and on
the pill's Copy button. A copy you make during the wait wins.

Why: the owner's words, 2026-09-15: "transcriptions should not be copied onto
the clipboard, overwriting it. they should be saved in history, and pasted into
the active window, so i can use or copy them if I want, but keep my current
clipboard". This reverses the 2026-09-07 and 2026-09-12 entries above. Their
worry, losing the only copy of words that never landed, is covered by history.

Cost: a dictation that did not land needs one click on Copy (pill or tray)
instead of ⌘V. An app that takes longer than the wait to accept a paste would
paste your old clipboard instead of the words.

Reverse if: a paste ever lands your old clipboard instead of the dictation.
First try raising the wait (`CLIPBOARD_RESTORE_DELAY_MS`). To reverse fully:
in `finish`, restore only for `'verified'`, and write the text in
`refusedDelivery` again.

## 2026-09-15 - Windows skips the Unix-only companion server

Windows startup no longer tries to listen on `control/gvoice.sock`. The Better
Options companion uses a Unix-domain socket, while Node uses named pipes for
Windows IPC. This mismatch caused EACCES on every Windows launch. Keyboard
dictation, tray controls and the shared capture/delivery pipeline still run.
The server also rejects direct Windows starts before creating any files.

The Unix integration suite is explicitly excluded on Windows. Portable path
and preference-error tests still run, along with a Windows unsupported-start
check. `scripts/electron/windows-compatibility.mjs` checks the running Windows
app using an isolated profile and fake media.

Why: there is no Windows companion client in this product. Adding a named-pipe
protocol and its access controls would expand this compatibility fix.

Reverse if: a Windows companion client is added. Implement and test a Windows
transport with per-user access control before enabling companion startup.

## 2026-09-15 - Reconnect microphone preferences after the relay origin changes

The local relay chooses a fresh port at launch. Browser microphone IDs depend
on the origin, so a saved ID can disappear even while the same microphone is
plugged in. A running Windows regression reproduced this: Settings kept Fake
Audio Input 1 selected while capture used Fake Default Audio Input.

When the saved ID is absent, an exact, unique microphone label can reconnect
the choice to its current ID. Both capture selection and the preferences
store use the same resolver. The original ID wins whenever it is still present.
An absent, unlabeled or ambiguously named device keeps the existing fallback
behavior. Reconnecting writes only preferences.json, never environment keys.

Cost: two identical models with identical labels cannot be distinguished after
an origin change. The user must select the intended device again in that case.

Reverse if: a unique label resolves to a different physical microphone. Prefer
a stable app origin or a native persistent device identity before removing
the label fallback.
