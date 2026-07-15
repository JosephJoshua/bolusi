import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * `@bolusi/ui` runs its component tests on `test-renderer` (React 19's maintained replacement for
 * the deprecated `react-test-renderer`) against DOUBLES of the native packages — see the header of
 * `test/doubles/react-native.tsx` for the full rationale and the honest limits.
 *
 * Short version: real `react-native` is Flow source that esbuild cannot parse, and
 * `@testing-library/react-native@14` hard-peers on `jest >=29`, which this vitest-only repo
 * (08-stack §5.4) will not adopt. Aliases apply to the TEST LANE ONLY — `tsc` resolves the real
 * `react-native` types, so every prop these components pass is still compiler-checked against
 * real RN.
 */
export default defineConfig({
  resolve: {
    alias: {
      'react-native': fileURLToPath(new URL('./test/doubles/react-native.tsx', import.meta.url)),
      // Exact subpath: `Icon.tsx` imports the single icon family rather than the barrel, so the
      // 2 GB-device bundle never carries every glyph set (design-system §0 dependency weight).
      '@expo/vector-icons/MaterialCommunityIcons.js': fileURLToPath(
        new URL('./test/doubles/expo-vector-icons.tsx', import.meta.url),
      ),
    },
  },
  test: {
    name: 'ui',
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
  },
});
