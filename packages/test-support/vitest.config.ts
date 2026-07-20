import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'test-support',
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
    // STARVATION MARGIN, not a work-time budget (task 93, inheriting task 67's class + method).
    // `src/secret-scan.test.ts` (SEC-SECRET-02) spawns a REAL `gitleaks` subprocess per test. The
    // cost is process startup + rule-set load, which is wall-clock and almost entirely at the
    // scheduler's mercy — exactly db-client's class, one lane over.
    //
    // MEASURED on this 48-core runner (vitest json reporter, per-test `duration`):
    //   true idle (loadavg ~62):   552 / 565 / 576 / 580 / 609ms — remarkably tight, ~570ms typical
    //   4x CPU oversubscription:   3182 / 3142 / 4039 / 6478ms (192 spinners, loadavg 115->207)
    // Unlike the mobile lane this one was NOT a near-miss — it went RED, reproducibly: holding the
    // 5000ms default fixed and varying ONLY load, 4 of 6 consecutive runs failed with
    // "Error: Test timed out in 5000ms." on a body that is green in ~570ms idle. An ~11x tail
    // inflation on unchanged work is worker starvation, not a slow scanner.
    //
    // 20000ms is derived, not guessed: ~3x the worst observed under deliberate 4x oversubscription
    // (6478ms) and ~33x the idle ceiling (609ms), matching db-client/core so the repo carries ONE
    // starvation margin. A red now requires starvation ~3x worse than the stress that produced the
    // reproduction above.
    //
    // THIS DOES NOT WEAKEN SEC-SECRET-02 (security-guide §10, mandatory scan). A MISSING gitleaks
    // never reaches the timeout: `spawnSync` returns `result.error` (ENOENT) immediately and the
    // test THROWS. Falsified (§2.11) rather than assumed, both legs:
    //   - PATH without gitleaks -> BOTH tests red on "gitleaks is not runnable (spawnSync gitleaks
    //     ENOENT)" at 13ms of test time. A missing scanner is still a hard, immediate fail.
    //   - planted credential replaced with a non-credential -> reds on "AssertionError: expected +0
    //     to be 1" at 1.15s of test time.
    // Both are fast, specific reds well inside the bound; the longer bound absorbs scheduling
    // jitter only and masks neither.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
