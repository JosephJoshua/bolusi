import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'harness',
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}', 'scenarios/**/*.test.{ts,tsx}'],
    // `test/security/**` is the SECURITY-SWEEP lane and runs under vitest.security.config.ts
    // (`pnpm sec:sweep`), not here: the chaos stage gates correctness-under-disorder and must be
    // able to stay green while a security probe is red, and vice versa. That the lane really runs
    // is enforced by the inventory's pass-status check, not by convention (see that config).
    exclude: ['test/security/**'],
    // Chaos volumes are large (CHAOS-08: 20,000 ops) — the long-timeout lane of 08 §5.4.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
