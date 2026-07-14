---
name: author-ai-docs
description: Use after brainstorm-prd to write the ai-docs/ spec set — the full context an agent needs to build correctly without guessing. Produces domain model, state machines, API conventions, permissions, design system, testing/security guides, roadmap, and fills the CLAUDE.md doc router. Invoke before decompose-tasks.
---

# Author the ai-docs

Write specs dense enough that an implementation agent needs no other context.

## What to produce (adapt names to the project)

- `00-product-overview.md` — orientation (from brainstorm).
- `01-domain-model.md` + `10-db-schema.md` — entities; the DDL is the source of truth.
- `03-state-machines.md` — every status + valid/invalid transitions (the enum source of truth).
- `02-permissions.md` — the authz matrix; a single enforcement point.
- `api/00-conventions.md` + per-module API docs — envelope, error codes, pagination, idempotency.
- `design-system.md` + a UI-label catalog — tokens, mandatory states (loading / empty / error / unauthorized), i18n.
- `testing-guide.md` — test-quality rules (public behavior only, unique value per case, never assert UI copy).
- `security-guide.md` — per-surface checklists + required adversarial tests.
- `roadmap.md` — what is explicitly **NOT** v1.

## Rules

- **Single source of truth per fact.** The doc owns it; code derives from it, never the reverse. **Never codegen a package from a markdown doc.**
- **English internal names** everywhere; localized strings only via the label catalog.
- Fill **CLAUDE.md §3 Doc Router** as you write — one row per concern, so tasks load only what they need.
- Each doc carries a change-control note: change the doc first, then the code.

## Done when

The router is complete and every concern an agent will hit has an owning doc. Then invoke **`decompose-tasks`**.
