import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// `fileURLToPath(import.meta.url)` (a STRING) rather than `fileURLToPath(new URL(…))`: this package
// compiles under Expo's tsconfig base, whose `lib: ["DOM", …]` makes the global `URL` the DOM one,
// which is not node's `URL`. Passing the string keeps the config typechecked instead of needing a
// node/DOM lib fight or an ignore.
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * `@bolusi/mobile`'s test lane (08 §5.4). Screen LOGIC runs here on `test-renderer` against doubles
 * of the native packages — see `test/doubles/react-native.tsx`, which composes `@bolusi/ui`'s double
 * rather than copying it.
 *
 * WHAT THIS LANE CAN AND CANNOT ANSWER (stated here so nobody reads more into a green run):
 *   - CAN: which state a screen renders, which label KEY it resolves, which testIDs/roles exist,
 *     which seam it called and with what. That is the whole of this task's screen-logic acceptance.
 *   - CANNOT: Yoga layout, real virtualization windowing, native a11y, font scaling — and therefore
 *     the banner-truncation check (task 23's carried RISK), which is measured on-device via
 *     `onTextLayout`. No assertion in this lane may stand in for that one.
 *
 * `environment: 'node'` on purpose: there is no DOM here and nothing should pretend there is.
 *
 * ── THE LANE MUST BE ENTERED THROUGH `tsc -b ../..` (08 §5.6, normative) ────────────────────────
 * This package's `test` script is `tsc -b ../.. && vitest run`, NOT a bare `vitest run`, and the
 * prefix is load-bearing rather than tidy. `@bolusi/core` and `@bolusi/i18n` both resolve through
 * their `dist/`, so a bare run tests whatever was built LAST — not the source on disk. 08 §5.6 makes
 * this a rule ("any test script that imports a built cross-package entry MUST prefix `tsc -b &&`")
 * and records `test:server` being repaired for exactly this.
 *
 * It is not hypothetical here, twice over: a reviewer mutated `src`, skipped the rebuild, and this
 * lane reported 10 passed / EXIT=0 against genuinely broken source; and task 24's own first
 * falsification of the i18n key-existence test came back GREEN with a catalog key deleted, because
 * the edit landed in `src` while the test loaded `dist`. Both are one failure — a green describing a
 * stale artifact.
 *
 * WHY `../..` AND NOT A BARE `tsc -b` — the detail that makes the difference between a fix and a
 * fake one. `tsc -b` resolves THIS package's tsconfig, which has no `references` and cannot get any:
 * 08 §5.6 line 200 is explicit that `apps/mobile` must not be composite ("composite would force emit
 * through Expo's config"). So a bare `tsc -b` here builds only this project — which is `noEmit` —
 * and rebuilds no dependency at all. The ROOT tsconfig is the solution file holding every
 * `references` entry (§5.6 line 198), so `../..` is what actually rebuilds `@bolusi/*` dist.
 *
 * Verified by falsification, not by reading: with `CHAIN_HALTED` deleted from the `en` catalog
 * SOURCE and dist left stale, `vitest run` → EXIT=0 (fake green) and a bare `tsc -b && vitest run`
 * → EXIT=0 (fake green, dist untouched), while `tsc -b ../.. && vitest run` → EXIT=2, rebuilding
 * dist and failing on the real defect. Incremental, so it is a no-op once built.
 */
export default defineConfig({
  resolve: {
    alias: {
      'react-native': resolve(HERE, 'test/doubles/react-native.tsx'),
      '@expo/vector-icons/MaterialCommunityIcons.js': resolve(
        HERE,
        '../../packages/ui/test/doubles/expo-vector-icons.tsx',
      ),
      // The notes module screens (task 96) render a media thumbnail through `expo-image`, a native
      // module esbuild cannot load — doubled like `react-native`, types still checked against the SDK.
      'expo-image': resolve(HERE, 'test/doubles/expo-image.tsx'),
    },
  },
  test: {
    name: 'mobile',
    environment: 'node',
    // Boots the REAL i18n instance (see the file) — @bolusi/i18n throws rather than lazily
    // initialising, and screens resolve labels through it.
    setupFiles: ['./test/setup.ts'],
    // Colocated `*.test.ts(x)` beside the code (08 §5.4), plus `test/` for config-level suites.
    // `.tsx` is included deliberately: the previous `test/**/*.test.ts` would have silently skipped
    // every screen test this task adds — a lane that runs nothing reports green (T-14c).
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
    // STARVATION MARGIN, not a work-time budget (task 93, inheriting task 67's class + method).
    // `test/bootstrap.test.ts` and `src/bootstrap/{bundle,sync-client,enrollment,recovery,
    // device-info,runtime}.test.ts` drive a REAL file-backed better-sqlite3 DB through the REAL
    // CLIENT_MIGRATIONS (several open/migrate/close cycles per test) plus real ed25519 signing.
    // Unlike db-client's sub-millisecond in-memory bodies, that work is legitimately ~100s of ms —
    // which is why the default 5000ms was already the thinnest margin in the repo, not a roomy one.
    //
    // MEASURED on this 48-core runner (vitest json reporter, per-test `duration`), full lane:
    //   idle (loadavg ~10):        max 1423ms  (bootstrap "opens, migrates, and PERSISTS"), median 1.4ms
    //   4x CPU oversubscription:   max 2966ms  (192 spinners, loadavg 119->195), median 3.2ms
    //     per-iteration maxima: 652 / 2170 / 944 / 2966ms — the TAIL tracks load, the median barely
    //     moves, which is the signature of worker descheduling rather than slow code.
    // At 2966ms the default budget was 59% consumed by scheduling alone. The sibling lane in this
    // same class (packages/test-support secret-scan) crossed the line under the identical stress —
    // "Test timed out in 5000ms", 4 of 6 runs — so this is a measured near-miss, not a hypothetical.
    //
    // 20000ms is derived, not guessed: ~7x the measured 4x-oversubscription ceiling (2966ms), ~14x
    // the idle ceiling (1423ms), and it matches db-client/core so the repo carries ONE starvation
    // margin rather than a per-package guess. A red now requires starvation ~7x worse than a
    // deliberate 4x-oversubscription stress, while a genuinely hung bootstrap still fails in 20s.
    // Falsified (§2.11), not assumed: with `bootstrap()`'s enrolled-device gate broken
    // (`const deviceId = await readDeviceId(...)` -> `= null`), the guarded test reds on
    // "AssertionError: expected null to be 'device-abc'" with the whole file at 1.70s of test time
    // — a real, specific assertion, NOT the timeout. The bigger bound absorbs jitter only.
    // hookTimeout matches: `beforeEach`/`afterEach` close the DB and mkdtemp/rm real directories —
    // same engine, same wall-clock starvation exposure as the bodies.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
