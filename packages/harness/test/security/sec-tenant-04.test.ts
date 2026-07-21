// SEC-TENANT-04 (security-guide §8.2) — the cross-tenant probe per endpoint, deferred here by
// tasks 05/12 and owned by task 28.
//
// The walk is driven off the REAL composed `@bolusi/server` route table (`route-walker.ts`), so a
// new endpoint is covered the moment it is mounted; an endpoint with no probe row FAILS (unknown
// != skipped). The oracle is security-guide §2.2's rule table plus api/00 §7's code registry —
// never a transcript of current behaviour — so a route that drifts off the table goes red here.
//
// FALSIFICATION (CLAUDE.md §2.11), all watched during development:
//   * denominator — the suite asserts the endpoint count, the middleware-mount multiset, and the
//     per-leg census. Deleting a registry row made `unmappedEndpoints` name it; deleting a route
//     from the app made `staleProbeKeys` name it; declaring a verdict without a request builder
//     made `probesWithoutRequests` name it. A walk over zero routes cannot report green.
//   * the oracle — flipping one expectation to the status the server actually returns is what
//     found the `POST /v1/media/:id/init` leak below, and flipping a 404 expectation to 200 makes
//     `judgeProbe` report `LEAK:` rather than a bland status mismatch.
//
// KNOWN RED (a real defect, filed as its own task per CLAUDE.md §2.6/§2.7 — NOT patched here):
// `POST /v1/media/:id/init` answers `500 INTERNAL` for a cross-tenant media id and
// `404 MEDIA_NOT_FOUND` for a same-tenant unassigned-store one, so the status is a cross-tenant
// existence oracle. This suite states the rule and stays red until the endpoint obeys it.
import { describe, expect, test } from 'vitest';

import {
  censusOf,
  enumerateEndpoints,
  indistinguishabilityViolations,
  judgeProbe,
  middlewareMounts,
  probesWithoutRequests,
  staleProbeKeys,
  unmappedEndpoints,
  type ProbeResponse,
  type ProbeViolation,
} from '../../src/security/route-walker.js';
import { EXPECTED_MIDDLEWARE_MOUNTS, PROBE_REGISTRY } from '../../src/security/probe-registry.js';
import { openTenantProbeFixture } from '../../src/security/tenant-probe.js';

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

  test('SEC-TENANT-04 media download answers cross-tenant, unassigned-store, in-flight and nonexistent ids indistinguishably', async () => {
    const fixture = await openTenantProbeFixture();
    try {
      const ctx = fixture.ctx;
      const legs: { leg: string; response: ProbeResponse }[] = [];
      for (const [leg, id] of [
        ['cross-tenant', ctx.tenantBMediaId],
        ['unassigned-store', ctx.tenantAStore2MediaId],
        ['other-device in-flight', ctx.tenantAOtherDeviceMediaId],
        ['nonexistent', ctx.nonexistentId],
      ] as const) {
        const res = await fixture.request(`/v1/media/${id}`, {
          method: 'GET',
          headers: { Authorization: ctx.tenantAAuth },
        });
        const response = await readResponse(res);
        expect(response.status, `${leg} leg must be 404 (security-guide §2.2 exception)`).toBe(404);
        legs.push({ leg, response });
      }
      expect(legs).toHaveLength(4);
      expect(indistinguishabilityViolations('GET /v1/media/:id', legs)).toEqual([]);
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
