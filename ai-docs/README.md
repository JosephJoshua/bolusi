# ai-docs — specs

Single source of truth for the project. Agents load only the docs their task's router row names (see `CLAUDE.md` §3).

Populated by the **`author-ai-docs`** skill after **`brainstorm-prd`**. Until then this is a placeholder.

**Convention:** one fact, one owning doc. Code derives from docs; docs are never generated from code.

- `decisions/` — dated decision log (from `brainstorm-prd`).
- `tasks/` — task files + `_index.md` (from `decompose-tasks`).
