// The sync per-device rate cap (api/01-sync §2 owns the number: 120 req/min/device across
// /v1/sync/*; api/00 §11 owns the posture + the 429 shape). The limiter is app-level (§13 step 7)
// and keyed per device on ONE bucket shared by push and pull — so a runaway client cannot grind the
// server by alternating endpoints. The harness clock is frozen, so no token refills mid-test.
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { DEFAULT_DEVICE_RATE_LIMITS } from '../../../src/deps.js';
import { readError } from '../../helpers/http.js';
import { makeSyncHarness, type SyncHarness } from './helpers.js';

let h: SyncHarness;
beforeEach(async () => {
  h = await makeSyncHarness();
});
afterEach(async () => {
  await h.close();
});

const CAP = DEFAULT_DEVICE_RATE_LIMITS.perRoutePerMinute; // 120 (api/01-sync §2) — no literal here

describe('per-device sync rate limit (api/01-sync §2: 120/min across /v1/sync/*)', () => {
  test(`the ${CAP + 1}th request within a minute across MIXED push/pull → 429 RATE_LIMITED`, async () => {
    const dev = await h.seedDevice(85);
    // Positive control (T-14b): every request up to the cap is admitted — a 429 below the cap would
    // mean the fixture, not the limiter, produced the deny.
    for (let i = 0; i < CAP; i += 1) {
      const res =
        i % 2 === 0
          ? await h.push(dev.auth, dev.world.deviceId, [])
          : await h.pull(dev.auth, { cursor: 0, devicesDirectoryVersion: 0 });
      expect(res.status, `request ${i + 1} of ${CAP} must be admitted`).toBe(200);
    }

    const over = await h.pull(dev.auth, { cursor: 0, devicesDirectoryVersion: 0 });
    expect(over.status).toBe(429);
    const body = await readError(over);
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(typeof body.error.details.retryAfterSeconds).toBe('number');
    // api/00 §11: Retry-After is mandatory on every 429 and agrees with the detail.
    expect(over.headers.get('Retry-After')).toBe(String(body.error.details.retryAfterSeconds));
  });

  test('the bucket is PER DEVICE — a second device is unaffected by the first’s exhaustion', async () => {
    const a = await h.seedDevice(86);
    const b = await h.seedDevice(87);
    for (let i = 0; i < CAP; i += 1) {
      await h.pull(a.auth, { cursor: 0, devicesDirectoryVersion: 0 });
    }
    expect((await h.pull(a.auth, { cursor: 0, devicesDirectoryVersion: 0 })).status).toBe(429);
    // Device b has its own bucket: an exhausted neighbour must not deny it.
    expect((await h.pull(b.auth, { cursor: 0, devicesDirectoryVersion: 0 })).status).toBe(200);
  });
});
