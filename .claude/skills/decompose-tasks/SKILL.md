---
name: decompose-tasks
description: Use after author-ai-docs to split the specs into small, independently-shippable task files under ai-docs/tasks/, with a canonical _index.md. Each task is one complete vertical slice with its docs-to-read, skills, files-touched, and acceptance. Invoke before implement-task.
---

# Decompose into Tasks

Turn specs into a dependency-ordered task list agents can pick up in parallel.

## Each task file — `ai-docs/tasks/NN-slug.md`

- **Goal** — one complete vertical slice, no scope creep.
- **Docs to read** — the exact router rows (not "read everything").
- **Skills** — which skills to load for this task (e.g. frontend-design, security-review).
- **Files / modules touched** — for parallel-safety planning.
- **Acceptance** — the tests to add (permissions, state transitions valid + invalid, idempotency, soft-delete) and the observable done-condition.
- **Depends on** — task ids.
- **Status** — `todo | in-progress | in-review | done | blocked`.

## The index — `ai-docs/tasks/_index.md`

Canonical source of truth (CLAUDE.md §2.6). One row per task: id, title, status, deps. Keep it current — it answers "what's left."

## Rules

- Small slices beat big tasks. Split anything touching many modules.
- Order by dependency; mark what unblocks what.
- Contended shared-package changes get their own **serial** tasks.

## Done when

Every spec area maps to tasks and `_index.md` is complete + dependency-ordered. Then invoke **`implement-task`** per task.
