# TASK 47 — the server watermark store has no production caller and no real-PG16 coverage; three gates are blind to the same line
**Status:** todo
**Priority:** P2 — **not a live bug** (the code is correct on PG16 today, probed). A coverage hole positioned exactly where task 17 will write the first real batch-apply.
**Depends on:** 16
**Blocks:** 17

## Goal

Make the real-PG16 lane execute **production** `watermarks.ts`, and delete the mirror — before task 17 wires the first projection into the push transaction.

## The finding (review-04, task 16 review — three facts, each reproduced)

**(a) There is no production batch-apply path to guard.** `createServerWatermarkStore` has **zero production callers** — only tests. `push.ts` applies no projections and never touches the watermark (`registry` is *"Empty until modules register (tasks 17/25)"*). So the §39 atomicity contract is currently implemented by **nothing**.

**(b) The PG16 test is decoupled from production by construction.** It hand-copies the store as a local `serverWatermarkStore` **MIRROR** and hardcodes the value (`advanceServerSeq(MODULE_ID, 3)`). Neutering **production** `advanceServerSeq` → apps/server goes **3 RED**, **PG16 stays 95/95 GREEN**. Its own header admits the coupling is discipline: *"the two must be kept in sync"* — and §2.11 is explicit that guards get closed **by construction**, not by asking people to be careful.

> So: does the atomicity test prove the contract, or a version production won't execute? **Neither. It proves PostgreSQL 16 implements rollback.**

**(c) The kicker — the task-46 bug class, unguarded, in the file whose own comment explains it.** `watermarks.ts:36-38` says the `Number()` exists *because "Postgres returns bigint as a STRING"*. That call is the **only** thing standing between this file and task 46's bug. Remove it:

| gate | result | why it's blind |
| ---- | ------ | -------------- |
| `pnpm typecheck` | **EXIT=0** | task 39 — `DB` is `any` across `apps/server` |
| PGlite (`test:server`, 373 tests) | **GREEN** | T-14f — PGlite returns int8 as a *number* |
| real PG16 (`test:rls`, 95 tests) | **GREEN** | it runs the **mirror**, not production |

**Three gates, blind by three different mechanisms.** A future agent "simplifying" that redundant-looking `Number()` ships a string watermark to production, where `watermark + 1` becomes **string concatenation** — and nothing in the repo objects.

**Sizing honestly:** production `createServerWatermarkStore` is **correct on real PG16** — probed: `read()` → `5, typeof number`; the monotonic CASE holds (lower→5, higher→9). This is a coverage gap, not a live defect. It is filed because of *where* it sits, not what it currently breaks.

## Why this blocks task 17, not task 16

Task 16 registers no modules, so there is no production code for the guard to protect. The guard has to exist **at the point task 17 wires the first projection into `processPushBatch`'s transaction** — that is when the contract becomes load-bearing and when a savepoint/retry wrapper could silently break it. Fixing it inside task 16 would guard an empty room.

## Docs to read

- `packages/core/src/projection/watermarks.ts` :36-38 (the `Number()` and its comment — the thing with no coverage).
- `apps/server/test/integration/sync/batch-atomicity.test.ts` — the mirror + the hardcoded `advanceServerSeq(MODULE_ID, 3)`; its header states the sync-by-discipline coupling.
- `apps/server/src/sync/push.ts` — `registry` (empty until 17/25); the transaction task 17 will wire into.
- `04-module-contract.md` §4.3:76 + `10-db-schema.md` §8:53/:629 — server projections apply **inside the push transaction** (normative).
- `08-stack-and-repo.md` §3.3 — the boundary rule (`pg` is db-server-locked); read it before choosing the fix.
- `testing-guide.md` **T-14f** (both engines ≠ both drivers), T-8, T-11, T-14; `ai-docs/tasks/46-*.md` (the live instance of this exact class); `ai-docs/tasks/39-*.md` (why typecheck is blind).

## Skills

- `superpowers:test-driven-development`, `superpowers:verification-before-completion`.
- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on `main`.
- **Real Postgres required** — PGlite cannot express this (T-14f). Use the per-worktree lane (task 34): `pnpm db:up` (read its output), confirm `attribution OK … owned by '<your project>'` before believing any number (T-14d), `pnpm db:down` after. Never touch a container that isn't yours.

## Files / modules touched

- `packages/core/src/projection/watermarks.ts` **or** `packages/db-server/` (see the fix options). **`@bolusi/core` is contended (CLAUDE.md §4)** — serialize, and coordinate with **task 46**, which is fixing the sibling bug in `oplog-source.ts`. Land 46 first if both are queued; they are the same class.
- `apps/server/test/integration/sync/batch-atomicity.test.ts` — the mirror **is deleted**, not adjusted.

## Acceptance

**Observable done-condition:** removing the `Number()` from **production** `watermarks.ts` turns a **real-PG16** test RED. Today it turns nothing red.

- **Reproduce all three blind gates first** (T-11): drop the `Number()` from production `read()`, and watch typecheck EXIT=0, PGlite green, PG16 green. That triple green is the bug. If any goes red, the premise changed — stop and report.
- **Make the PG16 lane execute production code.** The 08 §3.3 boundary is real, so pick and justify:
  1. **Move `createServerWatermarkStore` into `@bolusi/db-server`** — it is a db-server concern with no server-app dependency, so the boundary objection dissolves. (Reviewer's preference, and mine.)
  2. Give `apps/server`'s sync suite a real-PG16 lane.
  Either way: **delete the mirror.** A test that hand-copies the code it guards is not a guard; it is a second implementation with a green light (§2.8).
- **Falsify after the fix** (§2.11): `Number()` removed → real-PG16 test RED with a string-vs-number failure; restored → green. Also neuter production `advanceServerSeq` → the PG16 lane must now go RED (today it stays 95/95).
- **Un-hardcode the value.** `advanceServerSeq(MODULE_ID, 3)` with a literal 3 cannot detect a watermark computed wrongly. Drive it through the real path.
- **Assert the denominator** (T-14): name how many production functions in `watermarks.ts` the PG16 lane now executes, and confirm it is not zero. "The lane runs" is not "the lane covers this."
- `pnpm test`, `pnpm test:server`, `pnpm test:rls` (real PG16, attributed), `pnpm lint`, `pnpm typecheck` green. **Read the output, not the exit code** (§2.1).

## Note

Found by review-04 asking a question I posed carelessly. I asked whether task 16's workaround "compromised the batch-atomicity proof." The honest answer was worse than the question assumed: **there was no proof to compromise.** The test could not fail for any production defect, because production had no caller, the test used a mirror, and the one line that matters is invisible to every gate.

Task 16 is not at fault: it was told not to touch contended `@bolusi/core`, it correctly declined, and it reported the int8 finding (now task 46) rather than quietly using its workaround as evidence. The gap is structural, and it is the sharpest illustration yet of this project's recurring shape — **three independent gates, each green for a different wrong reason, over the same line of code.** The `any`, the wrong engine, and the mirror. Any one of them alone would have been caught by the other two; together they cover for each other perfectly.
