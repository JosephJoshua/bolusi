/**
 * Playwright config for the react-native-web visual harness (task 116).
 *
 * Serves the exported web bundle (`dist/`, produced by `expo export --platform web`) with the
 * tiny dependency-free static server, then drives it headless in Chromium. This is the browser
 * APPROXIMATION lane — it never replaces the device gates (27a/27b) or native E2E (117).
 *
 * The bundle must already be built: `pnpm --filter @bolusi/mobile test:visual` runs `tsc -b` +
 * `expo export` first, then this. Run alone, it reuses whatever `dist/` is on disk.
 */
import path from 'node:path';

import { defineConfig } from '@playwright/test';

const MOBILE_ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env['VISUAL_PORT'] ?? 4599);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: __dirname,
  outputDir: path.join(__dirname, 'test-results'),
  // A phone-shaped viewport: the screens target ~360 dp Android (design-system §0). Serialized (not
  // fullyParallel) so the shared static server and the fixed demo clock stay deterministic.
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    browserName: 'chromium',
    headless: true,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
  },
  webServer: {
    command: `node ${path.join(__dirname, 'static-server.mjs')} ${path.join(MOBILE_ROOT, 'dist')}`,
    url: BASE_URL,
    // Always start a FRESH server bound to `dist`. `reuseExistingServer: true` is a footgun here:
    // a leftover static-server from an earlier run (a spike bundle, a stale dist) silently answers on
    // the port and the whole suite validates the WRONG bytes — a real green with fictional provenance
    // (CLAUDE.md §2.1). `false` makes a port collision fail loud instead.
    reuseExistingServer: false,
    timeout: 60_000,
    env: { PORT: String(PORT) },
  },
});
