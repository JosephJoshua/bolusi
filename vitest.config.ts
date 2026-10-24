import { defineConfig } from 'vitest/config';

// Run every behavioral suite once, including the cross-module security probes.
export default defineConfig({
  test: {
    projects: [
      'apps/*/vitest.config.ts',
      'packages/*/vitest.config.ts',
      'packages/harness/vitest.security.config.ts',
      'tooling/*/vitest.config.ts',
    ],
  },
});
