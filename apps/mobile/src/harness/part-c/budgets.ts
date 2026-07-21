// Part C gate budgets — pinned as code, mirroring testing-guide §4.2 VERBATIM. A widened constant is
// a SPEC CHANGE (edit §4.2 in its own task), never a "fix" to make a red gate pass; `budgets.test.ts`
// re-states the §4.2 table and fails if any number here drifts (guards the silent-widening class,
// CLAUDE.md §2.11).
//
// SCOPE (D12/D20 §1): P-1..P-6 and the write-throughput floor are PERFORMANCE gates. They are pinned
// here so the constant is version-controlled, but they RUN on the physical 2 GB reference device
// (task 27b, owner-deferred) — an emulator cannot produce a device perf number. The emulator lane
// (27a) may emit these figures for regression tracking, ALWAYS labelled EMULATOR, never as
// acceptance. SEC-AUTH-10 (the argon2id KDF timing benchmark, P-4) is likewise 27b.

/** argon2id parameters (D8; api/02-auth). The default is validated on the real device by P-4; if it
 * exceeds 300 ms the documented FLOOR is engaged and recorded — that decision is 27b's. */
export interface Argon2idParams {
  readonly memKiB: number;
  readonly timeCost: number;
  readonly parallelism: number;
}

export const PART_C_BUDGETS = Object.freeze({
  /** P-1 — cold start with SEED-200K: < 3,000 ms on EVERY one of 5 cold launches (not median). */
  p1ColdStartMaxMs: 3_000,
  p1ColdLaunches: 5,

  /** P-2 — full projection rebuild of SEED-200K: ≤ 300 s total; peak PSS ≤ 400 MB; PSS sampled every
   * 5 s; progress UI ≥ 1 fps. 300 s = the 667 ops/s floor over 200k ops. */
  p2RebuildMaxSeconds: 300,
  p2PeakPssMaxMb: 400,
  p2PssSampleEverySeconds: 5,
  p2MinProgressFps: 1,

  /** P-3 — 1-week backlog sync ≤ 60 s: pull 3,500 foreign ops (7 batches) + push 500 (1 batch). */
  p3BacklogMaxSeconds: 60,
  p3PullOps: 3_500,
  p3PullBatches: 7,
  p3PushOps: 500,
  p3PushBatches: 1,

  /** P-4 — argon2id PIN verify p95 < 300 ms over 20 runs at the default params; else engage the floor. */
  p4VerifyP95MaxMs: 300,
  p4Runs: 20,
  p4DefaultParams: Object.freeze({ memKiB: 32_768, timeCost: 3, parallelism: 1 }) as Argon2idParams,
  p4FloorParams: Object.freeze({ memKiB: 19_456, timeCost: 2, parallelism: 1 }) as Argon2idParams,

  /** P-5 — createNote execute→append→apply→commit p95 ≤ 100 ms over 200 runs on top of SEED-200K. */
  p5ExecuteP95MaxMs: 100,
  p5Runs: 200,

  /** P-6 — per-op crypto (JCS + SHA-256 + Ed25519 sign) p95 ≤ 5 ms over 1,000 iterations. */
  p6CryptoP95MaxMs: 5,
  p6Iterations: 1_000,

  /** Write benchmark — raw op-log append ops/s; NO budget gate, reported vs the P-2 667 ops/s floor. */
  writeThroughputFloorOpsPerSecond: 667,
});
