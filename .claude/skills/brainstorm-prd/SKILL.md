---
name: brainstorm-prd
description: Use at the START of a project or feature when you have PRDs / raw requirements to turn into decisions. Ingests PRDs (treat old ones as STALE input, not ground truth), asks questions one at a time, reconciles conflicts, and writes a decisions doc. Invoke before author-ai-docs.
---

# Brainstorm PRDs → Decisions

Turn raw / possibly-stale PRDs into a validated set of decisions ready to spec.

## Process

1. **Ingest, don't trust.** Read every PRD. PRDs older than ~a few months are **stale input**, not ground truth — flag anything likely to have drifted (scope, priorities, tech choices, dependencies, market). List explicit assumptions to re-confirm with the user.
2. **Map the product in one pass:** purpose, users, the single job of v1, hard constraints, success criteria, and what is explicitly **OUT**.
3. **Ask questions ONE AT A TIME.** Prefer multiple-choice. One question per message. Cover: purpose, scope boundaries, constraints, unknowns, conflicts between PRDs, and staleness. When proposing options, lead with your recommendation + reasoning.
4. **Explore 2–3 approaches** for each big decision; recommend one with trade-offs.
5. **YAGNI ruthlessly** — cut anything not needed for v1.
6. **Write it down:** `ai-docs/00-product-overview.md` (the orientation doc) + a dated entry in `ai-docs/decisions/`. Each decision records: what, why, alternatives rejected, open questions.

## Done when

Scope, constraints, and the major technical directions are decided and written, with open questions batched. Then invoke **`author-ai-docs`**.

## Anti-patterns

- Treating a 4-month-old PRD as current.
- Asking many questions at once.
- Speccing before the decisions are made.
