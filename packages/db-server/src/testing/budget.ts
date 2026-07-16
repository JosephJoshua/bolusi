// The connection budget for the L3 lane — ONE definition, imported by everything that depends on
// it (CLAUDE.md §2.8; task 73, review-73 finding 4).
//
// WHY THIS IS ITS OWN MODULE RATHER THAN CONSTANTS IN pg-container.ts
// -------------------------------------------------------------------
// Two places must agree about how many test files may run at once: `vitest.config.ts` (which sets
// `maxWorkers`) and `assertConnectionBudget` (which checks the arithmetic against the live
// server). The first version of this lane wrote `maxWorkers: 24` as a BARE LITERAL and claimed in
// a comment that the guard "re-derives this against the LIVE server … so this comment cannot
// quietly rot". It could: the guard only ever checked its OWN constant, so setting `maxWorkers:
// 110` left the guard green (24 × 2 + 10 ≤ 197) while the run opened 220 connections. review-73
// falsified exactly that. A guard that cannot see the number it is guarding is the §2.11 class.
//
// So the number lives HERE, in a module with NO imports — `vitest.config.ts` can import it
// without dragging `@testcontainers/postgresql` and `pg` into config resolution, and there is
// exactly one literal to change.

/**
 * Connections each test file's pool may open.
 *
 * Kept small on purpose: files are the unit of parallelism here, and a per-file pool bigger than
 * the concurrency inside a file buys nothing but connections. `oplog-server-seq-concurrency`
 * needs two to prove a genuine row-lock race, which is what sets this floor.
 */
export const POOL_PER_FILE = 2;

/** Connections reserved for the clone/maintenance path and the attribution probes. */
export const HEADROOM = 10;

/**
 * `max_connections` for the test container, raised from the stock 100 DELIBERATELY.
 *
 * The cost is real, not theoretical: each backend is a PROCESS with its own `work_mem`, so 200
 * backends is ~200 × 4 MB ≈ 800 MB worst case. Affordable here (measured: 43 GB available), and
 * the reason to prefer SHARDING to a second container over raising this without limit.
 */
export const MAX_CONNECTIONS = 200;

/**
 * The most test files that may run concurrently against ONE container — i.e. vitest `maxWorkers`.
 *
 * The cap is CONNECTIONS, not database count: an idle cloned database costs disk and catalog rows,
 * while a parallel file costs a pool. The budget is
 *
 *   MAX_PARALLEL_FILES × POOL_PER_FILE + HEADROOM ≤ max_connections − superuser_reserved_connections
 *   24                 × 2             + 10       = 58  ≤  200 − 3 = 197        ✓
 *
 * and `assertConnectionBudget` re-derives it against the LIVE server at boot, from the value
 * vitest actually configured — not from this constant — so the two cannot silently disagree.
 *
 * Measured (task 73): exceeding the server's real ceiling produces `sorry, too many clients
 * already` (SQLSTATE 53300) in ~1.1 s. That is the failure mode this budget exists to keep: an
 * attributable error, never a wedge.
 */
export const MAX_PARALLEL_FILES = 24;
