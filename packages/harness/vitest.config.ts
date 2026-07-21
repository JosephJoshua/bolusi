import { defineConfig } from 'vitest/config';

import { activeVolumes } from './src/volumes.js';

// Chaos volumes are large (CHAOS-08: 20,000 ops) — the long-timeout lane of 08 §5.4. The ceiling
// SCALES with `CHAOS_SCALE` (via the same `activeVolumes` seam every scenario reads, never a second
// parse of the env): a chaos case's cost is volume-proportional, so a flat 120 s that fits the CI
// volume is BELOW the nightly ×4 case's own runtime (CHAOS-08 at 80,000 ops is ~216 s) and would red
// the whole ×4 lane as a budget artefact rather than a bug. At CI scale this is the same 120 s as
// before; at ×4 it is 480 s, preserving the headroom ratio. Scenarios with their own measured cost
// (CHAOS-03) still pass an explicit per-test timeout, which likewise scales.
const CHAOS_TIMEOUT = 120_000 * activeVolumes().scale;

export default defineConfig({
  test: {
    name: 'harness',
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}', 'scenarios/**/*.test.{ts,tsx}'],
    testTimeout: CHAOS_TIMEOUT,
    hookTimeout: CHAOS_TIMEOUT,
  },
});
