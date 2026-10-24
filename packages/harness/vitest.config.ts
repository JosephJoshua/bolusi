import { defineConfig } from 'vitest/config';

import { activeVolumes } from './src/volumes.js';

const CHAOS_TIMEOUT = 120_000 * activeVolumes().scale;

export default defineConfig({
  test: {
    name: 'harness',
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}', 'scenarios/**/*.test.{ts,tsx}'],
    exclude: ['test/security/**'],
    testTimeout: CHAOS_TIMEOUT,
    hookTimeout: CHAOS_TIMEOUT,
  },
});
