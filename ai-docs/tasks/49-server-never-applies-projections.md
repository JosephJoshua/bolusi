# TASK 49 — the server never applies projections; the push transaction drops a normative step and no task owns it
**Status:** todo
**Priority:** **HIGH** — a normative stage of the push transaction, specified four times, implemented nowhere. Every server read model is permanently empty.
**Depends on:** 16
**Blocks:** 17, 21, 25, 43

## Goal

Build the **server-side module registration + projection-apply step** inside the push transaction — the stage `10-db §3` step 6 requires and `pipeline.ts` skips.

## The finding (qa-orphans sweep, 2026-07-15 — verified independently by the orchestrator)

**The spec requires it, normatively, in four places:**
- `10-db-schema.md:65` — the push-transaction shape: `IF accepted: UPDATE tenant_op_counters … RETURNING → INSERT operations → **apply projections**`
- `04-module-contract.md:128` — the execute sequence: `6. apply projections`
- `10-db-schema.md:628` — *"the server applies projections"*
- `01-domain-model.md` §7 — *"Projection tables exist twice with one applier: Postgres (server read models) and SQLite (device read models)"*; `api/02-auth.md` §6.2 — *"The **server** runs the same appliers (04 §2)"*

**What exists:** all six server projection tables — `conflicts`, `user_prefs`, `auth_sessions`, `pin_lockout_events`, `auth_permission_denials`, `notes` — created by task 05, RLS-secured via `secureTenantTable`, and **indexed for their named queries**.

**What doesn't:** the apply step. `apps/server/src/oplog/pipeline.ts:190-212` runs `allocateServerSeq → insertOperationRow → advance head` and **stops at step 5 of 6**. Verified: `grep -rniE "projection|applier|applyAppendedOp|watermark" apps/server/src` returns **only comments** (task 16's watermark store, itself with zero production callers — task 47). Positive control: the same grep shape finds 43 `serverSeq` hits, so the search works.

**Two structural details that make this more than a missing call:**
1. **`pipeline.ts:17`'s own header comment restates the per-op sequence *without* the apply step** — the code documents a sequence that silently drops a normative stage. Nobody reading it would notice the omission, because the comment agrees with the code.
2. **`deps.registry` is an `OpRegistry`** (`apps/server/src/oplog/types.ts:33` — `resolve()` → `validate()`): payload validators only. It **structurally cannot** apply a projection even when fully populated. The seam everyone assumed exists doesn't.

**Nobody owns it — the handoff chain closes on itself.** This is the finding:
| task | what its file says | reality |
| ---- | ------------------ | ------- |
| 08 (projection-engine) | *"server embedding lands with tasks **07/16**"* | punts |
| 07 (oplog-server, **done**) | the word "projection" appears **zero times** | never received it |
| 16 (sync-server, **done**) | *"Server-side enforcement is task **17's**"* | punts |
| 17 (conflict-detection) | files touched: *"in-transaction **`conflicts`** projection apply"* | **one table**, only for the detection op |
| 25 (notes) | *"add the notes manifest to **the module registration list**"* | assumes a list nobody creates |
| 43 (auth appliers) | `packages/core/src/auth/` only — dialect-neutral appliers | no server wiring |

Everyone points somewhere else, and the ring closes. Task 07 — the one two others point *at* — never mentions projections at all.

**The sharpest consequence, and the reason this is HIGH:** task 21 composes push-notification locale by reading `user_prefs` (`21-push-notifications.md:24`, `:44`). Nothing writes that table server-side, so **every notification falls back to `id-ID` forever** — and task 21's own locale-fallback-matrix test will be **green**, because it seeds the row directly. A fixture asserting a join that production never makes (T-14b). That is this project's signature failure, pre-scheduled into a task that hasn't started.

## Docs to read

- `10-db-schema.md` §3 (the push-transaction shape — **the contract**), :628, §8, §9.1 (watermark scalars).
- `04-module-contract.md` §2 (appliers are dialect-neutral — *one* applier, both engines), §4.3, §5 step 6.
- `01-domain-model.md` §7 (projection tables exist twice, one applier).
- `apps/server/src/oplog/pipeline.ts` :17 (the comment that agrees with the wrong code), :180 (`UNKNOWN_TYPE`), :190-212 (the truncated sequence); `types.ts:33` (`OpRegistry` — why it can't do this).
- `apps/server/src/sync/watermarks.ts` — task 16's store; **task 47** is moving it to `@bolusi/db-server` and giving it real coverage. **Coordinate.**
- `testing-guide.md` T-8 (both-engine rule), T-14b, T-14f (both engines ≠ both drivers).
- `ai-docs/tasks/47-*.md` and `48-*.md` — **read both before starting.** 47 gives the watermark store production coverage; 48 fixes `RawOpRow`, which is **client-shaped in three ways** and would mis-read every server row (int8 `seq` → `"10" < "9"` is true → canonical order inverts past seq 9). **You cannot apply projections server-side until 48 lands** — you'd be folding mis-decoded ops.

## Skills

- `superpowers:test-driven-development`, `superpowers:verification-before-completion`.
- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on `main`.
- **Real Postgres required** — this is the production engine's path; PGlite hides the marshalling bugs (T-14f). Use the task-34 lane: `pnpm db:up` (read its output), confirm `attribution OK … owned by '<your project>'` (T-14d), `pnpm db:down` after.

## Files / modules touched

- `apps/server/src/oplog/pipeline.ts` — the apply step + its header comment.
- `apps/server/src/` — the **module registration list** task 25 already assumes exists, and a registry shape that can actually apply (the current `OpRegistry` cannot).
- **Coordinate with 47** (watermark store move) and **48** (`RawOpRow`). Do not touch `@bolusi/core`'s appliers — you consume them (§2.8: one applier, both engines).

## Acceptance

**Observable done-condition:** pushing an op that has a registered applier writes its server projection row **in the same transaction**, on **real PostgreSQL** — and a rollback leaves neither the op nor the row.

- **Reproduce the gap first** (T-11): push an op with a projecting type, confirm `operations` gains a row and the projection table stays **empty**. That empty table is the bug. Then read `pipeline.ts:17`'s comment and note it describes the code, not the spec — fix both.
- **Build the registration seam.** `OpRegistry` (`resolve`/`validate`) cannot apply; the server needs the module registry `04 §4` defines, wired so tasks 17/25/43 register into **one** list. Task 25 already assumes it. Do not invent a second registry (§2.8 — this repo has a task-33 pile of duplicate registries already).
- **One applier, both engines** (T-8/`04 §2`): the server must run **the same** appliers as the client, not a server copy. If the shape forces a copy, STOP and report — that is a spec problem, not an implementation choice.
- **Atomicity** — the apply is inside the push transaction (`10-db §3`), and task 47's contract applies: op INSERT + projection APPLY + watermark advance commit together or not at all. **Falsify** (§2.11): abort mid-transaction → neither the op nor the projection row survives; commit per-op → watch a rebuild skip. Task 47 is building the guard that catches this; make sure it now guards **real** code.
- **Prove it on the production driver** (T-14f): a PGlite-green apply proves nothing about marshalling. The real-`pg` lane is the gate — and it requires 48's `RawOpRow` fix, or you will fold ops whose `seq` sorts as a string.
- **Assert the denominator** (T-14): every registered module's projecting op types have an applier that runs; name the count. An op type registered with no applier is task 43's bug recurring one layer up.
- `pnpm test`, `pnpm test:server`, `pnpm test:rls` (real PG16, attributed), `pnpm lint`, `pnpm typecheck` green. **Read the output, not the exit code** (§2.1).

## Note

Found by a systematic orphan sweep — the first of the five orphans **not** found by accident. The previous four (the permission registry, the schemas auth DTOs, the auth appliers, `restriction_violated`) were each volunteered by an agent noticing its own gap. This one was found by enumerating what the specs *require* and checking each entry against what exists, which is the only method that finds absence.

The shape is worth naming, because the decompose will do it again: **a step every task assumes another task owns.** Each handoff was individually reasonable — 08 punts server embedding to "07/16", 16 punts to 17, 17 does one table for its own op, 25 assumes a list. No single task file is wrong. The ring is wrong, and no reviewer sees a ring, because every review sees one task.
