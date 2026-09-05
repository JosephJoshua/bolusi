// `baseUrlFetch` — the ONE origin rewrite shared by the Node `socketBaseFetch` (packages/harness) and
// the on-device CHAOS-03 net binding (apps/mobile), task 198 §2.8. This unit proves the rewrite itself:
// the transports POST to the fixed `http://harness.test/<path>?<query>` origin; over a real socket that
// origin has no DNS, so `baseUrlFetch` must swap it for the run's base URL while PRESERVING the path +
// query, and must not double the separator when the base carries a trailing slash. `fetchImpl` is
// injected so the assertion reads the URL the wrapper actually calls — no real network, no global stub.
// The end-to-end proof that this drives the production sync routes lives in
// packages/harness/src/net-server.test.ts (real loopback socket, 8 tests); this is the pure companion.
//
// ── FALSIFICATION (§2.11) ──────────────────────────────────────────────────────────────────────────
// Both guards were watched red before shipping:
//   • Drop the trailing-slash strip (`const base = baseUrl;`) → the trailing-slash case calls
//     `http://10.0.2.2:8991//v1/sync/push` (doubled separator) — the second test goes red. Restoring
//     `.replace(/\/+$/, '')` returns it to green.
//   • Rewrite via `requested.href` (or the origin) instead of `pathname + search` → either the
//     `harness.test` origin survives or the `?since=42` query is dropped — the first test's exact-URL
//     assertions go red. Restoring `${base}${pathname}${search}` returns them to green.
import { describe, expect, test } from 'vitest';

import { baseUrlFetch, type FetchLike } from './index.js';

/** A stand-in for the underlying fetch: it records the URL it was handed and returns a trivial 2xx. */
const ok: () => Promise<Response> = () => Promise.resolve(new Response('{}', { status: 200 }));

describe('baseUrlFetch — the shared harness.test → real-base origin rewrite (task 198 §2.8)', () => {
  test('swaps the fixed harness.test origin for the base URL, preserving path and query', async () => {
    const seen: string[] = [];
    const spy: FetchLike = (url) => {
      seen.push(url);
      return ok();
    };
    const wrapped = baseUrlFetch('http://127.0.0.1:8991', spy);

    await wrapped('http://harness.test/v1/sync/push', { method: 'POST' });
    await wrapped('http://harness.test/v1/sync/pull?since=42', { method: 'POST' });

    // Exact URLs: the origin is the injected base, the path is untouched, and the query survives.
    expect(seen).toEqual([
      'http://127.0.0.1:8991/v1/sync/push',
      'http://127.0.0.1:8991/v1/sync/pull?since=42',
    ]);
  });

  test('strips a trailing slash on the base so the path separator is never doubled', async () => {
    let seen = '';
    const spy: FetchLike = (url) => {
      seen = url;
      return ok();
    };
    // The emulator base (`10.0.2.2`) carrying a trailing slash — the shape an intent extra may deliver.
    const wrapped = baseUrlFetch('http://10.0.2.2:8991/', spy);

    await wrapped('http://harness.test/v1/sync/push', { method: 'POST' });

    expect(seen).toBe('http://10.0.2.2:8991/v1/sync/push');
  });
});
