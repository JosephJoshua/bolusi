// SEC-TENANT-04 (security-guide §8.2) — the cross-tenant probe per endpoint, deferred here by
// tasks 05/12 and owned by task 28.
//
// The walk is driven off the REAL composed `@bolusi/server` route table (`route-walker.ts`), so a
// new endpoint is covered the moment it is mounted; an endpoint with no probe row FAILS (unknown
// != skipped). The oracle is security-guide §2.2's rule table plus api/00 §7's code registry —
// never a transcript of current behaviour — so a route that drifts off the table goes red here.
//
// FALSIFICATION (CLAUDE.md §2.11) — each of these was BROKEN, the named red was READ, and the
// break was reverted:
//   * deleted the `GET /v1/devices` registry row →
//     "an endpoint with no probe mapping FAILS the sweep: expected [ 'GET /v1/devices' ] to
//     deeply equal []" (`unmappedEndpoints`);
//   * added a `GET /v1/ghost` registry row for an endpoint the app does not serve →
//     "the registry holds rows for endpoints the app no longer serves: expected
//     [ 'GET /v1/ghost' ] to deeply equal []" (`staleProbeKeys`);
//   * removed `/v1/auth/login` from `EXPECTED_MIDDLEWARE_MOUNTS` → the multiset assertion went red
//     naming the extra mount, so a new middleware (or an `app.all()` endpoint hiding behind the
//     `ALL` filter) cannot land unclassified;
//   * pointed the `POST /v1/push/tokens` cross-tenant probe at the caller's OWN device id so the
//     server legitimately answered 200 → "LEAK: 200 on out-of-scope access …", proving the 2xx
//     branch fires as a LEAK rather than as a bland status mismatch.
// The oracle's other proof is the live one: it found the `POST /v1/media/:id/init` `500` that
// commit `d12face` then fixed (that row now answers the required `404` and this suite is green —
// the "KNOWN RED" note that used to stand here outlived the defect by a whole task).
//
// FALSIFICATION of the §2.2 documented-exception legs (task 141a, D22 §2) — same discipline:
//   * added a third entry to `DOCUMENTED_EXISTENCE_EXCEPTIONS` that §2.2 does not enumerate →
//     "the harness allowlist and security-guide §2.2 disagree about which endpoints may confirm
//     existence …: expected [ 'GET /v1/media/:id', …(1) ] to deeply equal [ …(2) ]";
//   * added a "Documented exception 3" paragraph to §2.2 with no probe → the same test red on its
//     denominator, "expected […] to have a length of 2 but got 3";
//   * flipped the push-token exception to `indistinguishable: true` (i.e. judged as if §2.2 did
//     NOT document it) → "status differs (403 vs 200) — an existence oracle" on
//     `POST /v1/push/tokens`. That is the load-bearing one: the sweep SEES the oracle, and is
//     green only because §2.2 documents it — the allowlist was widened, the check was not turned off;
//   * emptied `KNOWN_EXISTENCE_CONTROL_DIFFERENCES` → the control sweep red naming
//     `POST /v1/media/:id/init` (404 vs 200), so a pinned difference cannot go stale silently;
//   * pointed `PATCH /v1/users/:userId`'s cross-tenant probe at a same-tenant unassigned-store user
//     so the endpoint genuinely distinguished → the sweep red naming it (403 vs 404) alongside the
//     known one, proving a NEW distinguisher cannot join unnoticed;
//   * declared a `foreignId` that appears nowhere in its own request → "the control would re-issue
//     the SAME request and could never fail", so the control cannot pass vacuously (T-14);
//   * (review round 2) wrote a METHOD-LESS third exception into §2.2 — ``(`/v1/devices`)`` — which
//     the endpoint grammar cannot read. Before `countDocumentedExceptionHeadings` this was GREEN
//     with the spec and the harness disagreeing; now → "security-guide §2.2 starts an exception
//     paragraph the endpoint grammar could not read …: expected 3 to be 2";
//   * (review round 2) changed the pinned difference's BODY text as if `init` had begun echoing the
//     other tenant's data, leaving the endpoint set identical → "the cross-tenant/nonexistent
//     difference set changed … or the known one changed character". An endpoint-name-only pin was
//     green for that input, which is why the pin carries the full violation text.
import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'vitest';

import {
  censusOf,
  countDocumentedExceptionHeadings,
  enumerateEndpoints,
  indistinguishabilityViolations,
  judgeProbe,
  middlewareMounts,
  nonexistentControlOf,
  parseDocumentedExistenceExceptions,
  probesWithoutRequests,
  staleProbeKeys,
  unmappedEndpoints,
  type ProbeResponse,
  type ProbeViolation,
} from '../../src/security/route-walker.js';
import {
  DOCUMENTED_EXISTENCE_EXCEPTIONS,
  EXPECTED_MIDDLEWARE_MOUNTS,
  PROBE_REGISTRY,
} from '../../src/security/probe-registry.js';
import { openTenantProbeFixture } from '../../src/security/tenant-probe.js';

/** The spec this suite is the oracle for — read from the repo, never restated here. */
const SECURITY_GUIDE = readFileSync(
  new URL('../../../../ai-docs/security-guide.md', import.meta.url),
  'utf8',
);

/**
 * A distinct UUIDv7-shaped id per control leg, existing nowhere. v7 (version nibble `7`, variant
 * `8`) because the media `:id` validator is `zUuidV7` — a v4 would `422` before the handler and the
 * control would pass without reaching the code it audits.
 */
const controlId = (index: number): string =>
  `0f9000${index.toString(16).padStart(2, '0')}-9999-7999-8999-999999999999`;

/**
 * The one endpoint whose nonexistent-id control legitimately differs today, pinned so the sweep is
 * green for a STATED reason rather than blind.
 *
 * `POST /v1/media/:id/init` CREATES a media row at a caller-supplied id: a `404` for an id another
 * tenant already holds versus a `200` for a free one distinguishes taken from free, which is
 * inherent to create-by-supplied-id and cannot be removed without either a lying `200` or
 * server-generated media ids (a wire change). It is NOT a security-guide §2.2 documented exception
 * — found by task 141a's sweep, reported in `ai-docs/tasks/141-…`, and an owner call (CLAUDE.md §6)
 * exactly like the push-token oracle was.
 *
 * Pinned as the EXACT violation text, not merely the endpoint name: an endpoint set would stay
 * green if this difference changed CHARACTER — e.g. if the body began echoing the other tenant's
 * data — because the set would still be this one row. A second endpoint joining fails here, this
 * one leaving fails here, and so does this one leaking something new.
 */
const KNOWN_EXISTENCE_CONTROL_DIFFERENCES: readonly string[] = [
  'POST /v1/media/:id/init :: status differs (404 vs 200) — an existence oracle',
  'POST /v1/media/:id/init :: body differs beyond requestId — an existence oracle. ' +
    '{"error":{"code":"MEDIA_NOT_FOUND","message":"Media not found"}} vs ' +
    '{"chunkSize":262144,"totalChunks":1,"receivedChunks":[],"status":"receiving"}',
];

/** Read a probe response without consuming a long-lived stream (SSE never closes on a 200). */
async function readResponse(res: Response): Promise<ProbeResponse> {
  if (
    res.status >= 200 &&
    res.status < 300 &&
    res.headers.get('content-type')?.includes('event-stream')
  ) {
    return { status: res.status, bodyText: '<event-stream, not drained>' };
  }
  return { status: res.status, bodyText: await res.text() };
}

describe('SEC-TENANT-04 cross-tenant probe per endpoint', () => {
  test('SEC-TENANT-04 the route walk covers every registered endpoint and every middleware mount is accounted for', async () => {
    const fixture = await openTenantProbeFixture();
    try {
      const endpoints = enumerateEndpoints(fixture.app);

      // Denominator first (T-14): a walk over zero endpoints must not read as coverage.
      expect(endpoints.length).toBeGreaterThan(0);
      expect(endpoints).toEqual([...endpoints].sort());

      const registryKeys = Object.keys(PROBE_REGISTRY);
      expect(
        unmappedEndpoints(endpoints, registryKeys),
        'security-guide §8.2: an endpoint with no probe mapping FAILS the sweep — register probes for it',
      ).toEqual([]);
      expect(
        staleProbeKeys(endpoints, registryKeys),
        'the registry holds rows for endpoints the app no longer serves — dead rows inflate apparent coverage',
      ).toEqual([]);
      expect(
        probesWithoutRequests(PROBE_REGISTRY),
        'a row expecting a verdict with no request builder is a probe that never runs',
      ).toEqual([]);

      // `enumerateEndpoints` drops `ALL`-method entries as middleware. Assert exactly which ones,
      // so an `app.all()` endpoint cannot hide behind that filter.
      expect(middlewareMounts(fixture.app)).toEqual([...EXPECTED_MIDDLEWARE_MOUNTS].sort());

      const census = censusOf(PROBE_REGISTRY);
      expect(census.endpoints).toBe(endpoints.length);
      // The legs that actually issue a request. These floors are the reported denominator: if a
      // future edit turns probes into `absent` rows to quiet a red leg, the count drops and fails.
      expect(census.crossTenantProbes).toBeGreaterThanOrEqual(15);
      expect(census.unassignedStoreProbes).toBeGreaterThanOrEqual(12);
      expect(census.unauthenticatedProbes).toBe(endpoints.length - 1); // login is bearer-exempt
    } finally {
      await fixture.close();
    }
  });

  test('SEC-TENANT-04 every endpoint refuses an unauthenticated request with 401, never a handler response', async () => {
    const fixture = await openTenantProbeFixture();
    try {
      const violations: ProbeViolation[] = [];
      let probed = 0;
      for (const [endpoint, probes] of Object.entries(PROBE_REGISTRY)) {
        if (probes.unauthenticated.kind !== 'denied') continue;
        const request = probes.unauthenticatedRequest(fixture.ctx);
        const response = await readResponse(await fixture.request(request.path, request.init));
        violations.push(
          ...judgeProbe(endpoint, 'unauthenticated', probes.unauthenticated, request, response),
        );
        probed += 1;
      }
      expect(probed, 'the unauthenticated walk issued zero requests').toBeGreaterThan(0);
      expect(violations).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  test('SEC-TENANT-04 tenant-A credentials against tenant-B resource ids never yield a 2xx and always carry the §2.2 verdict', async () => {
    const fixture = await openTenantProbeFixture();
    try {
      const violations: ProbeViolation[] = [];
      let probed = 0;
      for (const [endpoint, probes] of Object.entries(PROBE_REGISTRY)) {
        if (probes.crossTenant.kind !== 'denied') continue;
        const build = probes.crossTenantRequest;
        if (build === undefined) throw new Error(`${endpoint}: expected a cross-tenant builder`);
        const request = build(fixture.ctx);
        const response = await readResponse(await fixture.request(request.path, request.init));
        violations.push(
          ...judgeProbe(endpoint, 'cross-tenant', probes.crossTenant, request, response),
        );
        probed += 1;
      }
      expect(probed).toBeGreaterThanOrEqual(15);
      expect(violations).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  test('SEC-TENANT-04 same-tenant unassigned-store scope is a permission error, never a silently-filtered result', async () => {
    const fixture = await openTenantProbeFixture();
    try {
      const violations: ProbeViolation[] = [];
      let probed = 0;
      for (const [endpoint, probes] of Object.entries(PROBE_REGISTRY)) {
        if (probes.unassignedStore.kind !== 'denied') continue;
        const build = probes.unassignedStoreRequest;
        if (build === undefined)
          throw new Error(`${endpoint}: expected an unassigned-store builder`);
        const request = build(fixture.ctx);
        const response = await readResponse(await fixture.request(request.path, request.init));
        violations.push(
          ...judgeProbe(endpoint, 'unassigned-store', probes.unassignedStore, request, response),
        );
        probed += 1;
      }
      expect(probed).toBeGreaterThanOrEqual(12);
      expect(violations).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  // ── the §2.2 documented-exception allowlist (task 141a, D22 §2) ───────────────────────────────
  //
  // §2.2 allows exactly TWO endpoints to confirm existence. The pair of tests below is what makes
  // that sentence load-bearing: the first pins the allowlist to the guide's own text in both
  // directions, the second issues each exception's legs so the prose describes behaviour the server
  // actually has. Neither exempts anything from the nonexistent-id control that follows.
  test('SEC-TENANT-04 the documented existence exceptions are exactly the two security-guide §2.2 enumerates', async () => {
    const documented = parseDocumentedExistenceExceptions(SECURITY_GUIDE);
    // Denominator first (T-14): a parse that matched nothing must not read as "no exceptions".
    expect(
      documented,
      'security-guide §2.2 enumerates no documented exception — either the section was rewritten or the parse grammar drifted',
    ).toHaveLength(2);
    // …and every paragraph §2.2 STARTS was parsed. The endpoint grammar fails in the dangerous
    // direction — a heading missing its HTTP method matches nothing and disappears — so count the
    // headings on the loosest marker and require the two numbers to agree.
    expect(
      countDocumentedExceptionHeadings(SECURITY_GUIDE),
      'security-guide §2.2 starts an exception paragraph the endpoint grammar could not read — a malformed heading must fail loudly, not vanish from the allowlist',
    ).toBe(documented.length);
    expect(documented.map((entry) => entry.index)).toEqual([1, 2]);
    expect(
      documented.map((entry) => entry.endpoint).sort(),
      'the harness allowlist and security-guide §2.2 disagree about which endpoints may confirm existence — a third exception takes an owner ruling (CLAUDE.md §6), not a test edit',
    ).toEqual(Object.keys(DOCUMENTED_EXISTENCE_EXCEPTIONS).sort());

    // …and each named endpoint is one the app actually serves, so a typo cannot except nothing
    // while looking like it excepts something.
    const fixture = await openTenantProbeFixture();
    try {
      const served = new Set(enumerateEndpoints(fixture.app));
      expect(documented.filter((entry) => !served.has(entry.endpoint))).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  test('SEC-TENANT-04 each documented existence exception answers exactly as security-guide §2.2 records it', async () => {
    const fixture = await openTenantProbeFixture();
    try {
      let probed = 0;
      for (const [endpoint, exception] of Object.entries(DOCUMENTED_EXISTENCE_EXCEPTIONS)) {
        const legs = exception.legs(fixture.ctx);
        expect(
          legs.length,
          `${endpoint}: an exception proved by fewer than two legs`,
        ).toBeGreaterThanOrEqual(2);
        const observed: { leg: string; response: ProbeResponse }[] = [];
        for (const leg of legs) {
          const response = await readResponse(
            await fixture.request(leg.request.path, leg.request.init),
          );
          expect(response.status, `${endpoint} — ${leg.leg}: ${exception.rationale}`).toBe(
            leg.status,
          );
          if (leg.code !== null) expect(response.bodyText).toContain(leg.code);
          observed.push({ leg: leg.leg, response });
          probed += 1;
        }
        if (exception.indistinguishable) {
          expect(indistinguishabilityViolations(endpoint, observed)).toEqual([]);
        } else {
          // The exception must be REAL. If these legs ever stop differing, §2.2 is documenting an
          // oracle that no longer exists — stale prose in a security spec, which is its own defect.
          const statuses = new Set(observed.map((entry) => entry.response.status));
          expect(
            [...statuses],
            `${endpoint}: security-guide §2.2 documents these legs as distinguishable, but they answered identically`,
          ).not.toHaveLength(1);
        }
      }
      expect(probed, 'the documented-exception walk issued zero requests').toBeGreaterThanOrEqual(
        6,
      );
    } finally {
      await fixture.close();
    }
  });

  test('SEC-TENANT-04 no endpoint answers a cross-tenant id differently from an id that exists nowhere', async () => {
    const fixture = await openTenantProbeFixture();
    try {
      const violations: ProbeViolation[] = [];
      let probed = 0;
      // No exemptions — not even the two §2.2 exceptions, which distinguish on something other
      // than the id they are addressed by and must pass this exactly like everything else.
      for (const [endpoint, probes] of Object.entries(PROBE_REGISTRY)) {
        if (probes.crossTenant.kind !== 'denied') continue;
        const build = probes.crossTenantRequest;
        if (build === undefined) throw new Error(`${endpoint}: expected a cross-tenant builder`);
        const foreign = build(fixture.ctx);
        // A FRESH nowhere-id per endpoint. One shared id would let a create-shaped endpoint's
        // control (media init) bring that id into existence and hand the next endpoint's control a
        // row that does exist — the sweep would then report its own side effect as an oracle.
        const control = nonexistentControlOf(endpoint, foreign, controlId(probed));
        const legs = [
          {
            leg: 'cross-tenant id',
            response: await readResponse(await fixture.request(foreign.path, foreign.init)),
          },
          {
            leg: 'nonexistent id',
            response: await readResponse(await fixture.request(control.path, control.init)),
          },
        ];
        violations.push(...indistinguishabilityViolations(endpoint, legs));
        probed += 1;
      }
      expect(probed, 'the existence-control walk issued zero pairs').toBeGreaterThanOrEqual(15);
      // Pinned as the exact violation TEXT, not filtered out and not reduced to endpoint names: a
      // newly-distinguishing endpoint fails here, fixing/ruling on the known one fails here, and so
      // does the known one starting to leak something different (D3) — the pin cannot go stale.
      expect(
        violations.map((violation) => `${violation.endpoint} :: ${violation.detail}`).sort(),
        'the cross-tenant/nonexistent difference set changed — either an endpoint outside the security-guide §2.2 documented exceptions now confirms cross-tenant existence, or the known one changed character',
      ).toEqual([...KNOWN_EXISTENCE_CONTROL_DIFFERENCES].sort());
    } finally {
      await fixture.close();
    }
  });

  test('SEC-TENANT-04 sync pull drains zero rows outside the bearer device tenant and store', async () => {
    const fixture = await openTenantProbeFixture();
    try {
      const ctx = fixture.ctx;
      const res = await fixture.request('/v1/sync/pull', {
        method: 'POST',
        headers: { Authorization: ctx.tenantAAuth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ cursor: 0, limit: 500, devicesDirectoryVersion: 0 }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ops: { tenantId?: string; storeId?: string | null }[];
        devices: { id: string; storeId: string | null }[];
      };
      // The sidecar directory is part of the pull page and is the easier thing to leak: it must
      // carry only THIS tenant's devices, and only ones in the bearer device's store (or none).
      expect(
        body.devices.length,
        'the pull page carried no directory — a vacuous scope check',
      ).toBeGreaterThan(0);
      expect(body.devices.map((d) => d.id).sort()).toEqual([ctx.tenantADeviceId]);
      for (const op of body.ops) {
        expect(op.tenantId).not.toBe(ctx.tenantBTenantId);
        expect(op.storeId === null || op.storeId === ctx.tenantAStore1Id).toBe(true);
      }
    } finally {
      await fixture.close();
    }
  });

  test('SEC-TENANT-04 a pushed op claiming another tenant is rejected per-op and never lands', async () => {
    const fixture = await openTenantProbeFixture();
    try {
      const ctx = fixture.ctx;
      const res = await fixture.request('/v1/sync/push', {
        method: 'POST',
        headers: { Authorization: ctx.tenantAAuth, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: ctx.tenantADeviceId,
          ops: [
            {
              id: '0a888888-8888-7888-8888-888888888888',
              tenantId: ctx.tenantBTenantId, // the claim under test
              storeId: ctx.tenantBStoreId,
              userId: ctx.tenantAUserId,
              deviceId: ctx.tenantADeviceId,
              seq: 1,
              type: 'auth.device_enrolled',
              entityType: 'device',
              entityId: ctx.tenantADeviceId,
              schemaVersion: 1,
              payload: {
                storeId: ctx.tenantBStoreId,
                deviceName: 'probe',
                devicePublicKeyB64: Buffer.alloc(32, 9).toString('base64'),
              },
              timestamp: 1_726_100_000_000,
              location: null,
              source: 'ui',
              agentInitiated: false,
              agentConversationId: null,
              previousHash: '0'.repeat(64),
              hash: '0'.repeat(64),
              signature: Buffer.alloc(64, 0).toString('base64'),
            },
          ],
        }),
      });
      // The per-op channel: a 200 envelope carrying a rejection is the documented shape (05 §8) —
      // what must never happen is `accepted`.
      expect(res.status).toBe(200);
      const body = (await res.json()) as { results: { status: string; code?: string }[] };
      expect(
        body.results,
        'the push produced no per-op result — a vacuous rejection check',
      ).toHaveLength(1);
      expect(body.results[0]?.status).not.toBe('accepted');
      // And nothing reached tenant B: its op counter is untouched at genesis.
      const pull = await fixture.request('/v1/sync/pull', {
        method: 'POST',
        headers: { Authorization: ctx.tenantAAuth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ cursor: 0, limit: 500, devicesDirectoryVersion: 0 }),
      });
      const pulled = (await pull.json()) as { ops: { tenantId?: string }[] };
      expect(pulled.ops.some((op) => op.tenantId === ctx.tenantBTenantId)).toBe(false);
    } finally {
      await fixture.close();
    }
  });
});
