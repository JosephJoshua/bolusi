// Per-device media rate limits (api/03-media §8): chunk PUT = 600/min/device (its own bucket),
// other media endpoints = the 120/min default. Follows the repo's rate-limit test pattern: the
// injected recording store witnesses the bucket key + capacity, and a denied key proves the 429 +
// Retry-After wiring — without sending hundreds of real requests.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { readError } from '../../helpers/http.js';
import {
  buildImage,
  chunkReq,
  detUuidV7,
  initReq,
  initBodyFor,
  makeMediaHarness,
  type MediaHarness,
} from '../../helpers/media.js';

let h: MediaHarness;
beforeAll(async () => {
  h = await makeMediaHarness();
});
afterAll(async () => {
  await h.close();
});

describe('chunk PUT rate limit = 600/min/device (api/03 §8)', () => {
  test('chunk PUT consults the media:chunk bucket at capacity 600', async () => {
    const ctx = await h.seedDevice('rl-chunk');
    const bytes = buildImage(1000, 'image/jpeg', 'rl-chunk');
    const id = detUuidV7('rl-chunk:media');
    await h.app.request(initReq(id, initBodyFor(ctx, bytes, 'image/jpeg'), ctx.auth));
    await h.app.request(chunkReq(id, 0, bytes, ctx.auth));

    const call = h.perDeviceStore.calls.find((c) => c.key === `media:chunk:${ctx.deviceId}`);
    expect(call).toBeDefined();
    expect(call?.capacityPerMinute).toBe(600);
  });

  test('chunk PUT beyond the limit → 429 RATE_LIMITED with Retry-After', async () => {
    const ctx = await h.seedDevice('rl-chunk-deny');
    const bytes = buildImage(1000, 'image/jpeg', 'rl-chunk-deny');
    const id = detUuidV7('rl-chunk-deny:media');
    await h.app.request(initReq(id, initBodyFor(ctx, bytes, 'image/jpeg'), ctx.auth));

    h.perDeviceStore.denyKeys.add(`media:chunk:${ctx.deviceId}`);
    const res = await h.app.request(chunkReq(id, 0, bytes, ctx.auth));
    expect(res.status).toBe(429);
    expect((await readError(res)).error.code).toBe('RATE_LIMITED');
    expect(res.headers.get('Retry-After')).toBe(String(h.perDeviceStore.denySeconds));
  });
});

describe('other media endpoints inherit the 120/min default (api/03 §8)', () => {
  test('init consults the media:route bucket at capacity 120', async () => {
    const ctx = await h.seedDevice('rl-init');
    const bytes = buildImage(300, 'image/jpeg', 'rl-init');
    await h.app.request(
      initReq(detUuidV7('rl-init:media'), initBodyFor(ctx, bytes, 'image/jpeg'), ctx.auth),
    );
    const call = h.perDeviceStore.calls.find((c) => c.key === `media:route:${ctx.deviceId}`);
    expect(call).toBeDefined();
    expect(call?.capacityPerMinute).toBe(120);
  });

  test('download beyond the route limit → 429 RATE_LIMITED', async () => {
    const ctx = await h.seedDevice('rl-dl-deny');
    h.perDeviceStore.denyKeys.add(`media:route:${ctx.deviceId}`);
    const res = await h.app.request(
      new Request(`http://media.test/v1/media/${detUuidV7('rl-dl:media')}`, {
        headers: { Authorization: ctx.auth },
      }),
    );
    expect(res.status).toBe(429);
    expect((await readError(res)).error.code).toBe('RATE_LIMITED');
  });
});
