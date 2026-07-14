import { defineConfig } from 'vitest/config';

// Root projects config (08-stack-and-repo §5.4). Every workspace carries its own
// vitest.config.ts and >=1 test — passWithNoTests is deliberately NOT set anywhere.
export default defineConfig({
  test: {
    projects: [
      'apps/*/vitest.config.ts',
      'packages/*/vitest.config.ts',
      'tooling/*/vitest.config.ts',
    ],
  },
});
