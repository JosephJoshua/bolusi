import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// The SECURITY-SWEEP lane (task 28; 08 §5.6 release gate) — deliberately its OWN config, not part
// of the `harness` project, and NOT globbed by the root `vitest.config.ts` (which collects only
// `packages/*/vitest.config.ts`).
//
// WHY SEPARATE. `pnpm chaos` (CI stage 11) is correctness-under-disorder; this lane is
// correctness-under-malice (security-guide §12). They gate different things and must be able to
// go red independently: a cross-tenant leak found here should block the RELEASE gate, not silently
// re-label the chaos stage, and a chaos regression should not be reported as a security failure.
//
// THE HOLE THIS OPENS, AND HOW IT IS CLOSED (T-14): a suite excluded from the default run is a
// suite that can stop running unnoticed. `scripts/sec-inventory.mjs` closes it by construction —
// it reads this lane's OWN JSON report and requires every SEC id to have a test title that
// actually PASSED, so if the lane does not run, SEC-TENANT-04 / SEC-SECRET-01 have no passing
// producer and the sweep fails. The gate does not depend on anyone remembering to invoke it.
export default defineConfig({
  // Invoked as `vitest run --config packages/harness/vitest.security.config.ts` from the repo
  // root, so the root must be pinned to this package or the include glob resolves nowhere.
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: 'harness-security',
    environment: 'node',
    include: ['test/security/**/*.test.{ts,tsx}'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
