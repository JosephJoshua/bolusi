import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// `fileURLToPath(import.meta.url)` (a STRING) rather than `fileURLToPath(new URL(…))`: this package
// compiles under Expo's tsconfig base, whose `lib: ["DOM", …]` makes the global `URL` the DOM one,
// which is not node's `URL`. Passing the string keeps the config typechecked instead of needing a
// node/DOM lib fight or an ignore.
const HERE = dirname(fileURLToPath(import.meta.url));

// These tests use native doubles: they verify screen logic, not native layout or behavior.
// Build shared packages first with `tsc -b ../..`; cross-package imports resolve to dist/.
export default defineConfig({
  resolve: {
    alias: {
      'react-native': resolve(HERE, 'test/doubles/react-native.tsx'),
      'react-native-svg': resolve(HERE, '../../packages/ui/test/doubles/react-native-svg.tsx'),
      '@expo/vector-icons/MaterialCommunityIcons.js': resolve(
        HERE,
        '../../packages/ui/test/doubles/expo-vector-icons.tsx',
      ),
      // The notes module screens (task 96) render a media thumbnail through `expo-image`, a native
      // module esbuild cannot load — doubled like `react-native`, types still checked against the SDK.
      'expo-image': resolve(HERE, 'test/doubles/expo-image.tsx'),
      // Native insets provider; App reads its context and falls back without one.
      'react-native-safe-area-context': resolve(HERE, 'test/doubles/safe-area-context.tsx'),
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
    // File-backed SQLite and signing tests need headroom under parallel CPU load.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
