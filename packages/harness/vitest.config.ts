import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'harness',
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}', 'scenarios/**/*.test.{ts,tsx}'],
    // Chaos volumes are large (CHAOS-08: 20,000 ops) — the long-timeout lane of 08 §5.4.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
