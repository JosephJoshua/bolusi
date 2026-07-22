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
  /**
   * An `ExponentPushToken[…]` ALREADY registered to tenant B's device — the "held" half of
   * security-guide §2.2's documented exception 2. Tenant A can only distinguish it from a fresh
   * token because it already possesses the value (the ~88-bit entropy argument).
   */
  readonly tenantBHeldPushToken: string;

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

// ── the §2.2 documented-exception allowlist ─────────────────────────────────────────────────────
//
// security-guide §2.2 allows exactly TWO endpoints to distinguish "exists but denied" from "does
// not exist". Everything else must answer a cross-tenant id and a nonexistent one identically.
//
// The allowlist is pinned to the DOC, not to a constant a test can quietly grow: the sweep parses
// §2.2 and requires the harness's exception set to equal it in BOTH directions. Widening the
// allowlist therefore takes a spec edit (an owner ruling, CLAUDE.md §6) and cannot be done by
// editing a test to make a red probe green.

/** One exception as the guide declares it: its ordinal and the endpoint it names. */
export interface DocumentedException {
  readonly index: number;
  readonly endpoint: EndpointKey;
}

/** One leg of a documented exception's own proof, with the verdict §2.2 records for it. */
export interface ExistenceExceptionLeg {
  readonly leg: string;
  readonly request: ProbeRequest;
  readonly status: number;
  /** The api/00 §7 error code, or `null` where §2.2 documents a `2xx`. */
  readonly code: string | null;
}

/**
 * What an allowlisted endpoint claims, made runnable. `indistinguishable: true` is exception 1's
 * shape (every out-of-scope media id is ONE `404`); `false` is exception 2's (the push-token pair
 * is documented to DIFFER). Either way the legs are issued and judged, so a documented exception
 * cannot describe behaviour the server no longer has — the prose is a live claim.
 */
export interface ExistenceException {
  readonly rationale: string;
  readonly indistinguishable: boolean;
  readonly legs: (ctx: ProbeContext) => readonly ExistenceExceptionLeg[];
}

/**
 * The exceptions security-guide §2.2 enumerates, in document order. The grammar is fixed:
 *
 * ```
 * **Documented exception 1 — id-keyed resource probes (`GET /v1/media/:id`).**
 * ```
 *
 * Only §2.2 is scanned, so an "exception" written up in another section cannot smuggle itself in.
 * An EMPTY result means the parse matched nothing — callers must fail loudly rather than read it as
 * "no exceptions declared" (testing-guide T-14).
 */
export function parseDocumentedExistenceExceptions(guideText: string): DocumentedException[] {
  const start = guideText.indexOf('### 2.2 ');
  if (start === -1) return [];
  const afterHeading = guideText.slice(start + 1);
  const nextHeading = afterHeading.search(/\n#{2,3} /);
  const section = nextHeading === -1 ? afterHeading : afterHeading.slice(0, nextHeading);
  const pattern = /\*\*Documented exception (\d+) [^*\n]*\(`([A-Z]+ \/[^`]+)`\)\.\*\*/g;
  const found: DocumentedException[] = [];
  for (const match of section.matchAll(pattern)) {
    found.push({ index: Number(match[1]), endpoint: match[2] as EndpointKey });
  }
  return found;
}

/**
 * Derive the NONEXISTENT-ID control for a cross-tenant probe: the same request with the foreign id
 * swapped for one that exists nowhere. If the two responses differ, the endpoint confirms existence
 * across the tenant boundary — §2.2 row 1's rationale, stated as a runnable check.
 *
 * Two things this must not do, both of which would make it pass vacuously (T-14):
 *
 *  * re-issue the SAME request. If the declared `foreignId` appears nowhere in the path, headers or
 *    body, the "control" is a duplicate of the probe and can never differ — that throws.
 *  * answer from the idempotency layer instead of the handler. A replayed `Idempotency-Key` with a
 *    changed body is a conflict, which is a difference that says nothing about existence, so the
 *    control gets its own key.
 */
export function nonexistentControlOf(
  endpoint: EndpointKey,
  request: ProbeRequest,
  nonexistentId: string,
): ProbeRequest {
  const foreignId = request.foreignId;
  if (foreignId === undefined || foreignId === '') {
    throw new Error(
      `${endpoint}: the cross-tenant probe declares no foreignId, so its nonexistent-id control cannot be derived`,
    );
  }
  const swap = (text: string): string => text.split(foreignId).join(nonexistentId);

  const rawHeaders: unknown = request.init.headers;
  if (rawHeaders !== undefined && (typeof rawHeaders !== 'object' || rawHeaders === null)) {
    throw new Error(`${endpoint}: probe headers must be a plain record for the control to swap`);
  }
  const headers: Record<string, string> = {};
  let headersChanged = false;
  for (const [name, value] of Object.entries((rawHeaders ?? {}) as Record<string, string>)) {
    if (name.toLowerCase() === 'idempotency-key') {
      headers[name] = `${value}-nonexistent-control`;
      continue;
    }
    headers[name] = swap(value);
    if (headers[name] !== value) headersChanged = true;
  }

  const path = swap(request.path);
  const body = request.init.body;
  const swappedBody = typeof body === 'string' ? swap(body) : body;
  if (path === request.path && !headersChanged && swappedBody === body) {
    throw new Error(
      `${endpoint}: the declared foreignId ${foreignId} appears nowhere in the probe request — ` +
        `the control would re-issue the SAME request and could never fail`,
    );
  }
  return {
    path,
    init: { ...request.init, headers, ...(swappedBody === undefined ? {} : { body: swappedBody }) },
    foreignId: nonexistentId,
  };
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
