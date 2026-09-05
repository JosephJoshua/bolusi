// The CHAOS-03/06/07 device→host net handoff, parsed from the launch intent's ONE `bolusiHarnessChaosNets`
// extra (task 198). PURE and Node-tested: given the props bag, it builds — per scenario — the net the
// matching on-device runner drives the REAL `@bolusi/server` round-trip with (a `fetch` seam + the
// per-device Authorization headers), WITHOUT apps/mobile importing `@bolusi/harness`/`@bolusi/server` (a
// token-minting server drags PGlite + a Node HTTP listener, un-bundleable on Hermes). The origin rewrite is
// the ONE shared `baseUrlFetch` the Node `socketBaseFetch` also delegates to (test-support/chaos, §2.8), so
// device and host swap the transports' fixed `http://harness.test/<path>` origin the SAME way.
//
// One extra carries a JSON map, one entry per scenario. A scenario absent from the map → the driver did not
// request that net this run, so its slot is null and run.ts skips that gate honestly (§2.11 — never a
// fabricated pass). A malformed scenario entry ALSO yields null for that slot (an honest skip that reds the
// lane) rather than throwing: a null can only mean "no valid net for this scenario", which is exactly a
// skip. Each scenario is independent — one malformed entry never poisons the others.
import {
  baseUrlFetch,
  type Chaos03Net,
  type Chaos06Net,
  type Chaos07Net,
} from '@bolusi/test-support/chaos';

import { HARNESS_CHAOS_NET_EXTRA } from '../contract.js';
import type { HarnessLaunchProps } from '../contract.js';

/** The three net-backed chaos scenarios' nets, each built or null (absent/malformed → honest skip). All
 * three Net types are structurally identical (`{ fetch, auth }`), so one builder serves all three; the
 * distinct aliases document which runner consumes which slot. */
export interface ChaosNets {
  readonly chaos03: Chaos03Net | null;
  readonly chaos06: Chaos06Net | null;
  readonly chaos07: Chaos07Net | null;
}

/** Every slot null — the fail-safe returned when the extra is absent or the top-level JSON is unusable.
 * Frozen so a caller can never mutate the shared empty. */
const EMPTY: ChaosNets = Object.freeze({ chaos03: null, chaos06: null, chaos07: null });

/**
 * Validate an already-parsed bearers value — expected to be a JSON array of raw `bdt_harness_*` tokens.
 * Returns null on anything that is not a non-empty array of non-empty strings, so a malformed handoff
 * cannot silently build a net with `undefined` / blank Authorization headers (which would read as a
 * spurious auth failure, not the honest "no net" skip). Total: never throws.
 */
function validateBearers(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every((token) => typeof token === 'string' && token.length > 0)) return null;
  return value as readonly string[];
}

/**
 * Build one scenario's net from its map entry, or null when the entry is missing/malformed.
 *
 * `net.fetch` wraps {@link baseUrlFetch}(baseUrl): the runner's transports POST to the fixed
 * `http://harness.test/<path>` origin, which has no DNS over a real socket, so it is rewritten to the
 * emulator-reachable base URL. `net.auth[i]` is device i's full `Authorization` header — the raw bearer
 * from the handoff, re-prefixed with `Bearer ` (the transport sets the header VERBATIM), in device order.
 */
function buildNet(entry: unknown): Chaos03Net | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const { baseUrl, bearers } = entry as { baseUrl?: unknown; bearers?: unknown };
  if (typeof baseUrl !== 'string' || baseUrl === '') return null;
  const validated = validateBearers(bearers);
  if (validated === null) return null;
  return {
    fetch: baseUrlFetch(baseUrl),
    auth: validated.map((token) => `Bearer ${token}`),
  };
}

/**
 * Build the {@link ChaosNets} from the launch props: read the ONE `bolusiHarnessChaosNets` extra, JSON-parse
 * it once, and build each scenario's net independently. The extra absent (the common case — most runs wire
 * no chaos net) or unparseable/non-object JSON returns the all-null {@link EMPTY}; otherwise each of
 * `chaos03`/`chaos06`/`chaos07` is built from its entry, with a missing or malformed entry falling to null
 * for that slot only. Total: never throws — a broken handoff is a skip, never a crash.
 */
export function parseChaosNet(props: HarnessLaunchProps): ChaosNets {
  const raw = props[HARNESS_CHAOS_NET_EXTRA];
  if (raw === undefined || raw === '') return EMPTY;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY;
  }
  if (typeof parsed !== 'object' || parsed === null) return EMPTY;

  const map = parsed as Record<string, unknown>;
  return {
    chaos03: buildNet(map.chaos03),
    chaos06: buildNet(map.chaos06),
    chaos07: buildNet(map.chaos07),
  };
}
