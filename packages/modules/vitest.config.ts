import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'modules',
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
    // STARVATION MARGIN, not a work-time budget (task 111, inheriting task 67's class + method).
    // `test/applier-conformance.test.ts` (T-8, the both-engine merge gate) is the HEAVIEST body in
    // the class: each of its two tests calls `openEngines()`, which stands up a real better-sqlite3
    // engine AND a real PGlite engine, runs the FULL migrations on both, then folds a 6-op script
    // through the real projection engine twice and digests both projections. Task 93's triage filed
    // this package under "not candidates" by reading the PACKAGE name ("modules = pure module
    // logic"); the BODY drives two database engines. That miss is why task 111 exists, and it is the
    // reason this comment states what the body DOES rather than where it lives (T-12).
    //
    // MEASURED on this 48-core runner (vitest json reporter, per-test `duration`), both tests:
    //   idle (loadavg 12->19):     max 3133ms, per-run maxima 3133 / 2629 / 2567ms
    //   2x oversubscription:       max 13251ms  (96 spinners, loadavg 27->97)
    //     per-iteration pairs: 8691+6973 / 13251+9136 / 9247+7515ms
    //   4x oversubscription:       max 28764ms  (192 spinners, loadavg 105->214)
    //     per-iteration pairs: 18879+16947 / 18303+28764 / 26783+23056ms
    // Unlike the sibling lanes this one was ALREADY RED in the wild, not a near-miss: holding the
    // 5000ms default fixed and varying ONLY load, 3 of 3 consecutive runs failed BOTH tests with
    // "Error: Test timed out in 5000ms." at merely 2x oversubscription. With ~3.1s of legitimate
    // idle work the default left a ~1.9s margin — the thinnest in the repo.
    //
    // WHY 60000 AND NOT THE REPO-WIDE 20000 — the one number here that is NOT copied from
    // db-client/test-support/mobile, because the measurement forbids it. Those lanes derived 20000
    // from 4x-oversubscription ceilings of 100ms / 6478ms / 2966ms. This lane's 4x ceiling is
    // 28764ms — it would have RED at 20000ms too. The repo carries one starvation *method*, not one
    // magic number, and a shared constant that is known-insufficient for this body would be a gate
    // green for the wrong reason waiting to happen (§2.11). 60000ms is ~2.1x the measured 4x ceiling
    // (28764ms), ~4.5x the 2x ceiling (13251ms), and ~19x the idle ceiling (3133ms) — the same
    // multiplier band the siblings used, applied to THIS body's measured tail.
    //
    // Falsified (§2.11), not assumed: with `noteBodyEditedApplier` made engine-dependent (a
    // module-level call counter, so the postgres pass writes a different `body` than the sqlite
    // pass), BOTH tests red FAST and on the real defect, not on the clock:
    //   - the digest test, 2442ms: "Error: applier conformance FAILED (04 §2 / T-8): module notes
    //     produced different projections on sqlite and postgres. sqlite: a82c75d6… postgres:
    //     0923ec56…" — the runner's own dialect-divergence throw, naming both digests.
    //   - the semantics test, 1881ms: "AssertionError: expected 'edit-2 (canonically-later
    //     wins)-PG-DIVERGENCE' to be 'edit-2 (canonically-later wins)'".
    // Both land at roughly IDLE speed — ~4% of the 60000ms bound — because a divergent fold is
    // detected the moment the second engine's digest is computed, not by waiting. Reverted; the
    // suite is green again (2 passed, EXIT=0). The longer bound absorbs scheduling jitter only; it
    // masks no defect this suite can see.
    // hookTimeout matches: same engines, same wall-clock starvation exposure.
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
