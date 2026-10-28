// Cross-tenant response and resource-existence probes against the real server.
import { describe, expect, test } from 'vitest';

import {
  censusOf,
  enumerateEndpoints,
  indistinguishabilityViolations,
  judgeProbe,
  middlewareMounts,
  nonexistentControlOf,
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

/**
 * A distinct UUIDv7-shaped id per control leg, existing nowhere. v7 (version nibble `7`, variant
 * `8`) because the media `:id` validator is `zUuidV7` — a v4 would `422` before the handler and the
 * control would pass without reaching the code it audits.
 */
const controlId = (index: number): string =>
  `0f9000${index.toString(16).padStart(2, '0')}-9999-7999-8999-999999999999`;

/**
 * The known-difference allowlist for the nonexistent-id control sweep. **EMPTY, and empty is the
 * correct end state** (task 170 / D23 §2, migration 0011) — every endpoint's nonexistent-id control
 * is now byte-identical to its real out-of-scope response, so the sweep is green because NOTHING
 * differs, not because a difference is pinned.
 *
 * HISTORY (kept so the deletion is legible, not re-litigated): `POST /v1/media/:id/init` used to
 * answer `404` for an id another tenant held versus `200` for a free one — a cross-tenant existence
 * oracle over ids the caller was never shown, found by task 141a's sweep. It was pinned here as a
 * TEMPORARY, bidirectional entry (an endpoint-set pin would have stayed green if the difference
 * merely changed character, so the EXACT violation text was pinned). D23 §2 ruled it be REMOVED, not
 * documented: media id uniqueness became `(tenant_id, id)`, so a foreign id is a free id in the
 * caller's own namespace and both cases answer `200` identically. The ruling turned on the numbers —
 * this route's budget is `perRoutePerMinute: 120` (`apps/server/src/deps.ts:71`) ≈ 172,800/day
 * against UUIDv7's 74 random bits, so §2.2 exception 2's 30/day-budget justification does not reach
 * here. The pin was designed to red the moment the fix landed; task 170 emptied it rather than
 * relaxing it, and init's non-oracle property (held == free) is now asserted directly by the
 * dedicated test `…media init at a foreign id is a local create indistinguishable from a fresh id`.
 *
 * (An earlier draft of this comment claimed the difference was "inherent to create-by-supplied-id
 * and cannot be removed without a lying 200 or server-generated ids." That was wrong — it missed
 * tenant-scoping. A comment is a hypothesis, CLAUDE.md §2.11.)
 *
 * DO NOT add an entry back for a NEW oracle. A real difference must be REMOVED or RULED (D23 §2),
 * never pinned silent — and §2.2 stays at exactly TWO documented exceptions regardless.
 */
const KNOWN_EXISTENCE_CONTROL_DIFFERENCES: readonly string[] = [];

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
      // Bearer-exempt: login, the phone handoff page and the customer status page, whose path key is the
      // credential.
      expect(
        Object.entries(PROBE_REGISTRY)
          .filter(([, row]) => row.unauthenticated.kind === 'absent')
          .map(([key]) => key)
          .sort(),
      ).toEqual([
        'GET /h/:key',
        'GET /h/:key/next',
        'GET /v1/public/status/:code',
        'POST /h/:key/send',
        'POST /v1/auth/login',
      ]);
      expect(census.unauthenticatedProbes).toBe(endpoints.length - 5);
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

  // Exercise each resource-specific response, then compare foreign and nonexistent IDs.
  test('SEC-TENANT-04 media lookups and push-token registration enforce their expected responses', async () => {
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

  // Carries the `crossTenant: dedicated` leg for `POST /v1/media/:id/init` (probe-registry.ts). Since
  // D23 §2 / migration 0011, media id uniqueness is (tenant_id, id): a foreign tenant's id is a FREE
  // id in the caller's own namespace, so init CREATES a row and answers 2xx — correct, not a leak.
  // The non-oracle property is HELD == FREE, asserted directly here (stronger than the pre-fix
  // fixed-404 expectation). Before 0011 the foreign id tripped the global unique index → 404 while a
  // free id → 200: that 404-vs-200 WAS the SEC-TENANT-04 oracle this discharges.
  test('SEC-TENANT-04 media init at a foreign id is a local create indistinguishable from a fresh id', async () => {
    const fixture = await openTenantProbeFixture();
    try {
      const ctx = fixture.ctx;
      const body = JSON.stringify({
        sizeBytes: 1024,
        sha256: '0'.repeat(64),
        mime: 'image/jpeg',
        type: 'image',
        metadata: {
          capturedAt: 1,
          userId: ctx.tenantAUserId,
          deviceId: ctx.tenantADeviceId,
          location: null,
        },
      });
      const headers = { Authorization: ctx.tenantAAuth, 'Content-Type': 'application/json' };
      // Same tenant-A caller + same body; only the id differs — a media id tenant B holds vs one that
      // exists nowhere. Both must be byte-identical, revealing nothing about tenant B's existence.
      const held = await readResponse(
        await fixture.request(`/v1/media/${ctx.tenantBMediaId}/init`, {
          method: 'POST',
          headers,
          body,
        }),
      );
      const free = await readResponse(
        await fixture.request(`/v1/media/${ctx.nonexistentId}/init`, {
          method: 'POST',
          headers,
          body,
        }),
      );
      expect(held.status, 'init at a foreign tenant id must not reveal existence via status').toBe(
        free.status,
      );
      expect(held.status, 'a tenant-scoped id is free in this tenant — init creates it, 200').toBe(
        200,
      );
      expect(held.bodyText, 'held and free init bodies must be identical').toEqual(free.bodyText);
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
