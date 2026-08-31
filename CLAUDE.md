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

1. **Verify ground truth.** Read the tool's OWN output — never gate a merge / commit / delete / "done" on a summary or a task-notification. Summaries lie; outputs don't. **Never trust an exit code directly:** a status describes *the process it came from*, which is not always the process you care about. A watcher, poller, or `until grep …; done` wrapper reports on the wrapper — and if its success condition matches failure markers, it is *guaranteed* to go green when the job fails. Capture status next to output (`cmd > log 2>&1; echo "EXIT=$?" >> log`) and read the log. Every number you report carries the `EXIT=` line that produced it.
2. **Execute, don't over-ask.** Act on agreed work. Batch open questions to the end; interrupt only for real blockers or hard-to-reverse / outward-facing decisions.
3. **Worktree isolation.** Every spawned implementation agent's FIRST step is `git branch --show-current` / `pwd`; if on `main` (or not in its own worktree) it STOPS and reports — never branch/commit in the main checkout. After entering a worktree, absolute main-repo paths edit the MAIN checkout — use worktree paths.
4. **Atomic commits.** Conventional Commits (`type(scope): subject`), **subject line only — no body, no attributions of any kind**. Each commit builds + passes. No `wip`/`fixes`; squash before merge.
5. **Security is written, not reviewed in.** Any security surface (auth, tokens, upload/download, signed URLs, access control, rate limits) works through a checklist and ships adversarial tests BEFORE review. The review gate is the backstop, not the plan.
6. **Canonical task index.** The `status` cell of each `ai-docs/tasks/_index.md` row is the single source of truth for "what's left" — task 188 removed the per-file `**Status:**` line, so there is one store, not two. Keep it current; answer status from it.
7. **Continuous QA feeds back into tasks.** QA findings become task files, not lost notes — and QA runs *during* the build, not only at the end.
8. **One implementation, not per-module copies.** Permissions / validation / shared logic live once, in shared packages.
9. **Every task gets ≥1 separate review agent before merge** (`review-wave`).
10. **Pre-commit hooks are mandatory** — never `--no-verify`; fix the failure.
11. **A guard is only load-bearing if someone has watched it go red.** Every gate, guard, sweep, probe, and adversarial test is **falsified before it is believed**: break what it protects, observe the specific failure, restore, observe green. Report the falsification ("broke X, saw Y fail, reverted"), never "the test passes". A guard whose failure mode is "silently checks nothing" is worse than no guard — it converts an unknown risk into a false assurance, and nobody re-examines a green test — so guards are closed **by construction** (make the failure fatal, assert attribution), not by asking people to be careful (**§2.1 was already written the day one of these landed, and the discipline still failed**). Three rules the same class has forced, each normative on its own: **a comment is a hypothesis, not evidence** — when it names a mechanism, falsify it at the platform docs and by breaking the thing; **"typed and compiling" is not "running on the target"**; and **a mention is not a producer — trace to one** (T-16) before declaring something unshipped *and* before declaring it live. This is not abstract: v0 has shipped **eight-plus** gates green for the wrong reason (SEC-META-01, codegen-diff, the boundary rule, `badOwners`, an i18n key-grammar gate green *because* parked keys were invisible to it, a `test:rls` served by another worktree's container) and three "green no-ops" that are not tests at all (an iOS-only option cited as Android enforcement; a channel write Android ignores; a well-tested function with zero callers). The roster, the measured numbers, and each falsification are recounted in [`ai-docs/incidents.md`](ai-docs/incidents.md) (INC-T11, INC-T15, INC-T16); the full corollary set lives in `ai-docs/testing-guide.md` T-11–T-19.

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
| Deployment config / server env vars / `SYSTEM_KEY_DIR` (system-device keys) | `08-stack-and-repo.md` §8 |
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
- **Change a task's Status with `pnpm task:status <id> <status>`, never by hand** — it writes the single source: the task's `_index.md` row `status` cell (task 188 collapsed the old dual store, so there is no separate file `**Status:**` line to keep in sync). This is the writeback step on every state change, including at merge. Legal values: `todo · in-progress · in-review · done · blocked`; it refuses an unknown id or status. Task 66's ledger gate stays the backstop for any hand-edit that skips it.

---

## 6. Red flags — stop and ask

- New role / status value / event type / permission-matrix change.
- Hard-deleting important records; changing a core data model.
- Weakening a security control.
- Anything hard-to-reverse or outward-facing (deploys, cloud apply, sending data to external services) — confirm first.
- Editing contended shared packages while other agents' work is in flight.
