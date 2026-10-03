---
name: tier
description: |
  Execute a written plan with each step running at its own model and reasoning effort,
  translating portable tier tags to the models available in Claude or Codex. Reads
  model/effort tags from a plan and runs eligible steps immediately via parallel
  subagents. Use when the user types /tier, says "run the plan", "execute this plan",
  "run it at the right effort levels", or "dispatch the plan". Also use when writing
  a plan, to tag every step with the model and effort it needs.
---

# tier – run a plan at per-step model + effort

Two jobs. Tagging (when a plan is written) and dispatch (when it is run).

## The tag format

One bracket at the end of a numbered step line. Portable tags work on every runner:

`[opus/high]`  `[sonnet/low]`  `[haiku/low]`  `[opus/medium]`

Portable model: `fable` | `opus` | `sonnet` | `haiku`
Effort: `low` | `medium` | `high` | `xhigh` | `max` (`med` is an accepted alias for
`medium` – 38 older plans use it; write `medium` in new plans)

Codex-native model tags are also valid when a plan deliberately targets Codex:

`[gpt-6.1-sol/medium]`  `[gpt-6-luna/low]`  `[gpt-6-astra/high]`

Valid Codex-native models and callable effort ranges (Codex tools, 2026-09-30):

| Codex model | Accepts | Role |
|---|---|---|
| `gpt-6.1-sol` | low - ultra | normal worker; start at medium |
| `gpt-6-luna` | low - max | mechanical worker; start at low |
| `gpt-6-astra` | low - ultra | explicit escalation for demanding judgment; start at high |
| `gpt-6-sol` | low - ultra | previous Sol generation; preserve historical tags |
| `gpt-5.6-sol` | low - ultra | historical workhorse |
| `gpt-5.6-terra` | low - ultra | historical balanced worker |
| `gpt-5.6-luna` | low - max | historical mechanical worker |
| `gpt-5.5` | low - xhigh | historical worker |
| `gpt-5.3-codex-spark` | low - xhigh | historical mechanical worker; check availability |

The Accepts column is what Codex's own model list advertises, not what a plan may write.
A tag only ever carries one of the five efforts above, so `ultra` never appears in one,
even against a model that would take it.

A native tag is never remapped.

One pay-per-use lane is also valid: `[deepseek/low]` `[deepseek/medium]` - DeepSeek V4.1
Flash on OpenRouter (USD 0.15 per million in, 0.60 out, 2026-09-14), run through Codex's
`deepseek` profile. Efforts `low` and `medium` only; anything higher is not a lane step.

The hub repository owns this package; tracked repository copies use this same folder
without requiring a personal skill installation or a machine-specific hub path.
The `check-tags.mjs` helper and its behavior checks are included. Hub history/docs
are optional background; missing optional references do not block native dispatch.
If `codex-lane` is absent, use a callable worker on the same or stronger rung at
the preserved effort and disclose the substitution; never install tools or bypass
approval gates implicitly.
On Windows, refresh only the tier package in installed Claude/Codex skill folders;
preserve launcher, hook, account and machine adaptations.

Nothing else is required. No YAML, no separate config file. The tag is the contract. Do
not add a second model tag for compatibility; runner translation handles that.

### Where a tag may sit (checked by `check-tags.mjs`, 2026-09-17)

A step line is a heading that starts with a number or "Step N" (`### 4. Title`,
`## Step 2 – Title`), or a numbered list item at the start of a line
(`3. Do the thing.`). A list item may wrap; its tag goes at the end of its paragraph,
before any `-> verify:` line.

1. **Tags go on step lines only.** Never on a context, brief, reference or measurement
   section, never on a heading that is not a numbered step, never in a table row.
2. **One level.** Every tag in a plan sits on the same kind of step line. A plan with
   numbered briefing sections (`## 2. The copy`) and a steps list keeps the sections
   untagged, however much work they describe. A step that feeds on a brief names the
   section in its text ("brief: section 2").
3. **One tag per step, every step tagged.** A step still waiting on a gate, or marked
   DONE, may stay untagged until it runs.
4. **Valid pairs only**: the models and efforts above.

Check any plan before handing it over:
`node <this skill folder>/check-tags.mjs <plan.md>` (exit 1 lists each misplaced tag
by line). A Stop lock, `global-skills/hooks/plan-tags-in-right-place.mjs`, runs the
same check on every plan a turn wrote, for Claude and Codex.

Old plans only: a prose line `Model/effort: Sonnet, medium` inside a step. The checker
warns and reports that step's tag as empty; read the line for that step by hand. Never
write one in a new plan.

Untagged step: default to portable `sonnet/medium` and list it as UNTAGGED in the dispatch
table so the owner can see what was assumed.

## Runner translation

Detect the current runner from the callable subagent tools and their advertised models. Do
not infer it from the repository or rewrite the plan merely because the runner changed.

On Claude, portable tags keep their named model and effort. Cheap-lane tags leave
Claude and run from Bash through `~/.claude/bin/codex-lane` (it finds Codex, retries
once when the host is busy, logs to `<repo>/.claude/lane-runs/`):

| Tag | Command |
|---|---|
| `gpt-5.3-codex-spark/<effort>` | `codex-lane --model gpt-5.3-codex-spark --effort <effort> <repo> "<prompt>"` |
| any other `gpt-*/<effort>` | the same, with that model |
| `deepseek/<effort>` | `codex-lane --effort <effort> <repo> "<prompt>"` |

On Codex, `deepseek/*` runs through the same `codex-lane` line from the shell.
Exit 3 means no key or no Codex: use a callable mechanical worker at the same effort
and disclose the substitution; on Claude use `haiku/<same effort>`.

On Codex, translate portable models before dispatch. The 2026-09-05 directive that
sent every tier to `gpt-6-astra` is REVOKED (owner, 2026-09-12): it made effort the
only real choice and put mechanical steps on the most expensive model.

| Portable tag model | Codex model |
|---|---|
| `fable` | `gpt-6-astra` |
| `opus` | `gpt-6-astra` |
| `sonnet` | `gpt-6.1-sol` |
| `haiku` | `gpt-6-luna` |

Use `gpt-6.1-sol/medium` for normal implementation and untagged Codex work,
`gpt-6-luna/low` for mechanics, and `gpt-6-astra/high` only for an explicit demanding
judgment or independent review step. Portable `opus` and `fable` remain explicit Astra
escalations; preserve their requested effort. Revenue work alone does not require Astra
when a bounded implementation and verification can be handled by `gpt-6.1-sol/high`.
Sol reviews Luna output and its checks before dependent work begins. Do not use Luna
for customer copy, translations, or unbounded decisions.

Every model recommendation, including summaries, questions and handoffs, names both
model and effort. Preserve effort, normalizing only legacy `med` to `medium`.
Historical Spark and `gpt-5.5` tags cap at `xhigh`; never silently lower effort.

Preserve every Codex-native tag exactly as written, any model in the table above. Do
not migrate a native tag in either direction, and
do not rewrite historical plan files or rerun finished steps.

A fresh user instruction naming a different model for the run overrides only the model
column. Effort, dependencies, verification, completion state and gates stay unchanged.

Check the runner's advertised model and effort support before dispatch. The table is
a dated snapshot, not proof of account availability. If a mapped model or
the requested effort is unavailable, substitute the nearest callable model on the same
or a stronger rung and disclose the substitution in the run report; never silently route
to a weaker model, and never silently lower effort. Record planned versus actual model
and effort per step in the run report, not in the chat reply. These are execution
adapters, not plan retagging.

## Job 0 – the handover contract (every plan, every repo, every machine)

A plan is not delivered until all four are true, in this order. Owner directive
2026-08-22, after three dispatches died on a path that did not exist:

1. The file is saved at `<repo>/docs/plans/<slug>.md` - a plain, committable folder. Not
   the scratchpad, not `~/.claude*/plans`, not a worktree, not `/tmp`.
2. The file's last line is `/tier /abs/path/to/that/same/file.md`. That line is the one
   source of truth for where the plan lives; the locks move the file to match it.
3. You have run `ls -la <that path>` in this turn and seen it. Not "it should be there".
4. Your reply links the saved plan and includes `/tier /abs/path/...md` once.
   Put any necessary numbered A/B decisions after links and commands, with a
   recommendation and consequences. No compulsory card, scoring or recap.
   The saved file still ends with its machine-readable `/tier` footer for the path guards.

Machine-enforced by four locks in `global-skills/hooks/` (plan-lands-in-repo,
plan-filename-matches-title, plan-path-matches-tier-line, plan-handover-has-tier-line).
They are the backstop. The contract above is the habit.

## Job 1 – tagging a plan

When writing or reviewing a portable plan, put one portable tag on every numbered step and
nowhere else (see "Where a tag may sit"). A section is never tagged, even when all its
steps share a tier: tag each step. Use a Codex-native tag only when the user
explicitly wants a Codex-specific plan. Pick the workload tier with this rule:

- `gpt-6-luna/low` – pure mechanics no customer ever sees: rename, move a
  file, add a link, a script, test scaffolding, docs. Draws on the ChatGPT plan Drago
  already pays for, so it saves Claude's weekly limit at no extra cost. First choice.
- `deepseek/low` – the same mechanics when the Codex allowance is spent or a second
  lane runs side by side. `deepseek/medium` when the file is large or the change spans
  more than three files. Costs OpenRouter credit.
- `haiku/low` – pure mechanics that touch secrets files, customer records, the ledger,
  Stripe or checkout. Use `sonnet/medium` for customer words, never Haiku. Never tag sensitive mechanics as a lane step:
  OpenRouter hosts may keep what they are sent, and lane output skips Claude's rules
  until the verifier sees it. (On Codex, use `gpt-6.1-sol/medium` for sensitive mechanics; never put secrets in a paid lane.)
- `sonnet/low` – wiring with one obvious right answer. Add an env call, add a workflow
  step, add a conditional block.
- `sonnet/medium` – normal feature work. New component, new endpoint, refactor.
- `opus/medium` – diagnosis, or a judgment call with money or data behind it.
- `opus/high` – customer-facing copy on a money page, revenue-path code, security,
  anything where a plausible-but-wrong answer is expensive.
- `fable/high` – rare, ~0–1 steps per plan, and only when the step heading states why:
  a repeat-offender bug Opus already failed on, design-vision QA, strategy synthesis,
  or the anchor step of an overnight pass. 2× Opus price – never routine build work.
  Fable's main use stays outside dispatch: writing/reviewing the plan itself in a
  fresh window. Fable plans, Opus runs.

## Fable jobs

The 20 jobs worth Fable's price (`docs/fable-top-20-uses-2026-09-02.md`), the skill that
runs each, and where it runs. This table says *which* jobs qualify – the "rare, 0–1 steps
per plan" rule above still governs how often `fable/high` shows up in a dispatch.

| # | Job | Skill | Runs as |
|---|---|---|---|
| 1 | Overnight passes | `overnight` (new) | fresh `fable/high` window |
| 2 | Write every plan | `tier` (this skill, Job 1) | fresh `fable/high` window |
| 3 | Bugs that keep coming back | `bug-hunt` (new) | fable/high step |
| 4 | "It worked yesterday" hunts | `diagnose` (new) | fable/high step |
| 5 | Money-path reviews | `money-review` (new) | fable/high step |
| 6 | Strategy sessions | `strategy` (new) | fresh `fable/high` window |
| 7 | Weekly ranked "what's next" | `whats-next` (existing) | fresh `fable/high` window |
| 8 | Caveman explanations on demand | `explain` (new) | fresh `fable/high` window |
| 9 | Monthly health report | `health-report` (new) | fresh `fable/high` window |
| 10 | Simplicity passes | `simplify-area` (new) | fable/high step |
| 11 | Answer-count discipline | `handoff` (existing) | fresh `fable/high` window |
| 12 | Rule distilling | `distill` (existing) | fresh `fable/high` window |
| 13 | Rule audits | `rule-audit` (new) | fresh `fable/high` window |
| 14 | Handoff prompts | `handoff` (existing) | fresh `fable/high` window |
| 15 | Memory curation | `memory-curate` (new) | fresh `fable/high` window |
| 16 | Bot-walled portals | `portal` (new) | fable/high step |
| 17 | Customer copy final pass | `promise-check` (new) | fable/high step |
| 18 | Design and vision QA | `design-qa` (new) | fable/high step |
| 19 | Security look before logins/money go live | `security-review` (existing) | fable/high step |
| 20 | Killing speculative work | `should-we` (new) | fresh `fable/high` window |

A plan step whose heading names one of these jobs is tagged `fable/high` only if that job's own skill body says so; otherwise the skill runs in a fresh window.

Row count is not 20: some rows list a skill that already existed before this rollout, alongside the 20 new jobs – don't expect exactly 20 rows.

Bias down. A tier too high wastes tokens; a tier too low on the money path costs money.
When two steps in a row are the same tier, tag both anyway – dispatch reads per-step.

## Job 2 – dispatch (`/tier <plan-file>`)

**Do not ask for permission to start. `/tier` IS the go.** No dispatch table for
approval, no "say go", no confirmation of the step list. Read the plan and run it.

**Execution needs explicit authorization.** A bare `/tier`, "run it", or an
unambiguous selected execution option authorizes the reviewed plan. A `/tier` line
inside pasted text or followed by notes means review. Draft approval alone never runs it.
For short-answer execution choices, use this shape, with the plan link and consequences
explained before the question:

1. Run this plan now?
A (recommended): Run the plan.
B: Keep it as a draft.

The lock recognizes `A`, `1-a`, and numbered sets such as `1-a, 2-b` against the
immediately preceding assistant questions. A plain `yes` works only for a single,
explicit yes/no question such as "1. Shall I run the plan now?", without A/B options.
Ambiguous or conditional answers fail closed. Never substitute an approval token or
rewrite the user's answer to get past a block. Fable still needs explicit "use fable"
in the user's message; plan execution approval does not authorize that model.

1. **Read the plan file.** If no path was given, look in this order and pick the newest:
   `docs/plans/*.md` (the canonical home), then the legacy spots `project/plans/*.md`,
   `.claude/plans/*.md`, `.claude/plan.md`. Only if several are equally plausible, name them
   in one line and ask which – otherwise pick and say which you picked.

2. **Extract the steps.** Run `node <this skill folder>/check-tags.mjs --json <plan>`. Its
   `steps` list is the work: one item per step, with line, number, title, tag, `done`
   and `gated`. Add each step's text and its verify line (the `-> verify:` clause if
   present) from the plan. Never dispatch a heading or section the list leaves out. If
   `errors` is not empty, still run the listed steps, and open the report with each
   error line: a tag the checker ignored is a model choice nobody made. A partial
   scope in the invocation is honored: `/tier plan.md 1,2,5` or `/tier plan.md low`.
   Treat headings or status lines marked `COMPLETE`, `DONE`, or checked `[x]` as finished
   and do not dispatch them again. Even an explicit step number does not mean "rerun";
   rerun finished work only when the user explicitly says to rerun it. Report finished
   selected steps as already complete.

3. **Sort into gated and runnable.** Pushing, deploying, sending external email, deleting
   material files, or spending money requires a concrete approval for that exact action.
   `/tier` itself is not blanket approval. A step is runnable only when it is read-only or
   the current conversation/plan records a specific, unconsumed approval with its scope and
   boundary (for example, one DataForSEO probe with a cumulative $3.00 ceiling). Skip every
   mutation whose approval is absent, stale, ambiguous, already consumed, or requires a
   same-session phrase that has not been given. List skipped steps as "needs your go".

   For a bounded approved spend, designate exactly one executor, serialize all paid calls,
   enforce the cap before every call, and mark the approval consumed in the plan or run
   report after use. Parallel subagents may do read-only pricing and analysis, never paid
   calls. Approval for one action never transfers to another action or future run.

4. **Run immediately, in parallel where it is safe.** Translate the model for the current
   runner, then dispatch one subagent per independent step. Steps that touch the same files
   chain in sequence. Give each agent the step text, its verify clause, the plan path, the
   translated model and effort, the approval boundary if any, and the repo's instructions.

   In Codex, use the collaboration subagent tools. `spawn_agent` takes `model` and
   `reasoning_effort`; batch independent work up to the available concurrency limit, then
   reuse idle agents with `followup_task` when useful. Do not use user-visible task/thread
   creation for plan subtasks. If several agents share a filesystem, use separate worktrees
   for independent writers and one writer for overlapping files.

   In a runner with the Workflow tool, call it with one `agent()` per step, using the
   translated `model` and the tag's `effort`:

       export const meta = {
         name: 'tier-dispatch',
         description: 'Run plan steps at their tagged model and effort',
         phases: [{ title: 'Execute' }],
       }
       const PLAN = '<absolute plan path>'
       const STEPS = [ /* { n, text, verify, model, effort, label } */ ]
       const run = s => agent(
         `Plan: ${PLAN}\nStep ${s.n}: ${s.text}\nVerify: ${s.verify}\n` +
         `Do the step. Run the verify. Report what changed and pass/fail.`,
         { label: s.label, phase: 'Execute', model: s.model, effort: s.effort }
       )
       phase('Execute')
       return await parallel(STEPS.map(s => () => run(s)))

   The Workflow `agent()` takes `model` and `effort` per call. Codex `spawn_agent` takes
   `model` and `reasoning_effort`. Passing those values per step is the point of this skill.

   Shape it to the dependency line at the top of the plan: `parallel([...thunks])` for a set
   of independent steps, plain `await` in sequence for a chain, `Promise.all` to run a chain
   and a parallel set at the same time. Reserve `pipeline(items, stage1, stage2)` for real
   multi-stage work (build → verify → judge), not for a flat step list.

   Group steps that edit the same files into one agent rather than racing them. If two
   independent groups both write code, give each `isolation: 'worktree'`.

   **Cheap-lane steps** (`deepseek` and any `gpt-*` tag on a
   Claude runner) run through the `codex-lane` line from Runner translation, never as a
   Claude subagent. Give the prompt the step text, verify clause and repo rules path, plus
   "Do not commit, push or touch secrets files." Lanes that could edit the same files run
   one after another; parallel lanes each get their own worktree. **A lane step is not
   done until a verifier (`sonnet/low` on Claude, `gpt-6.1-sol/medium` on Codex)** reads its `git diff`, runs the verify line
   and the repo's check commands, and passes it. A failed check goes back to Claude, not
   to a second lane try.

   **If neither Codex collaboration nor Workflow is available, do not stop – fall back.**
   Fallback, in order:

   - **Agent tool.** One call per step, same prompt as above, translated `model`, and
     `subagent_type: 'general-purpose'` unless a better-matched agent type is listed. Put
     every independent step's call in ONE message so they run side by side; send dependent
     steps in later messages. The Agent tool takes `model` per call but not `effort` (effort
     comes from the agent type's own definition) – say so in the final report for any step
     whose tag asked for a non-default effort.
   - **No subagent tool available.** Run the steps yourself in dependency order and open the
     report with one line naming which steps did not get their tagged or translated model.
     Never hide a model mismatch.

5. **Report.** One line per step: number, done or blocked, verify pass or fail. Then the
   total, then the gated list. No process narration. Lane steps add planned versus actual
   model, whether the retry fired, and the "tokens used" figure from the lane log.

## Never stop empty-handed – always hand back a continuation prompt

If the run cannot finish, the last thing in the turn is a copy-paste prompt that resumes
it in a fresh window. Three cases:

- **Blocked step.** Finish every step that does not depend on it, then end with the
  blocker in one line plus the continuation prompt.
- **Context filling up.** Do not run to the wall. When context is getting heavy, stop at
  the next clean step boundary, write progress into the plan file (mark finished steps
  DONE), and end the turn with the continuation prompt.
- **Gated steps remain.** Include them in the prompt so the next session picks them up
  after approval.

The continuation prompt is plain text, not a code fence, and contains: the absolute plan
file path, which steps are done, which remain with their tags, any blocker, and the
literal next command (`/tier /abs/path/plan.md 4,5,6`).

## Rules that override the plan

- Never push, deploy, send external email, delete material files, or spend money without a
  concrete approval for that exact action and boundary. A recorded, unconsumed bounded
  approval may be executed once; enforce its stop and mark it consumed. Same-session gates
  remain same-session gates.
- Never invent a tag on a step the plan does not contain. Dispatch runs the plan as written.
- If a step's verify fails, stop that step and report it. Do not improvise a different fix.
  Exception, Drago 2026-09-23: on a bare `/tier`, when the cause is clear and the fix needs no
  gate (no push, deploy, send, delete or spend), fix it in the same run and report it. Never end
  a bare `/tier` run by asking him whether to do the plan's own job.
- Untagged step runs at portable `sonnet/medium`, translated for the current runner, and is
  flagged as assumed in the final report.
