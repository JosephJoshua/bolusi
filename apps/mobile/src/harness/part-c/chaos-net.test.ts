// Node-side proof of `parseChaosNet` — the CHAOS-03/06/07 device→host net handoff parser (task 198). Pure,
// no server, no device: it proves the wrapper's own responsibility, that the launch intent's ONE
// `bolusiHarnessChaosNets` extra becomes a per-scenario `{chaos03,chaos06,chaos07}` map whose nets have the
// correct Authorization headers and base-URL rewrite, and that any absent/malformed scenario is null (an
// honest skip, §2.11) — never a net with blank/undefined auth that would read as a spurious server auth
// failure. Each scenario is INDEPENDENT: one malformed entry nulls only its own slot. The real device→server
// round trips live where the server does (packages/harness/scenarios/device-runner-chaos-0{3,6,7}.test.ts).
//
// ── FALSIFICATION (§2.11) ──────────────────────────────────────────────────────────────────────────
// Each guard below was watched red before shipping — except the `typeof`-primitive half of the top-level
// guard, which is un-producible-red defense-in-depth (its own bullet flags this). This stays a record of
// reds, not hypotheses (§2.11 / T-16):
//   • Drop the `Bearer ` prefix in buildNet (`auth: validated.map((t) => t)`) → the happy-path auth
//     assertions go red (`['bdt_a',…]` ≠ `['Bearer bdt_a',…]`). Restoring the prefix returns them to green —
//     a raw token cannot reach the transport as a valid header.
//   • Delete `if (validated === null) return null;` in buildNet → the malformed-bearers scenario no longer
//     nulls; `null.map` throws and that case ERRORS instead of nulling only its slot. Restoring the guard
//     turns it back into the honest per-scenario null (skip).
//   • Delete the base-URL presence guard in buildNet → a baseUrl-less scenario builds `baseUrlFetch(undefined)`
//     instead of nulling; its null-slot case goes red (a net, not null). Restoring it fixes it.
//   • The top-level `typeof parsed !== 'object' || parsed === null` guard is two halves. Deleting the WHOLE
//     guard reds the `'null'` case: `JSON null` → `null.chaos03` throws — so the `=== null` half IS watched
//     red. Deleting ONLY the `typeof` half leaves the suite GREEN — the `'42'` primitive case still nulls every
//     slot via `buildNet(undefined)` → null — so that half is explicit defense-in-depth with no producible red,
//     kept so the fail-safe is a decision, not luck (a broken extra is EMPTY, never a lookup on a primitive).
import { afterEach, describe, expect, test, vi } from 'vitest';

import { HARNESS_CHAOS_NET_EXTRA } from '../contract.js';
import { parseChaosNet } from './chaos-net.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Valid per-scenario handoff entries — distinct base URLs + distinct bearer sets, so an assertion on one
 * scenario cannot pass on another's data by coincidence. */
const VALID_03 = { baseUrl: 'http://10.0.2.2:8991', bearers: ['bdt_a', 'bdt_b', 'bdt_c'] };
const VALID_06 = { baseUrl: 'http://10.0.2.2:8992', bearers: ['bdt_d', 'bdt_e'] };
const VALID_07 = { baseUrl: 'http://10.0.2.2:8993', bearers: ['bdt_f', 'bdt_g', 'bdt_h'] };

/** Wrap a nets map into the launch-props bag under the ONE wire key. */
function extra(map: unknown): Record<string, string> {
  return { [HARNESS_CHAOS_NET_EXTRA]: JSON.stringify(map) };
}

describe('parseChaosNet — the CHAOS-03/06/07 device net handoff (task 198)', () => {
  test('builds every scenario net: each raw bearer becomes a Bearer header in order, fetch targets the base URL', async () => {
    // Stub the global fetch BEFORE parseChaosNet runs: baseUrlFetch binds `fetch` via its default param at
    // call time (inside parseChaosNet), so the spy must already be installed or net.fetch would reach the
    // real network (a 10.0.2.2 connect timeout), never the spy.
    const seen: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      seen.push(url);
      return Promise.resolve(new Response('{}', { status: 200 }));
    });

    const nets = parseChaosNet(extra({ chaos03: VALID_03, chaos06: VALID_06, chaos07: VALID_07 }));

    // Device order preserved per scenario, each raw token re-prefixed for the verbatim Authorization header.
    expect(nets.chaos03?.auth).toEqual(['Bearer bdt_a', 'Bearer bdt_b', 'Bearer bdt_c']);
    expect(nets.chaos06?.auth).toEqual(['Bearer bdt_d', 'Bearer bdt_e']);
    expect(nets.chaos07?.auth).toEqual(['Bearer bdt_f', 'Bearer bdt_g', 'Bearer bdt_h']);

    // Each scenario's `net.fetch` wraps the global fetch via baseUrlFetch(baseUrl): the fixed harness.test
    // origin is rewritten to THAT scenario's handed-off base, proving parseChaosNet fed the right URL through
    // per scenario (07's base, not 03's).
    await nets.chaos07?.fetch('http://harness.test/v1/sync/pull?since=7', { method: 'POST' });
    expect(seen).toEqual(['http://10.0.2.2:8993/v1/sync/pull?since=7']);
  });

  test('a malformed scenario nulls only its own slot, never the others', () => {
    const nets = parseChaosNet(
      extra({
        chaos03: VALID_03,
        chaos06: { baseUrl: 'http://10.0.2.2:8992', bearers: 'nope' },
        chaos07: VALID_07,
      }),
    );
    expect(nets.chaos03).not.toBeNull();
    expect(nets.chaos06).toBeNull(); // bearers not an array → this slot only
    expect(nets.chaos07).not.toBeNull();
  });

  test.each([
    ['the extra is absent', {}],
    ['the extra is an empty string', { [HARNESS_CHAOS_NET_EXTRA]: '' }],
    ['the extra is not valid JSON', { [HARNESS_CHAOS_NET_EXTRA]: 'not json' }],
    ['the extra is a JSON primitive, not an object', { [HARNESS_CHAOS_NET_EXTRA]: '42' }],
    ['the extra is JSON null', { [HARNESS_CHAOS_NET_EXTRA]: 'null' }],
  ])('all slots null when %s — the all-skip fail-safe (§2.11)', (_label, props) => {
    const nets = parseChaosNet(props);
    expect(nets.chaos03).toBeNull();
    expect(nets.chaos06).toBeNull();
    expect(nets.chaos07).toBeNull();
  });

  test.each([
    ['the scenario entry is missing', {}],
    ['the scenario entry is not an object', { chaos03: 'nope' }],
    ['baseUrl is missing', { chaos03: { bearers: ['bdt_a'] } }],
    ['baseUrl is empty', { chaos03: { baseUrl: '', bearers: ['bdt_a'] } }],
    [
      'bearers is not an array',
      { chaos03: { baseUrl: 'http://10.0.2.2:8991', bearers: { '0': 'bdt_a' } } },
    ],
    ['bearers is an empty array', { chaos03: { baseUrl: 'http://10.0.2.2:8991', bearers: [] } }],
    [
      'bearers carries a non-string',
      { chaos03: { baseUrl: 'http://10.0.2.2:8991', bearers: ['bdt_a', 7] } },
    ],
    [
      'bearers carries an empty string',
      { chaos03: { baseUrl: 'http://10.0.2.2:8991', bearers: ['bdt_a', ''] } },
    ],
  ])(
    'the chaos03 slot is null when %s — an honest skip, never a blank-auth net (§2.11)',
    (_label, map) => {
      expect(parseChaosNet(extra(map)).chaos03).toBeNull();
    },
  );
});
