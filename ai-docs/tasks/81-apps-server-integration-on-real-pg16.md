# TASK 81 — `apps/server`'s 50 integration files are still on PGlite; move them onto the real-PG16 lane task 73 built

**Status:** done
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

**THE RULING IS SOUND. THE SEAM AS SHIPPED DOES NOT YET DISCHARGE IT — READ THIS BEFORE YOU START.** Task 73 shipped `packages/db-server/src/testing/pg-container.ts`, exported as `@bolusi/db-server/testing`. An earlier revision of this task file said it *"hands apps/server a `Kysely<DB>`"*. **It does not.** Verified against the module (review-73, confirmed by grep of its export list): it exports `startPgLane`, `createDatabaseFromTemplate`, `assertAttribution`, `databaseNameFor`, `uriForDatabase`, the budget constants and a container handle — **and zero Kysely**. db-server's own harness turns a URI into `Kysely<DB>` in `test/helpers/test-db.ts` via `import pg from 'pg'` + `new pg.Pool(...)` — *exactly the line `apps/server` may not write*.

So **the blocker two agents found independently is not dissolved by task 73's diff; it is dissolved by code nobody has written yet.** That code is step 0 below, it is small, and it needs no spec change — but this file previously asserted it existed, which is the T-16 failure (a mention is not a producer) landing in the very task filed to fix a boundary. Do not start step 1 until step 0 is real.

**Step 0 — give the seam a factory that returns a handle, not a URI:**
```ts
// packages/db-server/src/testing/pg-container.ts (or a sibling)
export async function createTestDatabase(
  lane: PgLane, testPath: string,
): Promise<{ db: Kysely<DB>; close: () => Promise<void> }>
```
It owns the clone + the stamp assertion + the `pg.Pool` + the `CamelCasePlugin` wiring, so **`pg` never leaves db-server** and there is ONE construction rather than one per consumer (§2.8). `packages/db-server/test/helpers/test-db.ts` must then be refactored to consume it rather than keep its own copy — otherwise the "one implementation" claim is false the moment it is written.

Rejected, with reasons:
- **(a) give `apps/server` a test-only `pg` grant.** Implementable — the lint already has the mechanism (`tooling/eslint/src/plugin/rules/boundaries.js:69-72` grants `better-sqlite3` to `packages/core` with `testOnly: true`, and `pg`'s row is `['pg', [{ workspace: 'packages/db-server' }]]` with no test-only variant). But it needs a spec change (§6 red flag) and buys nothing (c) does not, while putting a second copy of the lane's logic in reach (§2.8).
- **(b) accept `apps/server` on a substitute forever.** Rejected: `apps/server` is exactly where the production push path lives, so this is the one place D16's "never the sole witness" rule cannot be satisfied by a disclaimer.

**T-8's conformance leg is a separate ruling and it is NOT this task.** It stays on PGlite permanently, because `packages/core` may import neither `pg` (§3.3 rule 3) nor `db-server` — **`db-server` imports `core`, so `core → db-server` is a dependency CYCLE**, not a policy choice. It is legitimate under D16 rule 3 because its question is *dialect* neutrality and it is no longer the sole witness for marshalling. Written into T-8 and §2.4 by task 73.

## The work

1. Give `apps/server` a `globalSetup` that consumes `@bolusi/db-server/testing` (`startPgLane` + `createDatabaseFromTemplate`), mirroring `packages/db-server/test/global-setup.ts`. **One container for both projects if vitest's project wiring allows it; two if not — measure, don't assume.**
2. Replace `apps/server/test/integration/oplog/helpers.ts`'s PGlite harness. **Read its header first** — it explains exactly why it chose PGlite, and that reason ("`pg` is boundary-locked to packages/db-server, so apps/server test code cannot open a real-Postgres pool") is now false: it never needed `pg`, it needed a `Kysely<DB>`, and `@bolusi/db-server/testing` hands it one.
3. **Re-enable `fileParallelism` in `apps/server/vitest.config.ts`** and size `maxWorkers` from the connection budget, not from core count — pass the LIVE worker count to `assertConnectionBudget` (task 73's guard takes it as a required argument precisely because checking its own constant is what review-73 falsified). **Give the project its own `sequence.groupOrder`**: vitest 4 refuses projects that share a groupOrder but declare different `maxWorkers`, and this made `pnpm test` collect **zero** tests on task 73's branch while `test:rls` stayed green.
   **DO NOT EXPECT A SPEEDUP HERE, AND DO NOT SELL ONE.** Task 73's first report claimed the real-PG lane was faster *than PGlite* and that was wrong — the orchestrator has now corrected it. Measured honestly on the same 15 files:

   | lane | wall |
   | ---- | ---- |
   | compose real-PG, serial (what 73 replaced) | **216.72 s** |
   | testcontainers real-PG, parallel (73's lane) | **45.35 s** — 4.8× vs the lane it replaced |
   | PGlite, serial (main) | ~46 s |
   | **PGlite, parallel** (main + one flag: `--fileParallelism`) | **14.40 s** |

   So the real-PG lane is **~3× SLOWER than parallelised PGlite**, and PGlite's serialization was never a WASM-boot tax — main's own config says it was serialized deliberately, "buys identical behaviour across both lanes", to match the shared-DB postgres lane. **The reason to move `apps/server` is FIDELITY, not speed** (D16): PGlite is blind to the silent class — measured four times now, most recently PGlite 14/14 GREEN vs real PG16 4 RED on the same int8 defect. Expect `test:server` to get *slower* than a hypothetical parallelised-PGlite lane and *faster* than today's serialized one. Report the real numbers; do not inherit these (T-14e).
4. **Delete the PGlite branch rather than default it** (73's pattern): a lane that can be downgraded to WASM will be, and the downgrade is silent.

## Acceptance

- **Falsify before believing** (T-11/§2.11): neuter `SET LOCAL ROLE bolusi_app` and watch an `apps/server` RLS-dependent assertion go RED, then restore. Task 73's run of that exact probe on `db-server` produced `expected 'test' to be 'bolusi_app'` — **testcontainers' default user is a SUPERUSER and bypasses RLS even under FORCE** — plus a cross-tenant SELECT/INSERT/UPDATE/DELETE all succeeding. Connecting a container as its default user is as vacuous as PGlite was (T-14b); the ROLE is what closes it, not the engine.
- **Ship the positive control with every fence** (T-17). A fence with no control proves only that nothing happened.
- **Report before/after wall-clock** for `test:server` and the full suite, with `EXIT=` lines and a `Test Files N passed` denominator (T-18 — a "completed (exit code 0)" notification described an `EXIT=1` run twice during task 73 alone).
- **Never `.withReuse()`** — see 73's finding: reuse returns before `getReaper()` and never applies the `session-id` label Ryuk reaps by, so a reused container is never cleaned up. Verified in testcontainers 12.0.4's own source and by a 13-day-old orphan on the dev box carrying exactly that label fingerprint.
- Assert the denominator: how many of the 50 moved, how many did not, and **which**.

## Outcome (task 81)

**Done. `apps/server` runs on the same real-PG16 lane as db-server; PGlite is deleted from `apps/server`.**

### The denominator (measured, not the brief's estimate — the file count grew since it was written)
`apps/server` has **54** test files, not 50. **43 moved to real PG16** (every DB-backed file — oplog, sync, media, identity, tenant — reached through the migrated harnesses); **11 use no DB** (pure `app.fetch`/crypto/unit: `config`, `gzip-decompress`, `middleware-order`, `rate-limit`, `oplog/no-http-boundary`, `sec-sync` (top-level), `security/sec-dev`, `src/media/{assemble,blob-store}`, `src/oplog/skew`, one identity file). Corroboration: the 43 are **exactly** the files that went RED when Postgres crashed mid-bring-up (below) — a clean witness that the count is the real one.
`grep` for `@electric-sql/pglite` under `apps/server` now returns **zero**. The seam (`createTestDatabase`) is the only place a test `Kysely<DB>` is built, and it lives in db-server, so `pg` never crossed the boundary (lint `bolusi/boundaries` enforces it; a shipping-source import of the seam still fails — falsified).

### One container or two — TWO, and the measurement that decided it
`vitest`'s `provide` is **per-project** (confirmed in the vitest 4 docs: project context overrides root), so a value db-server's globalSetup provides is injectable only by db-server tests. The connection-budget guard must also check **each project's** live `maxWorkers` against the container it will use — review-73's fix, which a root-level project-blind setup cannot preserve. So each project boots its OWN container; they run in different `sequence.groupOrder`s (db-server=1, server=2), never both hot. Measured cost of two containers: `pnpm test` boots both in ~9 s total (fsync-off boot ~7–9 s each), full suite green — affordable, so the guard-integrity win is free.

### `pnpm test` — the acceptance gate (read the log, not the exit code, T-18)
`Test Files 198 passed (198)`, `Tests 2856 passed (2856)`, `EXIT=0`. Both lanes' `lane UP …` provenance lines printed. The **zero-tests trap that blocked task 73 did NOT reappear**: `server` sits in its own `sequence.groupOrder: 2` (db-server is 1, the ~10 no-`maxWorkers` projects share the implicit 0), so no two projects share a group with different `maxWorkers`.

### Wall-clock (MEASURED on the same loaded box, EXIT lines read from the logs — not inherited)
Measured both ends myself (a throwaway worktree at `c168fc6` for the before, so the comparison is apples-to-apples on the same host), rather than quoting the brief's 550–685 s estimate:

| lane | before (PGlite, `fileParallelism: false` — c168fc6) | after (real PG16, parallel — this branch) |
| ---- | --------------------------------------------------- | ----------------------------------------- |
| `pnpm test:server` (incl. `tsc -b`) | **9:29.25 = 569 s**, 54 files / 406 tests, `EXIT=0` | **1:10.55 = 71 s**, 54 files / 406 tests, `EXIT=0` (vitest-only 24.6 s) |
| `pnpm test` full (incl. `tsc -b`) | — | **2:11.5**, 198 files / 2856 tests, `EXIT=0` (vitest-only 54.6 s) |

**~8× faster** (569 s → 71 s), same 54 files / 406 tests, both `EXIT=0`. The move is for **FIDELITY** (D16), not speed — but real-PG won wall-clock decisively anyway: the substitute's per-file cost was WASM-boot-plus-migrate, which template cloning removes (the brief's hypothesis, now confirmed by measurement rather than inherited — T-16 clause 6). The 569 s lands inside the brief's 550–685 s estimate, which is a nice cross-check but not the number I'm reporting.

### The value proof — honest statement (T-11)
No apps/server assertion produced a **new red** on real PG16 that PGlite hid: all 406 apps/server tests pass on real `pg`. That is expected and I am stating it rather than manufacturing a red — the int8/marshalling-sensitive code was **relocated into db-server** (watermark store, projection engine, Rule-1 candidates — `db-server/src/index.ts`), where `test:rls` already witnesses the silent class over the real driver. What moving `apps/server` buys is: **RLS that can actually fail** (proven below), **PG16 version parity** (PGlite embeds PG18), and the **real `pg` driver** under the push pipeline / validation / conflict / projection orchestration that lived only behind the blind lane. (The int8 "alibi" trap in T-14f — 2^53 is green *with* the bug — is why I did not go fishing for a fake red here.)

### RLS falsification, with its positive control (T-14b / T-17)
Target: `SEC-MEDIA-03` (`sec-media.test.ts`), a cross-tenant fence with a control. Neutered `SET LOCAL ROLE bolusi_app` in the media harness → the probe ran as the container's default `postgres` **superuser** → the fence went **RED**: `expected [ Array(1) ] to deeply equal []` at line 198 — the superuser read tenant B's media across the boundary (RLS bypassed under FORCE). That the row was **visible** to the superuser is the positive control: the fixture is real; RLS is what hides it. Restored → GREEN (6/6). **The ROLE closes it, not the engine** (T-14b), exactly as the brief warned.

### Two operational defects found and fixed by construction (both measured, both falsified by watching them fail)
1. **Postgres CRASH under full parallelism.** First full run: **43/54 files failed**, `the database system is in recovery mode` + `Connection terminated unexpectedly` (NOT `too many clients` — a crash, not a connection-cap rejection; host had 42 GB free, so not OOM). Cause: `CREATE DATABASE … TEMPLATE` forces a cluster checkpoint+fsync, and per-file clones at `maxWorkers: 24` on a shared box made that an fsync storm. Fix: the container is ephemeral (Ryuk reaps it), so it runs `fsync=off synchronous_commit=off full_page_writes=off` — durability an throwaway test cluster has no use for. Re-run: **43/54 failing → 0**.
2. **Process HANG after "Test Files N passed".** Even a passing single file hung ~4 min post-summary. The Node diagnostic report (`--report-on-signal`, SIGUSR2) showed the **one** referenced+active handle was a vitest worker IPC **pipe** — the fork worker's idle `pg` pool pinned its event loop, so the worker never exited and the main process waited on it. Fix: `allowExitOnIdle: true` on every pool, so an idle pool never keeps its worker alive. Re-run: 4 min hang → **clean `Exit status: 0` in 34 s**. (db-server's per-file/`beforeAll` harness never hit this because it holds one pool per file; apps/server's `beforeEach` harnesses cycle many.)

Note also: `createTestDatabase` mints a **per-call** clone name (file prefix + per-process counter), because apps/server's harnesses clone per **test** (`beforeEach`), not per file — without it the second `beforeEach` failed `CREATE DATABASE … already exists`.

### CI
`.github/workflows/ci.yml` stage 8 (`server-integration`) corrected: it claimed "NO postgres service container BY DESIGN … in-process PGlite" and "22 files / 162 tests" — now false. It runs real PG16 via testcontainers; still **no `services:` block** (same ruling as `rls-witness` — a declared service would sit unused while tests hit the testcontainer, a real green with fictional provenance, T-14d). Stage 4 `unit` (`pnpm test`) already needs Docker post-73; it now boots two containers, unchanged and green on ubuntu-latest.

### Never `.withReuse()` — kept. No orphan of mine survives (Ryuk reaps on any exit; `pnpm db:down` untouched).
