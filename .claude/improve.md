# Improve this repo

You are improving **this single repository**. Work only inside this repo's directory.
Your goal: make it simpler, faster, more elegant, more capable, and more correct —
without breaking anything or changing behavior users rely on. Prefer deleting code
over adding it.

---

## Rules of engagement (read first, do not skip)

1. **Branch before you touch anything.** Create a branch:
   `git checkout -b improve/pass-$(date +%Y%m%d)`. Never commit to the default branch.
   **Never push.** The human pushes.
2. **Never touch secrets.** Do not open, print, move, or commit `.env*`, keys, tokens,
   or credentials. If code hardcodes a secret, flag it — don't "fix" it by moving the
   value around.
3. **Respect what exists.** Match the current code's style, naming, and patterns. Do
   not introduce a new framework, language, formatter, or state library because you
   prefer it. Improve within the conventions already here.
4. **Behavior stays the same unless it's a bug.** Refactors must be behavior-preserving.
   If you find a real bug, fix it and say so explicitly in the report.
5. **Every change must be verified.** After each meaningful change, run the repo's
   own checks (see "Verify" below). If you can't verify a change, don't make it.
6. **Small, reviewable commits.** One logical improvement per commit, with a clear
   message. No 2,000-line "cleanup" commits.
7. **If a change is risky or a judgment call, don't do it — list it** in the report
   under "Proposed but not done" so the human decides.

## Step 0 — Understand before changing

- Detect the stack: read `package.json` / `pyproject.toml` / `go.mod` / `Cargo.toml`,
  the README, and any `CLAUDE.md`. Identify the build, test, lint, and typecheck
  commands **actually used here**.
- Map the entry points and the 3–5 files that matter most.
- Note what the repo is *for* — a live customer site behaves differently from a script.
  Live/customer-facing repos: be conservative, favor safe wins.

## Step 1 — The improvement passes

Go dimension by dimension. For each, only act on findings you can verify.

**Simplicity (do this first, it's the highest-leverage)**
- Delete dead code: unused files, exports, functions, variables, imports, CSS, deps.
- Collapse needless abstraction — indirection with a single caller, wrappers that only
  forward, config for things that never vary, "future-proofing" nobody uses.
- Remove duplication: hoist copy-pasted logic into one place *only when it genuinely is
  the same thing* (don't force-merge things that just look alike).
- Cut commented-out code and stale TODOs.

**Correctness & robustness**
- Fix real bugs: unhandled errors, race conditions, off-by-one, wrong async/await,
  missing null checks, resource leaks (unclosed handles/connections), incorrect edge cases.
- Tighten error handling: fail loudly where silence hides problems; stop swallowing errors.
- Fix obviously incorrect types (`any` masking a real shape, wrong nullability).

**Speed & optimization**
- Kill N+1 queries, work inside hot loops, repeated recomputation (memoize/hoist),
  and unnecessary sync I/O on hot paths.
- Web/frontend: oversized images, render-blocking assets, missing lazy-loading, giant
  bundles, unmemoized expensive renders, layout thrash. Measure before/after when you can.
- Backend: missing indexes, unbounded queries, chatty network calls that could batch.
- Don't micro-optimize cold paths or trade real readability for imaginary speed.

**Elegance & readability**
- Clearer names; smaller, single-purpose functions; earlier returns to cut nesting.
- Replace clever one-liners that hide intent with plain, obvious code.
- Make the common case the short case.

**Power & new features (only additive, only if clearly on-mission)**
- Small, obvious wins that fit what the repo already does: a missing CLI flag, a sensible
  default, better error messages, a helpful log line, an obvious accessibility fix.
- Do **not** invent large new features or scope. Propose big ideas in the report instead.

**Best practices & hygiene**
- Update genuinely unsafe/broken dependency versions (note breaking changes; don't blind-bump
  everything). Never change a major version without flagging it.
- Add/lint config only if the repo clearly wants it (a `.eslintrc`, `tsconfig`, etc. already
  present but under-used). Don't impose new tooling.
- Frontend/user-facing text you touch: keep it human — plain, specific, no AI-slop phrasing,
  no em-dash-and-"elevate" filler. Don't rewrite copy you weren't already editing.
- Tighten `.gitignore` if build artifacts or local files are tracked.
- Improve docs *only* where they're wrong or missing for something you changed.

## Step 2 — Verify (mandatory)

Run whatever this repo actually has, e.g.:
- Type check: `tsc --noEmit` / `mypy` / `go vet`
- Build: `npm run build` / `pnpm build` / `make` / the project's build
- Tests: `npm test` / `pytest` / `go test ./...`
- Lint: the project's linter

If the repo has a run/QA skill or script, use it to confirm the app still works. A change
that isn't verified doesn't ship — revert it.

## Step 3 — Report (plain English, for a non-engineer)

Write the report so a business owner groks it on one read. Lead with what a user would
see or feel, not the code mechanics. Include:

1. **What got better** — grouped by outcome (faster, cleaner, fewer bugs, smaller),
   each with the user-visible effect in plain words.
2. **Proof it still works** — which checks you ran and that they passed.
3. **Proposed but not done** — risky or judgment-call ideas left for the human, one line each.
4. **Anything to know** — tradeoffs, real bugs found, dependencies that need attention.

Keep commits and code comments technical; keep this report in plain language.

---

### Guardrails recap
Branch, don't push. Never touch secrets. Preserve behavior. Verify everything. Delete
more than you add. When unsure, propose instead of doing.
