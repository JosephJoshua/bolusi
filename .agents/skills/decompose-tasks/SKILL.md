---
name: decompose-tasks
description: Split Bolusi specs and reproducible findings into actionable tasks with canonical index statuses.
---

# Decompose Tasks

Read `.claude/skills/decompose-tasks/SKILL.md`. Preserve the index schema and
dependencies. `CLAUDE.md` §2.7 limits new QA tasks to reproducible failures;
do not turn speculative drift into work. Use `pnpm task:new` and
`pnpm task:status` where applicable instead of rewriting the index.
