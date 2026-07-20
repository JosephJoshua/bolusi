import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'eslint-config',
    environment: 'node',
    include: ['src/**/*.test.js'],
    // STARVATION MARGIN, not a work-time budget (task 111, inheriting task 67's class + method).
    // This lane was the SECOND member task 93's package-name triage missed (task 111's by-BODY
    // re-sweep, T-12): "eslint-config = rule unit tests" reads like pure logic, but two files do
    // real subprocess-class work in their bodies:
    //   - `src/emitted-exports.test.js` (task 57) walks EVERY workspace's emitted `dist/` and parses
    //     each `.d.ts` with the REAL `typescript` compiler API (ts.createSourceFile), plus mkdtemp
    //     fixtures — a whole-monorepo FS + TS-parse sweep, not a unit test.
    //   - `src/config.test.js` boots the REAL ESLint flat-config engine (`new ESLint`, the
    //     typescript-eslint parser) and lintText's real sources.
    // The 11 RuleTester rule suites are trivial and ride along under the same bound harmlessly.
    //
    // MEASURED on this 48-core runner (vitest json reporter, per-test `duration`), full lane:
    //   idle (loadavg 12->14):     max 388ms  (emitted-exports.test.js), everything else <120ms
    //   2x oversubscription:       max 1440ms (96 spinners, loadavg 23->57)
    //     emitted-exports per-iteration maxima: 1440 / 1347 / 1151ms — the TAIL tracks load.
    // A ~3.7x tail inflation on a 388ms body at only 2x is the same worker-descheduling signature
    // the sibling lanes measured; the class's heavier members (test-support gitleaks) inflated ~11x
    // under 4x, so the default 5000ms is a genuine near-miss here, not a comfortable margin.
    //
    // 20000ms — the repo-standard bound (db-client/test-support/mobile), and ample here BECAUSE this
    // lane is LIGHT: ~14x the 2x ceiling (1440ms), ~51x the idle ceiling (388ms). (Contrast the
    // modules lane in this same re-sweep, whose 3133ms idle / 28764ms 4x tail forced 60000 — the
    // repo carries one starvation METHOD, sized to each body, not one magic number.)
    //
    // Falsified (§2.11), not assumed: with a forbidden input `.d.ts` planted under a workspace
    // `src/` (the task-39 seed emitted-exports guards), test A) reds in 14ms on
    // "AssertionError: input .d.ts under src/ … expected [ Array(1) ] to deeply equal []" — a real,
    // specific assertion at idle speed (~0.07% of the bound), NOT the clock. Every real failure this
    // lane can see is a synchronous fs/AST assertion; the longer bound absorbs scheduling jitter
    // only and masks none. (The checker also ships its own RED/GREEN synthetic fixtures, sub-ms.)
    // hookTimeout matches: `afterAll` rmSync's the mkdtemp fixtures — same wall-clock exposure.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
