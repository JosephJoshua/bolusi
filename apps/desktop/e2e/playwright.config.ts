// Drives the Electron app, built fresh by `build.ts` before every run. On Linux it needs a
// display: run it under xvfb-run.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: import.meta.dirname,
  globalSetup: `${import.meta.dirname}/build.ts`,
  outputDir: `${import.meta.dirname}/test-results`,
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [['list']],
});
