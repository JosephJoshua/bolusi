import { defineConfig } from 'vitest/config';

// Build shared packages first with `tsc -b ../..`; cross-package imports resolve to dist/.
export default defineConfig({
  test: {
    name: 'device',
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
    // File-backed SQLite and signing tests need headroom under parallel CPU load (as in mobile).
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
