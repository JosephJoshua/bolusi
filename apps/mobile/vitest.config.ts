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
  },
});
