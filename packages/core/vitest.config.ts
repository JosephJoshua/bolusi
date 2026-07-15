import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'core',
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
    // Why 30s and not the 5s default (task 35): core's projection property suites fold thousands
    // of ops through a real SQLite harness, so they legitimately cost seconds. Measured on this
    // 48-core box under deliberate saturation (64 spinners) to model a loaded CI runner —
    // idle vs the observed spread over 5 saturated runs:
    //
    //   rebuild.test.ts     drop-tables rebuild @2080 ops  1.8s idle -> 4.4/6.3/6.5/6.7/9.4s
    //   rebuild.test.ts     interrupted-rebuild resume     1.1s idle -> 2.7 .. 4.0s
    //   convergence.test.ts per-seed case (post-split)     0.5s idle -> p50 1.1s, p95 2.7s, max 3.5s
    //
    // At the 5s default the drop-tables test timed out 3 of 5 saturated runs and resume peaked at
    // 4.0s (80% of budget): the same latent flake as convergence, unfired in CI only because
    // runners happened to be quiet. A timeout is a HANG detector, not a performance gate. Sized
    // off the worst measured legitimate run (9.4s) x ~3.2. The headroom is deliberately not 2x:
    // the contention spread on a SINGLE machine is already 5.2x (1.8s -> 9.4s), so a 2x margin
    // sits inside the observed noise. Past 30s is not contention on a plausible runner — it is a
    // hang, which must still fail here. Cost is bounded: a hung test reports in 30s rather than
    // 5s, against a ~7s whole-suite run.
    //
    // This ceiling is NOT a licence to let tests grow into it — that is how the 5s default was
    // lost. Convergence is split per-seed so each case stays ~0.5s (~2% of budget, 9% at p95);
    // keep new property tests small enough that the ceiling never binds.
    testTimeout: 30_000,
  },
});
