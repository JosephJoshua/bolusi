// Node-side proof of `parseChaosNet` — the CHAOS-03 device→host net handoff parser (task 198). Pure, no
// server, no device: it proves the wrapper's own responsibility, that the launch intent's extras become a
// `Chaos03Net` whose Authorization headers and base-URL rewrite are correct, and that any absent/malformed
// handoff is null (an honest skip, §2.11), never a net with blank/undefined auth that would read as a
// spurious server auth failure. The real device→server round trip lives where the server does
// (packages/harness/scenarios/device-runner-chaos-03.test.ts).
//
// ── FALSIFICATION (§2.11) ──────────────────────────────────────────────────────────────────────────
// Each guard was watched red before shipping:
//   • Drop the `Bearer ` prefix (`auth: bearers.map((t) => t)`) → the happy-path auth assertion goes red
//     (`['t0',…]` ≠ `['Bearer t0',…]`). Restoring the prefix returns it to green — a raw token cannot
//     reach the transport as a valid header.
//   • Delete `if (bearers === null) return null;` → the malformed-bearers case (`'not json'`) no longer
//     returns null; `null.map` throws and that case ERRORS. Restoring the guard turns it back into the
//     honest null (skip).
//   • Delete the base-URL presence guard → the bearers-only case builds `baseUrlFetch(undefined)` instead
//     of returning null; the "only bearers present" case goes red (a net, not null). Restoring it fixes it.
import { afterEach, describe, expect, test, vi } from 'vitest';

import { HARNESS_CHAOS_NET_BASE_URL_EXTRA, HARNESS_CHAOS_NET_BEARERS_EXTRA } from '../contract.js';
import { parseChaosNet } from './chaos-net.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseChaosNet — the CHAOS-03 device net handoff (task 198)', () => {
  test('builds a net: each raw bearer becomes a Bearer header in order, fetch targets the base URL', async () => {
    // Stub the global fetch BEFORE parseChaosNet runs: baseUrlFetch binds `fetch` via its default param at
    // call time (inside parseChaosNet), so the spy must already be installed or net.fetch would reach the
    // real network (a 10.0.2.2 connect timeout), never the spy.
    const seen: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      seen.push(url);
      return Promise.resolve(new Response('{}', { status: 200 }));
    });

    const props = {
      [HARNESS_CHAOS_NET_BASE_URL_EXTRA]: 'http://10.0.2.2:8991',
      [HARNESS_CHAOS_NET_BEARERS_EXTRA]: JSON.stringify(['bdt_a', 'bdt_b', 'bdt_c']),
    };

    const net = parseChaosNet(props);

    expect(net).not.toBeNull();
    // Device order preserved, each raw token re-prefixed for the verbatim Authorization header.
    expect(net?.auth).toEqual(['Bearer bdt_a', 'Bearer bdt_b', 'Bearer bdt_c']);

    // `net.fetch` wraps the global fetch via baseUrlFetch(baseUrl): the fixed harness.test origin is
    // rewritten to the handed-off base, proving parseChaosNet fed the right URL through.
    await net?.fetch('http://harness.test/v1/sync/pull?since=7', { method: 'POST' });
    expect(seen).toEqual(['http://10.0.2.2:8991/v1/sync/pull?since=7']);
  });

  test.each([
    ['neither extra present', {}],
    [
      'only the base URL present (half config)',
      { [HARNESS_CHAOS_NET_BASE_URL_EXTRA]: 'http://10.0.2.2:8991' },
    ],
    [
      'only bearers present (half config)',
      { [HARNESS_CHAOS_NET_BEARERS_EXTRA]: JSON.stringify(['bdt_a']) },
    ],
    [
      'bearers not valid JSON',
      {
        [HARNESS_CHAOS_NET_BASE_URL_EXTRA]: 'http://10.0.2.2:8991',
        [HARNESS_CHAOS_NET_BEARERS_EXTRA]: 'not json',
      },
    ],
    [
      'bearers a JSON object, not an array',
      {
        [HARNESS_CHAOS_NET_BASE_URL_EXTRA]: 'http://10.0.2.2:8991',
        [HARNESS_CHAOS_NET_BEARERS_EXTRA]: '{"0":"bdt_a"}',
      },
    ],
    [
      'bearers an empty array',
      {
        [HARNESS_CHAOS_NET_BASE_URL_EXTRA]: 'http://10.0.2.2:8991',
        [HARNESS_CHAOS_NET_BEARERS_EXTRA]: '[]',
      },
    ],
    [
      'bearers array carries a non-string entry',
      {
        [HARNESS_CHAOS_NET_BASE_URL_EXTRA]: 'http://10.0.2.2:8991',
        [HARNESS_CHAOS_NET_BEARERS_EXTRA]: '["bdt_a",7]',
      },
    ],
    [
      'bearers array carries an empty string',
      {
        [HARNESS_CHAOS_NET_BASE_URL_EXTRA]: 'http://10.0.2.2:8991',
        [HARNESS_CHAOS_NET_BEARERS_EXTRA]: '["bdt_a",""]',
      },
    ],
  ])('returns null when %s — an honest skip, never a blank-auth net (§2.11)', (_label, props) => {
    expect(parseChaosNet(props)).toBeNull();
  });
});
