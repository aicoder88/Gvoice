# AGENTS.md

Read the project instructions in `CLAUDE.md`.

## Shared plan and model rules

Read `global-skills/tier/SKILL.md` before writing or running a model-tagged plan;
validate it with `node global-skills/tier/check-tags.mjs <plan.md>`.
This tracked package is copied from the canonical `aicoder88/hub` repository.
Use `gpt-6.1-sol/medium` for normal Codex work, `gpt-6-luna/low` for mechanics,
and `gpt-6-astra/high` for explicit demanding-judgment escalation. Every model
recommendation names effort. Every plan handoff links the saved plan and includes
its copyable `/tier <absolute-path-to-plan.md>` command; resolve the path on the
current machine. Preserve native historical tags and all project approval gates.
These rules need no personal skill installation or machine-specific hub path.
