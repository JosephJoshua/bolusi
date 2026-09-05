// The CHAOS-03 device→host net handoff, parsed from the launch intent's extras (task 198). PURE and
// Node-tested: given the props bag, it builds the `Chaos03Net` the on-device CHAOS-03 runner drives the
// REAL `@bolusi/server` round-trip with — a `fetch` seam + the per-device Authorization headers — WITHOUT
// apps/mobile importing `@bolusi/harness`/`@bolusi/server` (a token-minting server drags PGlite + a Node
// HTTP listener, un-bundleable on Hermes). The origin rewrite is the ONE shared `baseUrlFetch` the Node
// `socketBaseFetch` also delegates to (test-support/chaos, §2.8), so device and host swap the transports'
// fixed `http://harness.test/<path>` origin the SAME way.
//
// The two extras travel together: BOTH absent → the driver did not request a CHAOS-03 net this run, so
// this returns null and run.ts skips CHAOS-03 honestly (§2.11 — never a fabricated pass). A half- or
// malformed config also returns null (an honest skip that reds the lane) rather than throwing, since the
// driver mints both-or-neither: a null here can only mean "no valid net", which is exactly a skip.
import { baseUrlFetch, type Chaos03Net } from '@bolusi/test-support/chaos';

import { HARNESS_CHAOS_NET_BASE_URL_EXTRA, HARNESS_CHAOS_NET_BEARERS_EXTRA } from '../contract.js';
import type { HarnessLaunchProps } from '../contract.js';

/**
 * Parse the bearers extra — a JSON string array of raw `bdt_harness_*` tokens. Returns null on anything
 * that is not a non-empty array of non-empty strings, so a malformed handoff cannot silently build a net
 * with `undefined` / blank Authorization headers (which would read as a spurious auth failure, not the
 * honest "no net" skip). Total: never throws.
 */
function parseBearers(raw: string): readonly string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  if (!parsed.every((token) => typeof token === 'string' && token.length > 0)) return null;
  return parsed as readonly string[];
}

/**
 * Build the {@link Chaos03Net} from the launch props, or null when no valid CHAOS-03 net was handed off.
 *
 * `net.fetch` wraps {@link baseUrlFetch}(baseUrl): the runner's transports POST to the fixed
 * `http://harness.test/<path>` origin, which has no DNS over a real socket, so it is rewritten to the
 * emulator-reachable base URL. `net.auth[i]` is device i's full `Authorization` header — the raw bearer
 * from the handoff, re-prefixed with `Bearer ` (the transport sets the header VERBATIM), in device order.
 */
export function parseChaosNet(props: HarnessLaunchProps): Chaos03Net | null {
  const baseUrl = props[HARNESS_CHAOS_NET_BASE_URL_EXTRA];
  const bearersRaw = props[HARNESS_CHAOS_NET_BEARERS_EXTRA];

  // Neither extra present is the common case (any run the driver did not wire a CHAOS-03 net for): null →
  // honest skip. A half-config (one present, one not) also falls here — the driver mints both-or-neither,
  // so a half-config is a driver bug that surfaces as CHAOS-03 skipping (a lane red), never a fake pass.
  if (baseUrl === undefined || baseUrl === '') return null;
  if (bearersRaw === undefined || bearersRaw === '') return null;

  const bearers = parseBearers(bearersRaw);
  if (bearers === null) return null;

  return {
    fetch: baseUrlFetch(baseUrl),
    auth: bearers.map((token) => `Bearer ${token}`),
  };
}
