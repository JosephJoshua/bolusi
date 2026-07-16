# TASK 81 — `apps/server`'s 50 integration files are still on PGlite; move them onto the real-PG16 lane task 73 built

**Status:** todo
**Priority:** HIGH — this is where D16's remaining exposure lives. Task 73 moved `db-server` (15 files, 124 tests) onto real PG16 and left `apps/server` (50 files) on the substitute. The push pipeline, the validation stages, the conflict-detection engine and the projection-apply step all live in `apps/server`, and all are still witnessed only by a lane measured blind to the silent bug class.
**Depends on:** 73 (landed the container/template lane and the `@bolusi/db-server/testing` seam this consumes)
**Blocks:** —
**SEC ids owned by THIS task:** none — but it makes `apps/server`'s RLS-adjacent assertions meaningful rather than vacuous.

## Why this is filed and not fixed

Task 73's scope was the L3 lane's mechanism. It shipped that, measured it, and stopped at the boundary question rather than sprawl. The denominator it left, stated plainly:

| lane | files | engine after 73 |
| ---- | ----- | --------------- |
| `packages/db-server` | 15 (124 tests) | **real PG16 in a container over real `pg`** |
| `apps/server` | **50** | **PGlite** — unchanged |
| T-8 applier conformance (`packages/core`) | 1 | PGlite — **deliberate, ruled, documented** (see below) |

## THE BOUNDARY RULING (task 73 decided this; do not re-litigate it — implement it)

Task 73's brief offered three options. It chose **(c)**, in a specific shape, and the evidence is:

- **`apps/server` may already import `db-server`** (`08 §3.3`): the edge exists and is granted.
- **`db-server` owns `pg`** (`08 §3.3:164` — `| db-server | core, schemas, kysely, pg |`).
- Therefore the lane can live in `db-server` and be *imported* by `apps/server` tests, which then reach real PG16 **without importing `pg` at all**. `pg` stays boundary-locked; rule 2 ("nothing outside them imports a DB driver") is untouched; **no `08 §3.3` change is required, so this is NOT a §6 red flag.**
- Task 73 shipped the seam: `packages/db-server/src/testing/pg-container.ts`, exported as **`@bolusi/db-server/testing`**.

Rejected, with reasons:
- **(a) give `apps/server` a test-only `pg` grant.** Implementable — the lint already has the mechanism (`tooling/eslint/src/plugin/rules/boundaries.js:69-72` grants `better-sqlite3` to `packages/core` with `testOnly: true`, and `pg`'s row is `['pg', [{ workspace: 'packages/db-server' }]]` with no test-only variant). But it needs a spec change (§6 red flag) and buys nothing (c) does not, while putting a second copy of the lane's logic in reach (§2.8).
- **(b) accept `apps/server` on a substitute forever.** Rejected: `apps/server` is exactly where the production push path lives, so this is the one place D16's "never the sole witness" rule cannot be satisfied by a disclaimer.

**T-8's conformance leg is a separate ruling and it is NOT this task.** It stays on PGlite permanently, because `packages/core` may import neither `pg` (§3.3 rule 3) nor `db-server` — **`db-server` imports `core`, so `core → db-server` is a dependency CYCLE**, not a policy choice. It is legitimate under D16 rule 3 because its question is *dialect* neutrality and it is no longer the sole witness for marshalling. Written into T-8 and §2.4 by task 73.

## The work

1. Give `apps/server` a `globalSetup` that consumes `@bolusi/db-server/testing` (`startPgLane` + `createDatabaseFromTemplate`), mirroring `packages/db-server/test/global-setup.ts`. **One container for both projects if vitest's project wiring allows it; two if not — measure, don't assume.**
2. Replace `apps/server/test/integration/oplog/helpers.ts`'s PGlite harness. **Read its header first** — it explains exactly why it chose PGlite, and that reason ("`pg` is boundary-locked to packages/db-server, so apps/server test code cannot open a real-Postgres pool") is now false: it never needed `pg`, it needed a `Kysely<DB>`, and `@bolusi/db-server/testing` hands it one.
3. **Re-enable `fileParallelism` in `apps/server/vitest.config.ts`** and size `maxWorkers` from the connection budget, not from core count (`assertConnectionBudget` re-derives it against the live server). **This is the big number**: 50 files at a measured 11–13 s/file serialized ≈ 550–685 s. Task 73's equivalent change on `db-server` took the same 15 files / 124 tests from **130 s → 49 s including container boot (2.65×)**, on the same engine, both green.
4. **Delete the PGlite branch rather than default it** (73's pattern): a lane that can be downgraded to WASM will be, and the downgrade is silent.

## Acceptance

- **Falsify before believing** (T-11/§2.11): neuter `SET LOCAL ROLE bolusi_app` and watch an `apps/server` RLS-dependent assertion go RED, then restore. Task 73's run of that exact probe on `db-server` produced `expected 'test' to be 'bolusi_app'` — **testcontainers' default user is a SUPERUSER and bypasses RLS even under FORCE** — plus a cross-tenant SELECT/INSERT/UPDATE/DELETE all succeeding. Connecting a container as its default user is as vacuous as PGlite was (T-14b); the ROLE is what closes it, not the engine.
- **Ship the positive control with every fence** (T-17). A fence with no control proves only that nothing happened.
- **Report before/after wall-clock** for `test:server` and the full suite, with `EXIT=` lines and a `Test Files N passed` denominator (T-18 — a "completed (exit code 0)" notification described an `EXIT=1` run twice during task 73 alone).
- **Never `.withReuse()`** — see 73's finding: reuse returns before `getReaper()` and never applies the `session-id` label Ryuk reaps by, so a reused container is never cleaned up. Verified in testcontainers 12.0.4's own source and by a 13-day-old orphan on the dev box carrying exactly that label fingerprint.
- Assert the denominator: how many of the 50 moved, how many did not, and **which**.
