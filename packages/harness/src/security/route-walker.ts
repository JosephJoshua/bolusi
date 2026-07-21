// SEC-TENANT-04's route table (security-guide §8.2): enumerate EVERY endpoint registered on the
// composed production Hono app, so a new endpoint is covered the moment it is mounted.
//
// WHY THIS READS `app.routes` AND NOT A HAND-WRITTEN LIST. A list of paths in a test is a list of
// the paths its author remembered; it goes stale silently, which is the exact failure class
// CLAUDE.md §2.11 exists to stop. Hono's own router table is the only thing that cannot disagree
// with what the server serves.
//
// TWO DENOMINATOR GUARDS, because this walk has a "silently checks nothing" failure mode (T-14):
//
//   1. `enumerateEndpoints` drops entries whose method is `ALL` — those are `app.use()` middleware
//      mounts, not endpoints. But Hono also records `app.all('/x', handler)` as `ALL`, so a real
//      endpoint COULD hide behind that filter. `middlewareMounts` therefore returns every dropped
//      entry, and the suite asserts that multiset EQUALS the declared expectation. Adding a
//      middleware, or registering an `.all()` endpoint, fails until someone classifies it.
//   2. `unmappedEndpoints` / `staleProbeKeys` make the probe registry total in BOTH directions: an
//      endpoint with no probe fails (unknown != skipped, §8.2), and a probe for an endpoint that no
//      longer exists fails (so the registry cannot accumulate dead rows that inflate its apparent
//      coverage).

/** The minimal shape of a Hono route-table entry (hono 4.12's `RouterRoute`). */
export interface HonoRouteEntry {
  readonly method: string;
  readonly path: string;
}

/** The minimal shape of a Hono app this module reads. */
export interface RouteTableSource {
  readonly routes: readonly HonoRouteEntry[];
}

/** `METHOD /path` — the registry key and the human-readable endpoint name. */
export type EndpointKey = string;

/**
 * Every concrete endpoint the app serves, deduped and sorted. Middleware mounts (`method: 'ALL'`)
 * are excluded here and surfaced by `middlewareMounts` so nothing is dropped unaccounted-for.
 */
export function enumerateEndpoints(app: RouteTableSource): EndpointKey[] {
  const keys = new Set<EndpointKey>();
  for (const route of app.routes) {
    if (route.method === 'ALL') continue;
    keys.add(`${route.method} ${route.path}`);
  }
  return [...keys].sort();
}

/**
 * Every `ALL`-method route-table entry, sorted, WITH duplicates preserved — one entry per
 * registration, so three middlewares mounted on `/v1/*` appear three times. The suite compares this
 * against a declared list: the count is what makes a newly-added middleware (or a smuggled
 * `app.all()` endpoint) fail rather than vanish into the filter above.
 */
export function middlewareMounts(app: RouteTableSource): string[] {
  return app.routes
    .filter((route) => route.method === 'ALL')
    .map((route) => route.path)
    .sort();
}

/** Endpoints the app serves that the probe registry does not cover. Non-empty ⇒ the sweep fails. */
export function unmappedEndpoints(
  endpoints: readonly EndpointKey[],
  registryKeys: readonly EndpointKey[],
): EndpointKey[] {
  const known = new Set(registryKeys);
  return endpoints.filter((endpoint) => !known.has(endpoint));
}

/** Registry rows for endpoints the app no longer serves. Non-empty ⇒ the sweep fails. */
export function staleProbeKeys(
  endpoints: readonly EndpointKey[],
  registryKeys: readonly EndpointKey[],
): EndpointKey[] {
  const served = new Set(endpoints);
  return registryKeys.filter((key) => !served.has(key));
}

// ── the expected §2.2 verdict of a probe ────────────────────────────────────────────────────────

/** One `api/00 §7` verdict: the exact status AND the exact registry code. */
export interface Verdict {
  readonly status: number;
  readonly code: string;
}

/**
 * What a probe leg expects.
 *
 * `denied` is the §2.2 rule table: a specific status+code, and NEVER a 2xx (an empty-200 is the
 * leak FR-1036 names). `absent` is the honest declaration that a leg does not apply to an endpoint
 * — it carries its reason, is counted, and the suite asserts the count so a leg cannot quietly
 * become "absent" to make a red probe go away.
 */
export type LegExpectation =
  | { readonly kind: 'denied'; readonly verdict: Verdict; readonly rule: string }
  /**
   * The leg IS asserted, but not through the status/code oracle — the endpoint's out-of-scope
   * answer is a 2xx by protocol design (sync push returns per-op rejections inside a 200; sync
   * pull returns a filtered page). `assertion` names the test in THIS suite that carries it, so
   * the claim is traceable rather than a promise.
   */
  | { readonly kind: 'dedicated'; readonly assertion: string }
  | { readonly kind: 'absent'; readonly reason: string };

/** A request the walker issues, relative to the app (`app.request(path, init)`). */
export interface ProbeRequest {
  readonly path: string;
  readonly init: RequestInit;
  /**
   * The foreign identifier this probe addressed. The walker asserts the response body never echoes
   * it (api/00 §7.1 no-input-echo) — a 404 that repeats the id back is still an existence oracle
   * for anything that can distinguish "echoed" from "not echoed".
   */
  readonly foreignId?: string;
}

/** The fixture values a probe builder may address. Supplied by `tenant-probe.ts`. */
export interface ProbeContext {
  /** Bearer header for tenant A's device in store 1 (`Bearer …`). */
  readonly tenantAAuth: string;
  /** Bearer header for tenant A's CONTROL SESSION (user in store 1). */
  readonly tenantAControlAuth: string;
  readonly tenantAUserId: string;
  readonly tenantADeviceId: string;
  /** The RFC-8032 private seed of tenant A's device — the sync-push leg signs a real op with it. */
  readonly tenantADeviceSeed: Uint8Array;
  readonly tenantAStore1Id: string;
  /** A store in tenant A the probing device is NOT assigned to. */
  readonly tenantAStore2Id: string;
  /** A user of tenant A who belongs ONLY to store 2 (the unassigned-store target). */
  readonly tenantAStore2UserId: string;
  /** A device of tenant A enrolled in store 2 (the unassigned-store target). */
  readonly tenantAStore2DeviceId: string;
  /** A complete media id in tenant A, store 2 (unassigned-store download leg). */
  readonly tenantAStore2MediaId: string;
  /** A `receiving` media id in tenant A owned by ANOTHER device (in-flight leg). */
  readonly tenantAOtherDeviceMediaId: string;

  readonly tenantBTenantId: string;
  readonly tenantBUserId: string;
  readonly tenantBDeviceId: string;
  readonly tenantBStoreId: string;
  readonly tenantBMediaId: string;
  readonly tenantBLoginIdentifier: string;

  /** A syntactically valid id that exists nowhere (the "nonexistent" media leg). */
  readonly nonexistentId: string;
}

export type ProbeBuilder = (ctx: ProbeContext) => ProbeRequest;

/** The three legs §8.2 requires of every endpoint. */
export interface EndpointProbes {
  /** tenant-A credentials addressing a tenant-B resource id (§2.2 row 1 → `404 NOT_FOUND`). */
  readonly crossTenant: LegExpectation;
  readonly crossTenantRequest?: ProbeBuilder;
  /** same tenant, a store the caller is not assigned to (§2.2 row 2 → `403 PERMISSION_DENIED`). */
  readonly unassignedStore: LegExpectation;
  readonly unassignedStoreRequest?: ProbeBuilder;
  /** no credentials at all (api/00 §3 → `401`). */
  readonly unauthenticated: LegExpectation;
  readonly unauthenticatedRequest: ProbeBuilder;
}

export type ProbeRegistry = Readonly<Record<EndpointKey, EndpointProbes>>;

/** How many legs of each kind the registry actually probes — the sweep's reported denominator. */
export interface LegCensus {
  readonly endpoints: number;
  readonly crossTenantProbes: number;
  readonly crossTenantDedicated: number;
  readonly crossTenantAbsent: number;
  readonly unassignedStoreProbes: number;
  readonly unassignedStoreDedicated: number;
  readonly unassignedStoreAbsent: number;
  readonly unauthenticatedProbes: number;
  readonly unauthenticatedAbsent: number;
}

export function censusOf(registry: ProbeRegistry): LegCensus {
  const rows = Object.values(registry);
  const count = (pick: (row: EndpointProbes) => LegExpectation, kind: LegExpectation['kind']) =>
    rows.filter((row) => pick(row).kind === kind).length;
  return {
    endpoints: rows.length,
    crossTenantProbes: count((r) => r.crossTenant, 'denied'),
    crossTenantDedicated: count((r) => r.crossTenant, 'dedicated'),
    crossTenantAbsent: count((r) => r.crossTenant, 'absent'),
    unassignedStoreProbes: count((r) => r.unassignedStore, 'denied'),
    unassignedStoreDedicated: count((r) => r.unassignedStore, 'dedicated'),
    unassignedStoreAbsent: count((r) => r.unassignedStore, 'absent'),
    unauthenticatedProbes: count((r) => r.unauthenticated, 'denied'),
    unauthenticatedAbsent: count((r) => r.unauthenticated, 'absent'),
  };
}

/**
 * A registry row whose expectation says `denied` but which supplies no request builder would be
 * counted as a probe and never run — a denominator that lies. Non-empty ⇒ the sweep fails.
 */
export function probesWithoutRequests(registry: ProbeRegistry): string[] {
  const broken: string[] = [];
  for (const [key, row] of Object.entries(registry)) {
    if (row.crossTenant.kind === 'denied' && row.crossTenantRequest === undefined) {
      broken.push(`${key} → crossTenant expects a verdict but has no request builder`);
    }
    if (row.unassignedStore.kind === 'denied' && row.unassignedStoreRequest === undefined) {
      broken.push(`${key} → unassignedStore expects a verdict but has no request builder`);
    }
  }
  return broken.sort();
}

// ── the response oracle ─────────────────────────────────────────────────────────────────────────

/** The parts of a probe response the §2.2 assertions read. */
export interface ProbeResponse {
  readonly status: number;
  readonly bodyText: string;
}

/** One §2.2 violation, named with enough context to act on without re-running the sweep. */
export interface ProbeViolation {
  readonly endpoint: EndpointKey;
  readonly leg: string;
  readonly detail: string;
}

function errorCodeOf(bodyText: string): string | null {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    const code = (parsed as { error?: { code?: unknown } } | null)?.error?.code;
    return typeof code === 'string' ? code : null;
  } catch {
    return null;
  }
}

/**
 * Judge one probe against §2.2. Returns every violation found (not the first) so one run names the
 * whole set.
 *
 * The 2xx check is separate from — and stricter than — the code check on purpose: security-guide
 * §2.2 makes "any 200, INCLUDING an empty 200" the failure, so a `200 []` must fail loudly as a
 * LEAK rather than quietly as "expected 404, got 200".
 */
export function judgeProbe(
  endpoint: EndpointKey,
  leg: string,
  expectation: Extract<LegExpectation, { kind: 'denied' }>,
  request: ProbeRequest,
  response: ProbeResponse,
): ProbeViolation[] {
  const violations: ProbeViolation[] = [];
  if (response.status >= 200 && response.status < 300) {
    violations.push({
      endpoint,
      leg,
      detail:
        `LEAK: ${response.status} on out-of-scope access — security-guide §2.2 requires a ` +
        `permission error, never a result (an empty 200 is a leak too). Body: ${response.bodyText.slice(0, 200)}`,
    });
    return violations;
  }
  if (response.status !== expectation.verdict.status) {
    violations.push({
      endpoint,
      leg,
      detail: `expected status ${expectation.verdict.status} (${expectation.rule}), got ${response.status}`,
    });
  }
  const code = errorCodeOf(response.bodyText);
  if (code !== expectation.verdict.code) {
    violations.push({
      endpoint,
      leg,
      detail: `expected error.code ${expectation.verdict.code}, got ${String(code)} (body: ${response.bodyText.slice(0, 200)})`,
    });
  }
  if (request.foreignId !== undefined && response.bodyText.includes(request.foreignId)) {
    violations.push({
      endpoint,
      leg,
      detail: `api/00 §7.1 no-input-echo: the response echoes the probed foreign id ${request.foreignId}`,
    });
  }
  return violations;
}

/**
 * The media exception (§2.2, SEC-MEDIA-03): every out-of-scope id must be INDISTINGUISHABLE. Given
 * the responses to the four legs, report any pair that differs in anything but `requestId`.
 */
export function indistinguishabilityViolations(
  endpoint: EndpointKey,
  legs: readonly { readonly leg: string; readonly response: ProbeResponse }[],
): ProbeViolation[] {
  const normalize = (body: string): string =>
    body.replace(/"requestId"\s*:\s*"[^"]*"/g, '"requestId":"<redacted>"');
  const violations: ProbeViolation[] = [];
  const [first, ...rest] = legs;
  if (first === undefined) {
    return [
      {
        endpoint,
        leg: 'indistinguishability',
        detail: 'zero legs compared — the media exception check ran over nothing (T-14)',
      },
    ];
  }
  for (const other of rest) {
    if (other.response.status !== first.response.status) {
      violations.push({
        endpoint,
        leg: `${first.leg} vs ${other.leg}`,
        detail: `status differs (${first.response.status} vs ${other.response.status}) — an existence oracle`,
      });
    }
    if (normalize(other.response.bodyText) !== normalize(first.response.bodyText)) {
      violations.push({
        endpoint,
        leg: `${first.leg} vs ${other.leg}`,
        detail:
          `body differs beyond requestId — an existence oracle. ` +
          `${normalize(first.response.bodyText).slice(0, 160)} vs ${normalize(other.response.bodyText).slice(0, 160)}`,
      });
    }
  }
  return violations;
}
