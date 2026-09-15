# Feedback on the tagging of the daily-use plan

For the agent that wrote
`/Users/macmini/dev/voice/docs/plans/gvoice-and-better-options-faster-safer-daily-use.md`
on 2026-09-10. Written by the Claude session that dispatched it the same day.

Short version: the plan itself is strong. The tagging is the weak part, and it is weak in
one specific way – every step names the same model, so the effort tag is carrying the whole
routing decision on its own. Four other things below are worth fixing in the next plan.

---

## 1. One model for every step locks the plan to one runner

Every step is tagged `[gpt-6-astra/<effort>]`. On Codex that is correct and required – the
2026-09-05 owner directive says GPT-6 Astra for every tier. But a Codex-native tag only
travels in one direction. Portable tags (`opus`, `sonnet`, `haiku`, `fable`) translate *down*
to the single Codex model automatically at dispatch. A Codex-native tag cannot translate *up*
into a runner that has a real model ladder, so the dispatcher has to guess.

I had to guess, and I disclosed the guess:

| Plan tag | What I ran on Claude |
|---|---|
| `gpt-6-astra/high` | `opus/high` |
| `gpt-6-astra/medium` | `opus/medium` |
| `gpt-6-astra/low` | `sonnet/low` |

**Recommendation:** write portable tags unless the plan is deliberately Codex-only. Write
`[opus/high]` and `[sonnet/low]`; the Codex dispatcher folds them all into `gpt-6-astra` and
keeps the effort. The same file then runs on either machine with no guessing.

## 2. Which steps went to a cheaper model, and why

Only four: **1, 3, 12, 16**. Every one of them is a step *you* tagged `low`. I did not invent
a cheap tier; I matched the tier you asked for to the model that fits it. Nothing tagged
`medium` or `high` ran below Opus.

- Step 1 – create a side checkout, install packages, count what passes. Pure mechanics.
- Step 3 – route the offline checks around real keys, add one script entry, document it.
- Step 12 – expose one boolean, call it from two places.
- Step 16 – four status lines and a search-and-replace across four documents.

Two of those four I would argue with:

- **Step 16 is not really low.** It writes the words a person reads on the settings page and
  in the tray menu, plus the action-button labels. Copy someone reads is judgment work, not
  mechanics. `medium` is the honest tag.
- **Step 8 is tagged `medium` and should be `high`.** It is the one step that can silently
  destroy something the owner copied to his clipboard. Data-loss paths get the top tier even
  when the code is short. Tier follows the cost of being plausibly wrong, not the line count.

The rubric worth applying: **tag by what a wrong-but-believable answer costs.** Costs money,
data, or a customer's trust, tag high. One obvious right answer, tag low. Line count and
apparent difficulty are not the input.

## 3. A real dependency bug: step 4 must come after step 2

The dependency line says "Steps 3 and 4 need only 1 and can run alongside 2." Step 4 cannot.

Step 4 takes ten timed dictations, which means it launches the app. Step 2 exists precisely so
that launching a dev copy of the app does not reap the installed app's speech engine out of the
shared PID file. Run step 4 alongside step 2 and you take the exact risk step 2 was written to
remove – on the owner's daily-driver machine, with the installed app running.

I ran step 2 to completion first, then steps 3 and 4 together.

## 4. Steps 2 and 3 collide on one file

Both add an entry to `package.json` in the same checkout. Step 2 adds the isolated launcher,
step 3 adds the live-key script. Run concurrently, one clobbers the other's edit or the write
fails. The plan's own rule about `main.js` (same file, so one at a time, in order) is right –
it just was not applied to `package.json`.

I serialized them. Worth stating file overlaps for every parallel pair, not only the big one.

## 5. A verify line asked for something the house rules forbid

Step 3's verify: *"passes with `.env` renamed away (rename back after)"*.

Moving, renaming, copying or deleting a `.env` file is banned outright on this machine – the
rule is fail-closed and has no agent bypass, because three of them have been silently wiped.
A verify line that requires a banned action puts the dispatcher in a bad spot: break the rule,
or improvise a different check and drift from the plan.

The fix is already inside the step. Step 3 introduces `GVOICE_NO_ENV=1`; verify with that flag
instead. I told the agent to substitute it and to say so in its report.

**General form:** before a verify line ships, check it against the hard gates. If meeting it
requires pushing, deploying, sending mail, spending money, or touching a secrets file, it is
not a verify line – it is a gated step of its own.

## 6. Human-only checks are mixed into machine steps

Steps 2, 7, 9, 11, 12, 14, 15 and 18 each end with a "Manual:" clause – hold the physical side
button, switch windows mid-transcription, make a file read-only, unplug the mouse, sleep the
Mac. No agent can do any of those.

The result is a step that is half-verifiable. The dispatcher either reports the step verified
when only the automated half ran, or reports it failed when the code is fine. Both are wrong.

**Recommendation:** keep the automated verify on the numbered step, and collect the physical
checks into a separate lettered checklist at the end of the plan – the tier rules already
reserve numbers for runnable steps. Then the dispatch reports honestly and the owner gets one
short list of things to do with his own hands, instead of eight scattered clauses.

I handled it by instructing every agent to run what it can, then write the rest down as
UNVERIFIED with the exact steps a person must perform, and never to claim a manual check passed.

## 7. How I split the run

Seventeen agents. Step 18 skipped – it quits both running apps and replaces them in
`/Applications`, which is gated and needs the owner's word.

- **Step 1 alone.** Everything depends on the side checkout existing.
- **Then two lanes at once.**
  - GVoice lane: 2, then 3 and 4 together, then the nine-step `main.js` chain
    5 → 6 → 7 → 8 → 9 → 10 one at a time.
  - Better Options lane: 13 → 14, started the moment step 1 finished. It needs nothing from
    the GVoice side, so it runs the whole time the GVoice chain is grinding.
- **After step 10**, step 11 (the Swift socket client, which needs 10 done and 13/14 done)
  runs in parallel with the tail of the GVoice chain, 12 → 15 → 16.
- **Step 17 last**, once all sixteen are in.

Peak concurrency three. The wall-clock floor is the nine-step serial `main.js` chain, and
nothing in the plan can shorten it – which is fine, but worth saying out loud in the plan so
whoever runs it knows the shape of the wait up front.

The prose dependency paragraph was good enough to derive this from. A one-line-per-step
"depends on:" would have made it unambiguous, especially for step 11, whose two prerequisites
sit in two different sentences.

## What the plan got right, and should keep doing

- **"What is true today (checked 2026-09-10, read-only)".** Checked facts with process IDs,
  file paths and line numbers, separated from intentions. This is the single most useful
  section in the file and it is why the agents did not have to re-discover the shared PID file.
- **"Decisions already made (do not re-ask)".** Kills the dribble of clarifying questions.
- **"Not in this pass".** Names the uncommitted cleanup work in the main checkout and tells
  everyone to leave it alone. That is what kept seventeen agents out of another task's edits.
- **The gated step is tagged `GATED` in its heading**, in the right place, at the end.
- **The plan warned about `models/`** – the installed app runs its speech engine from the dev
  folder. That one sentence prevented a real outage.
