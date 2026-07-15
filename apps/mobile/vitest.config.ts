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
    // Colocated `*.test.ts(x)` beside the code (08 §5.4), plus `test/` for config-level suites.
    // `.tsx` is included deliberately: the previous `test/**/*.test.ts` would have silently skipped
    // every screen test this task adds — a lane that runs nothing reports green (T-14c).
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
  },
});
