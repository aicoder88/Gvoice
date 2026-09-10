# Daily-use baseline — 2026-09-10

Worktree: `/Users/macmini/dev/voice/.claude/worktrees/daily-use` (branch `worktree-daily-use`, off local `main`, not pulled).

## GVoice — `pnpm install --frozen-lockfile`

Exit 0. Lockfile up to date, 401 packages installed (`koffi`, `uiohook-napi` native builds succeeded).

## GVoice — `pnpm test:unit`

Command: `node --test scripts/unit/*.test.js`

Exit 0. All files pass, no `ERR_MODULE_NOT_FOUND`.

- tests: 164
- pass: 164
- fail: 0
- cancelled/skipped/todo: 0
- duration: 701.9 ms

The earlier draft's "5 of 20 files fail with `Cannot find package 'ws'`" no longer applies now that packages are installed. Full pass, per-file breakdown not needed since nothing failed.

## Better Options — `scripts/check-settings.sh`

Exit 0. All checks passed (round trip, saved bindings, binding names, changing a binding, no-settings-file fallback, mice — see full log for the itemized list, every line `ok`).

## Better Options — `swift build`

Exit 0. `Build complete! (0.10s)`.
