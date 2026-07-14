# CLAUDE.md — Bolusi

Mandatory instructions for every Claude Code agent in this repo. Read before any change. If a task conflicts with this file, stop and ask.

> **Status: bootstrapping.** This project starts from PRDs (some ~4 months old — treat old PRDs as **stale input, not ground truth**). Stack, domain, and specs are produced by the workflow below. Placeholders marked `TODO(brainstorm)` / `TODO(ai-docs)` are replaced by their phase.

---

## 0. The Workflow — INVOKE THE SKILL FOR EVERY PHASE (mandatory)

This repo runs a fully-agentic pipeline. **Every phase has a skill, and you MUST invoke that skill before doing the phase's work.** This is a blocking requirement, not a suggestion — do not freehand a phase that has a skill, even if you think you know the steps (skills evolve; the current version wins).

| # | Phase | Invoke skill | When |
| - | ----- | ------------ | ---- |
| 1 | Brainstorm PRDs → questions → decisions | **`brainstorm-prd`** | starting from PRDs, or scope unclear |
| 2 | Author the specs (`ai-docs/`) | **`author-ai-docs`** | turning decisions into agent-ready docs |
| 3 | Split into tasks | **`decompose-tasks`** | `ai-docs/` → `ai-docs/tasks/` |
| 4 | Implement (parallel, worktree-isolated) | **`implement-task`** | building any task |
| 5 | Review before merge | **`review-wave`** | before ANY merge |
| 6 | QA (comprehensive + continuous) | **`qa-sweep`** | after features, and continuously |

**Rules for skill use:**

- A request that spans phases → invoke each phase's skill in turn (brainstorm → author → decompose → implement → review → qa).
- Unsure which applies? Invoke the closest — skills are cheap; skipping them is expensive.
- The cross-cutting disciplines (§2) apply in **every** phase, on top of the phase skill.
- Fan-out phases (4/5/6) use the **Workflow** tool for multi-agent orchestration — the phase skill tells you the shape.
- Never mention a phase's steps from memory instead of invoking its skill.

---

## 1. Stack & domain — TODO(brainstorm / ai-docs)

Decided in phases 1–2. Until then, make **no stack assumptions**. When a stack is chosen: latest stable deps, pinned in the lockfile; **verify current library docs before using an API** — training data drifts.

---

## 2. Hard rules — cross-cutting disciplines (always on)

Invariants, learned the hard way. They hold in every phase.

1. **Verify ground truth.** Read the tool's OWN output — never gate a merge / commit / delete / "done" on a summary or a task-notification. Summaries lie; outputs don't.
2. **Execute, don't over-ask.** Act on agreed work. Batch open questions to the end; interrupt only for real blockers or hard-to-reverse / outward-facing decisions.
3. **Worktree isolation.** Every spawned implementation agent's FIRST step is `git branch --show-current` / `pwd`; if on `main` (or not in its own worktree) it STOPS and reports — never branch/commit in the main checkout. After entering a worktree, absolute main-repo paths edit the MAIN checkout — use worktree paths.
4. **Atomic commits.** Conventional Commits (`type(scope): subject`), **subject line only — no body, no attributions of any kind**. Each commit builds + passes. No `wip`/`fixes`; squash before merge.
5. **Security is written, not reviewed in.** Any security surface (auth, tokens, upload/download, signed URLs, access control, rate limits) works through a checklist and ships adversarial tests BEFORE review. The review gate is the backstop, not the plan.
6. **Canonical task index.** `ai-docs/tasks/_index.md` + per-task Status lines are the single source of truth for "what's left." Keep it current; answer status from it.
7. **Continuous QA feeds back into tasks.** QA findings become task files, not lost notes — and QA runs *during* the build, not only at the end.
8. **One implementation, not per-module copies.** Permissions / validation / shared logic live once, in shared packages.
9. **Every task gets ≥1 separate review agent before merge** (`review-wave`).
10. **Pre-commit hooks are mandatory** — never `--no-verify`; fix the failure.

---

## 3. Doc router

One row per concern → the doc(s) to read (under `ai-docs/`). Load only what the task needs.

| Working on | Read |
| ---------- | ---- |
| Anything (orientation, scope, OUT-list) | `00-product-overview.md` |
| Entities, fields, relationships, conflicts | `01-domain-model.md` |
| Permissions, roles, authz, data gating | `02-permissions.md` |
| Any status enum / transition | `03-state-machines.md` |
| Building/changing a module, commands, projections, queries | `04-module-contract.md` |
| Op envelope, signing, hash chain, ordering, rejection codes | `05-operation-log.md` |
| Media capture, compression, upload queue | `06-media-pipeline.md` + `api/03-media.md` |
| UI strings, locales, label keys | `07-i18n.md` + `ui-labels.md` |
| Dependencies, versions, monorepo layout, toolchain, CI | `08-stack-and-repo.md` |
| DDL, migrations, indexes, RLS | `10-db-schema.md` |
| Any API endpoint (envelope, errors, auth, limits, realtime) | `api/00-conventions.md` |
| Sync push/pull, cursors, staleness | `api/01-sync.md` (+ `05-operation-log.md`) |
| Enrollment, PIN auth, device tokens, revocation | `api/02-auth.md` (+ `02-permissions.md`) |
| Media upload/download wire protocol | `api/03-media.md` |
| Push notifications (tokens, categories, payloads) | `api/04-push.md` |
| Tenant isolation / server data access (RLS, forTenant) | `10-db-schema.md` §6 + `08-stack-and-repo.md` §3.2 |
| UI components, screens, mandatory states | `design-system.md` (+ `07-i18n.md`) |
| Writing any test; chaos harness; perf gates | `testing-guide.md` |
| Any security surface (checklist + required adversarial tests) | `security-guide.md` |
| What's deferred / v1 sequencing / drift tripwires | `roadmap.md` |
| Why a decision was made | `decisions/` (dated log) |

---

## 4. Parallel-agent safety

- Contended shared code (design system, permissions, shared types/contracts, i18n) **serializes** — one agent at a time; land before dependents start.
- Module code in different areas is parallel-safe.
- DB migrations serialize globally.
- Spawned agents work ONLY in their own worktree (§2.3). Put that instruction in every spawn prompt.
- Do not edit spec content as a side effect of implementation — spec changes are their own task.

---

## 5. Commits & branches

- Conventional Commits, subject-only, no attributions (§2.4).
- Branch per task; never commit on `main` directly.
- Merge only after review (§2.9); prefer a clean integration worktree over merging in the main checkout.

---

## 6. Red flags — stop and ask

- New role / status value / event type / permission-matrix change.
- Hard-deleting important records; changing a core data model.
- Weakening a security control.
- Anything hard-to-reverse or outward-facing (deploys, cloud apply, sending data to external services) — confirm first.
- Editing contended shared packages while other agents' work is in flight.
