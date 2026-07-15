# TASK 47 — the server watermark store has no production caller and no real-PG16 coverage; three gates are blind to the same line
**Status:** done
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

## TWO ADDITIONS from task 46's review (2026-07-15) — read both before starting

**(1) The seam now exists — use it; do NOT re-roll your own cast.** Task 46 built `int8ToBigInt`/`int8ToNumber` in `@bolusi/core` and (per its review) exports them. `createServerWatermarkStore` currently carries **its own** unguarded `Number(row.appliedServerSeq)` — the one my task-16 F1(c) proved is invisible to all three gates. **Adopt the seam.** If you write a second cast, you re-create *"one function had the cast, the neighbour twelve lines away didn't"* — the precise condition task 46 exists to abolish (§2.8), inside the very task filed to fix the coverage hole that hid it.

**No collision with task 46** (verified by review-04): 46 touched `packages/core/src/projection/watermarks.ts` (**client** `createSqlWatermarkStore`); you move `apps/server/src/sync/watermarks.ts` (**server** `createServerWatermarkStore`). Different packages, different functions. They should **converge on the seam**, not conflict.

**(2) The T-8 hole is deeper than the driver — and it's arguably the more important half.** Task 46 found that applier-conformance calls **only** `engine.applyAppendedOp` (`_harness.ts:267`) and never `applyPulledOp`. `highestContiguousServerSeq` is reachable **only** from `engine.ts:154`, inside the pull branch. So on the PGlite leg **the function was never executed at all** — *"the gate didn't just marshal wrong; it never ran the function."*

The root cause is T-8's own scope: **T-8 proves *appliers* are dialect-neutral, and the pull branch is not an applier** — so the gate never claimed this ground, and nobody noticed the ground was unclaimed. When you give the watermark store real coverage, the question to answer is not *"does the store work?"* but **"which engine entry points does any gate actually execute?"** — and name the ones nothing reaches. **T-8's denominator should be engine entry points exercised, not appliers covered** (see `ai-docs/tasks/31-*.md`, which now carries the generalization).

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

## Outcome (impl-47, 2026-07-15)

**Fix: option (a).** `createServerWatermarkStore` now lives in `packages/db-server/src/watermarks.ts`
and is exported from `@bolusi/db-server`; `apps/server/src/sync/watermarks.ts` is deleted. The
boundary objection dissolved exactly as predicted: the store's only imports are `kysely` and
`@bolusi/core`, both edges 08 §3.3 already grants db-server, and it has no apps/server dependency
in either direction. `packages/db-server` is the ONLY package whose suite re-runs on real PG16
(`test:rls` → `--project db-server`), so the lane now imports what it guards. **The mirror is
deleted** — there is nothing left to "keep in sync".

**The triple-blind reproduction, measured before the fix** (all on this worktree's own container,
PG16.14, `owned by 'agent-a966bffd92b4073e8'`):

| gate | driver | result with production `read()` broken |
| ---- | ------ | -------------------------------------- |
| `pnpm typecheck` | tsc | **EXIT=0** |
| `pnpm test:server` | **PGlite (PG18)** | **373 passed, EXIT=0** |
| `pnpm test:rls` | **real PG16.14** | **105 passed, EXIT=0** (ran the mirror) |

**One correction to the finding (c).** Typecheck's blindness is *conditional*, not automatic.
Deleting the `Number()` alone turns typecheck **RED** (`TS2322`, EXIT=2) — the row type was
honestly declared `string | number`, which is not assignable to `WatermarkState`. The gate only
goes blind when the author *also* asserts the row type (`sql<{ appliedServerSeq: number }>`) —
which is exactly what task 46's real bug did, so the realistic scenario is the blind one and the
finding stands. Recorded because it changes the mechanism: gate 1 is defeated by an **assertion**,
not by task 39's `any`. The new store therefore types the row `Int8Value` (core's exported union),
which makes the naive deletion a **type error by construction** and leaves the assertion variant to
be caught by PG16.

**Falsifications** (§2.11), both on attributed real PG16.14:
- seam removed (assertion variant) → **4 RED, EXIT=1**, `AssertionError: expected 'string' to be 'number'`; restored → 110 green.
- production `advanceServerSeq` neutered → **7 RED, EXIT=1**, `AssertionError: expected +0 to be 7`. **Previously this left the lane 95/95 GREEN.**

**T-14f, demonstrated rather than asserted.** With the seam removed, the *same test file* was run on
both drivers: **PGlite → 10/10 passed, EXIT=0**; **real PG16.14 → 4 RED, EXIT=1**. Both are
"PostgreSQL"; only one is the production *driver*. That pair is the argument for why this lane
exists, and it is why the store's coverage could not have been left in the PGlite suite.

**Denominator (T-14):** `createServerWatermarkStore` exports exactly **three** functions —
`read`, `advanceServerSeq`, `advanceLocalSeq` — and the PG16 lane executes **3 of 3**. Two distinct
assertions, and review-47 was right to separate them: the DENOMINATOR test reads the store's own
key list (`Object.keys(s).sort()`), so it catches a **fourth** function nobody runs — it asserts the
*surface*, not execution. **Execution** is carried by the three sibling tests, and was proven by
falsification rather than claimed: each went RED under the neuter. Residual (review-47 F2): delete
the `advanceLocalSeq()` test and coverage silently drops to 2/3 while the denominator stays green.
The hardcoded `advanceServerSeq(MODULE_ID, 3)` is gone: every contract case drives
`engine.applyPulledOp`, so the watermark is an **output** of production `read()` +
`highestContiguousServerSeq` + production `advanceServerSeq()`. A `CONTIGUITY` case (gap at
serverSeq 2 → watermark holds at 1, not 3) was added, which a literal 3 could never detect.

**T-8 hole, partially closed:** this lane is now the only thing that executes
`highestContiguousServerSeq` on any engine (applier-conformance calls only `applyAppendedOp`; the
walk is reachable solely from the pull branch, `engine.ts:154`). The general fix — T-8's
denominator becoming *engine entry points exercised* rather than *appliers covered* — remains
task 31's.

**For task 49:** the guard is now live at the seam you will wire. `processPushBatch` should call
`createServerWatermarkStore` from `@bolusi/db-server` inside the push transaction; the atomicity
cases here will fail if the apply/watermark ever leaves that transaction.

## Note

Found by review-04 asking a question I posed carelessly. I asked whether task 16's workaround "compromised the batch-atomicity proof." The honest answer was worse than the question assumed: **there was no proof to compromise.** The test could not fail for any production defect, because production had no caller, the test used a mirror, and the one line that matters is invisible to every gate.

Task 16 is not at fault: it was told not to touch contended `@bolusi/core`, it correctly declined, and it reported the int8 finding (now task 46) rather than quietly using its workaround as evidence. The gap is structural, and it is the sharpest illustration yet of this project's recurring shape — **three independent gates, each green for a different wrong reason, over the same line of code.** The `any`, the wrong engine, and the mirror. Any one of them alone would have been caught by the other two; together they cover for each other perfectly.
