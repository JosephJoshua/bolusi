// The in-memory token-bucket store stays bounded: client addresses and device ids are its keys, so
// a bucket kept for every address ever seen would let a client that rotates addresses (an IPv6 /64
// holds 2^64) grow server memory without limit.
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';

import type { AppEnv } from '../env.js';
import { ApiError } from '../errors.js';
import { InMemoryRateLimitStore, ipRateKey, perDeviceRateLimit } from './rate-limit.js';

const T0 = 1_700_000_000_000;

describe('InMemoryRateLimitStore eviction', () => {
  test('buckets that have fully refilled are dropped at the next sweep', () => {
    const store = new InMemoryRateLimitStore();
    for (let i = 0; i < 1000; i += 1) store.consume(`ip:198.51.${i >> 8}.${i & 255}`, 10, T0);
    expect(store.size).toBe(1000);

    // An hour later every one of those buckets is full again and says nothing.
    store.consume('ip:203.0.113.7', 10, T0 + 3_600_000);
    expect(store.size).toBe(1);
  });

  test('a bucket still refilling survives the sweep and keeps limiting', () => {
    const store = new InMemoryRateLimitStore();
    store.consume('ip:a', 2, T0); // first call: sweep clock starts here
    const drainedAt = T0 + 30_000;
    for (let i = 0; i < 2; i += 1) expect(store.consume('dev:x', 2, drainedAt).allowed).toBe(true);
    expect(store.consume('dev:x', 2, drainedAt).allowed).toBe(false);

    // The next sweep runs 30 s after the drain: dev:x has refilled one token of two, so it stays.
    store.consume('ip:b', 2, T0 + 60_000);
    expect(store.size).toBe(2);
    expect(store.consume('dev:x', 2, T0 + 60_000).allowed).toBe(true);
    expect(store.consume('dev:x', 2, T0 + 60_000).allowed).toBe(false);
  });

  test('the number of live buckets never exceeds the ceiling; the least recently used goes first', () => {
    const store = new InMemoryRateLimitStore({ maxBuckets: 3 });
    store.consume('k1', 1, T0);
    store.consume('k2', 5, T0);
    store.consume('k3', 5, T0);
    store.consume('k1', 1, T0); // k1 is now the most recently used (and drained)
    expect(store.consume('k4', 5, T0).allowed).toBe(true);
    expect(store.size).toBe(3);
    // k2 was evicted, not the recently touched k1, which is still limited.
    expect(store.consume('k1', 1, T0).allowed).toBe(false);
  });

  test('a drained bucket is never evicted; with only those left a new key is refused', () => {
    const store = new InMemoryRateLimitStore({ maxBuckets: 2 });
    store.consume('ip:attacked', 1, T0); // drained
    store.consume('ip:a', 5, T0);
    // Least recently used is the drained one; the bucket with tokens left goes instead.
    expect(store.consume('ip:b', 5, T0).allowed).toBe(true);
    expect(store.consume('ip:attacked', 1, T0).allowed).toBe(false);

    const full = new InMemoryRateLimitStore({ maxBuckets: 1 });
    full.consume('ip:attacked', 1, T0);
    expect(full.consume('ip:other', 1, T0).allowed).toBe(false);
    expect(full.size).toBe(1);
    // Refilled, the drained bucket can go.
    expect(full.consume('ip:other', 1, T0 + 60_000).allowed).toBe(true);
  });
});

describe('ipRateKey', () => {
  test('IPv6 addresses in one /64 share a key; another /64 does not', () => {
    const a = ipRateKey('2001:db8:0:0:1::1');
    expect(a).toBe('2001:db8:0:0::/64');
    expect(ipRateKey('2001:0db8::abcd:ef01:2345:6789')).toBe(a);
    expect(ipRateKey('2001:DB8:0:0:ffff:ffff:ffff:ffff')).toBe(a);
    expect(ipRateKey('2001:db8:0:1::1')).not.toBe(a);
    expect(ipRateKey('::')).toBe('0:0:0:0::/64');
    expect(ipRateKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
  });

  test('IPv4 and IPv4-mapped IPv6 are keyed by the IPv4 address; anything else is unchanged', () => {
    expect(ipRateKey('198.51.100.7')).toBe('198.51.100.7');
    expect(ipRateKey('::ffff:198.51.100.7')).toBe('198.51.100.7');
    expect(ipRateKey('unknown')).toBe('unknown');
  });
});

describe('perDeviceRateLimit for a control session', () => {
  test('holds the owner’s password session to the route cap per user, before authorization', async () => {
    const store = new InMemoryRateLimitStore();
    const app = new Hono<AppEnv>();
    app.onError((err, c) => c.text(err instanceof ApiError ? err.code : 'error', 429));
    app.use('*', async (c, next) => {
      c.set('controlSession', { tenantId: 't-1', userId: c.req.header('x-user') ?? 'u-1' });
      await next();
    });
    app.use(
      '*',
      perDeviceRateLimit({
        store,
        limits: { perRoutePerMinute: 2, realtimePerMinute: 1, aggregatePerMinute: 10 },
        now: () => T0,
        isRealtime: () => false,
      }),
    );
    // The handler stands in for a call its authorization denies: it still costs a request.
    app.get('/v1/users', (c) => c.text('forbidden', 403));

    const call = (user = 'u-1') => app.request('/v1/users', { headers: { 'x-user': user } });
    expect((await call()).status).toBe(403);
    expect((await call()).status).toBe(403);
    const limited = await call();
    expect(limited.status).toBe(429);
    expect(await limited.text()).toBe('RATE_LIMITED');
    // Another owner has their own bucket.
    expect((await call('u-2')).status).toBe(403);
  });
});
