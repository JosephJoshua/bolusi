// Drives the built Electron app (`pnpm --filter @bolusi/desktop e2e` builds it first). On Linux CI
// it needs a display: run it under xvfb-run.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: import.meta.dirname,
  outputDir: `${import.meta.dirname}/test-results`,
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [['list']],
});
