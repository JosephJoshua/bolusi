// SEC-TENANT-04's probe registry (security-guide §8.2): one row per registered endpoint declaring
// what an out-of-scope caller must see, and how to ask.
//
// The expectations are NOT a transcript of what the server does today — they are read off
// security-guide §2.2's rule table and api/00 §7's code registry, so a route that DRIFTS away from
// the table fails here. (It already caught one: see the `POST /v1/media/:id/init` row.)
//
// The registry is total in both directions — `unmappedEndpoints` fails on an endpoint with no row
// (unknown != skipped, §8.2: future endpoints must register probes) and `staleProbeKeys` fails on
// a row for an endpoint that no longer exists.
import type {
  EndpointKey,
  EndpointProbes,
  ExistenceException,
  ProbeContext,
  ProbeRegistry,
  ProbeRequest,
} from './route-walker.js';

const JSON_CT = { 'Content-Type': 'application/json' } as const;

/** A 16-byte salt / 32-byte hash the `PinVerifierSchema` refinements accept (no real material). */
const DUMMY_VERIFIER = {
  algorithm: 'argon2id',
  saltB64: Buffer.alloc(16, 1).toString('base64'),
  mKiB: 32768,
  t: 3,
  p: 1,
  hashB64: Buffer.alloc(32, 2).toString('base64'),
  asOf: { timestamp: 1, deviceId: '0e111111-1111-7111-8111-111111111111', seq: 1 },
} as const;

const NOT_FOUND = { status: 404, code: 'NOT_FOUND' } as const;
const PERMISSION_DENIED = { status: 403, code: 'PERMISSION_DENIED' } as const;
const ACTING_USER_INVALID = { status: 403, code: 'ACTING_USER_INVALID' } as const;
const MEDIA_NOT_FOUND = { status: 404, code: 'MEDIA_NOT_FOUND' } as const;
const AUTH_TOKEN_MISSING = { status: 401, code: 'AUTH_TOKEN_MISSING' } as const;

const RULE_CROSS_TENANT =
  'security-guide §2.2 row 1 — a cross-tenant id is never confirmed to exist';
const RULE_UNASSIGNED_STORE =
  'security-guide §2.2 row 2 — an unassigned store is a permission error, never an empty result';
const RULE_LIST_SCOPE =
  'security-guide §2.2 row 4 — an unauthorized list scope is 403, never a silently-filtered 200 []';
const RULE_MEDIA_EXCEPTION =
  'security-guide §2.2 documented exception + SEC-MEDIA-03 — every out-of-scope media id is one indistinguishable 404';
const RULE_UNAUTH = 'api/00 §3/§7 — no credentials reaches no handler';

/** Device bearer + the acting-user claim the control-plane routes need (api/02-auth §4.5). */
const actingHeaders = (ctx: ProbeContext, userId: string): Record<string, string> => ({
  Authorization: ctx.tenantAAuth,
  'X-Acting-User': userId,
  ...JSON_CT,
});

const deviceHeaders = (ctx: ProbeContext): Record<string, string> => ({
  Authorization: ctx.tenantAAuth,
  ...JSON_CT,
});

/** The `unauthenticated` leg is mechanical for every bearer-guarded route: same request, no token. */
function unauthLeg(
  method: string,
  path: (ctx: ProbeContext) => string,
): EndpointProbes['unauthenticatedRequest'] {
  return (ctx) => ({
    path: path(ctx),
    init: { method, headers: { ...JSON_CT }, ...(method === 'GET' ? {} : { body: '{}' }) },
  });
}

const UNAUTH_DENIED = {
  kind: 'denied',
  verdict: AUTH_TOKEN_MISSING,
  rule: RULE_UNAUTH,
} as const;

const mediaInitBody = (ctx: ProbeContext): string =>
  JSON.stringify({
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

/** The four media legs share one shape: swap the `:id`, expect the one indistinguishable 404. */
function mediaProbes(
  method: string,
  suffix: string,
  body?: (ctx: ProbeContext) => NonNullable<RequestInit['body']>,
): EndpointProbes {
  const build = (ctx: ProbeContext, id: string) => ({
    path: `/v1/media/${id}${suffix}`,
    init: {
      method,
      headers: body === undefined ? { Authorization: ctx.tenantAAuth } : deviceHeaders(ctx),
      ...(body === undefined ? {} : { body: body(ctx) }),
    },
    foreignId: id,
  });
  return {
    crossTenant: { kind: 'denied', verdict: MEDIA_NOT_FOUND, rule: RULE_MEDIA_EXCEPTION },
    crossTenantRequest: (ctx) => build(ctx, ctx.tenantBMediaId),
    unassignedStore: { kind: 'denied', verdict: MEDIA_NOT_FOUND, rule: RULE_MEDIA_EXCEPTION },
    unassignedStoreRequest: (ctx) => build(ctx, ctx.tenantAStore2MediaId),
    unauthenticated: UNAUTH_DENIED,
    unauthenticatedRequest: unauthLeg(method, (ctx) => `/v1/media/${ctx.tenantBMediaId}${suffix}`),
  };
}

export const PROBE_REGISTRY: ProbeRegistry = {
  // ── auth ──────────────────────────────────────────────────────────────────────────────────────
  'POST /v1/auth/login': {
    // The one cross-tenant lookup by design (D14). A tenant-B login identifier must be
    // indistinguishable from an unknown one — the handler runs the dummy KDF for exactly this.
    crossTenant: {
      kind: 'denied',
      verdict: { status: 401, code: 'AUTH_INVALID_CREDENTIALS' },
      rule: RULE_CROSS_TENANT,
    },
    crossTenantRequest: (ctx) => ({
      path: '/v1/auth/login',
      init: {
        method: 'POST',
        headers: { ...JSON_CT },
        body: JSON.stringify({
          loginIdentifier: ctx.tenantBLoginIdentifier,
          password: 'not-the-password',
        }),
      },
      foreignId: ctx.tenantBLoginIdentifier,
    }),
    unassignedStore: { kind: 'absent', reason: 'login carries no store scope (api/02-auth §4.2)' },
    unauthenticated: {
      kind: 'absent',
      reason:
        'the ONLY bearer-exempt route (api/00 §1/§3) — the cross-tenant leg above already issues it with no credentials',
    },
    unauthenticatedRequest: unauthLeg('POST', () => '/v1/auth/login'),
  },
  'POST /v1/auth/password': {
    crossTenant: { kind: 'denied', verdict: ACTING_USER_INVALID, rule: RULE_CROSS_TENANT },
    crossTenantRequest: (ctx) => ({
      path: '/v1/auth/password',
      init: {
        method: 'POST',
        headers: actingHeaders(ctx, ctx.tenantBUserId),
        body: JSON.stringify({ currentPassword: 'aaaaaaaaaaaa', newPassword: 'bbbbbbbbbbbb' }),
      },
      foreignId: ctx.tenantBUserId,
    }),
    unassignedStore: {
      kind: 'absent',
      reason: 'self-scoped: the password changed is the acting user’s own (api/02-auth §5.4)',
    },
    unauthenticated: UNAUTH_DENIED,
    unauthenticatedRequest: unauthLeg('POST', () => '/v1/auth/password'),
  },

  // ── devices ───────────────────────────────────────────────────────────────────────────────────
  'GET /v1/devices': {
    crossTenant: { kind: 'denied', verdict: ACTING_USER_INVALID, rule: RULE_CROSS_TENANT },
    crossTenantRequest: (ctx) => ({
      path: '/v1/devices',
      init: { method: 'GET', headers: actingHeaders(ctx, ctx.tenantBUserId) },
      foreignId: ctx.tenantBUserId,
    }),
    // The §2.2 row-4 leg: the acting user holds `auth.device_read` in no store, so the list scope
    // is unauthorized. A silently-filtered `200 []` here would be the FR-1036 leak.
    unassignedStore: { kind: 'denied', verdict: PERMISSION_DENIED, rule: RULE_LIST_SCOPE },
    unassignedStoreRequest: (ctx) => ({
      path: '/v1/devices',
      init: { method: 'GET', headers: actingHeaders(ctx, ctx.tenantAUserId) },
    }),
    unauthenticated: UNAUTH_DENIED,
    unauthenticatedRequest: unauthLeg('GET', () => '/v1/devices'),
  },
  'POST /v1/devices/enroll': {
    crossTenant: { kind: 'denied', verdict: PERMISSION_DENIED, rule: RULE_CROSS_TENANT },
    crossTenantRequest: (ctx) => ({
      path: '/v1/devices/enroll',
      init: {
        method: 'POST',
        headers: {
          Authorization: ctx.tenantAControlAuth,
          'Idempotency-Key': 'sec-tenant-04-cross-tenant',
          ...JSON_CT,
        },
        body: JSON.stringify({
          deviceId: ctx.nonexistentId,
          devicePublicKeyB64: Buffer.alloc(32, 9).toString('base64'),
          storeId: ctx.tenantBStoreId,
          deviceName: 'probe',
          platform: 'android',
          appVersion: '0.0.0',
        }),
      },
      foreignId: ctx.tenantBStoreId,
    }),
    unassignedStore: { kind: 'denied', verdict: PERMISSION_DENIED, rule: RULE_UNASSIGNED_STORE },
    unassignedStoreRequest: (ctx) => ({
      path: '/v1/devices/enroll',
      init: {
        method: 'POST',
        headers: {
          Authorization: ctx.tenantAControlAuth,
          'Idempotency-Key': 'sec-tenant-04-unassigned-store',
          ...JSON_CT,
        },
        body: JSON.stringify({
          deviceId: ctx.nonexistentId,
          devicePublicKeyB64: Buffer.alloc(32, 9).toString('base64'),
          storeId: ctx.tenantAStore2Id,
          deviceName: 'probe',
          platform: 'android',
          appVersion: '0.0.0',
        }),
      },
    }),
    unauthenticated: UNAUTH_DENIED,
    unauthenticatedRequest: unauthLeg('POST', () => '/v1/devices/enroll'),
  },
  'GET /v1/devices/me/bundle': {
    crossTenant: {
      kind: 'absent',
      reason:
        'addresses no client-supplied id: the bundle is the bearer device’s own store (api/02-auth §5.2)',
    },
    unassignedStore: {
      kind: 'absent',
      reason: 'same — the store is the bearer device’s, not a request parameter',
    },
    unauthenticated: UNAUTH_DENIED,
    unauthenticatedRequest: unauthLeg('GET', () => '/v1/devices/me/bundle'),
  },
  'GET /v1/devices/me': {
    crossTenant: {
      kind: 'absent',
      reason:
        'addresses no client-supplied id: reports the bearer device itself (api/02-auth §7.3)',
    },
    unassignedStore: { kind: 'absent', reason: 'same — no store parameter exists on this route' },
    unauthenticated: UNAUTH_DENIED,
    unauthenticatedRequest: unauthLeg('GET', () => '/v1/devices/me'),
  },
  'POST /v1/devices/:deviceId/revoke': {
    crossTenant: { kind: 'denied', verdict: NOT_FOUND, rule: RULE_CROSS_TENANT },
    crossTenantRequest: (ctx) => ({
      path: `/v1/devices/${ctx.tenantBDeviceId}/revoke`,
      init: { method: 'POST', headers: actingHeaders(ctx, ctx.tenantAUserId) },
      foreignId: ctx.tenantBDeviceId,
    }),
    unassignedStore: { kind: 'denied', verdict: PERMISSION_DENIED, rule: RULE_UNASSIGNED_STORE },
    unassignedStoreRequest: (ctx) => ({
      path: `/v1/devices/${ctx.tenantAStore2DeviceId}/revoke`,
      init: { method: 'POST', headers: actingHeaders(ctx, ctx.tenantAUserId) },
    }),
    unauthenticated: UNAUTH_DENIED,
    unauthenticatedRequest: unauthLeg('POST', (ctx) => `/v1/devices/${ctx.tenantBDeviceId}/revoke`),
  },

  // ── users ─────────────────────────────────────────────────────────────────────────────────────
  'POST /v1/users': {
    crossTenant: { kind: 'denied', verdict: PERMISSION_DENIED, rule: RULE_CROSS_TENANT },
    crossTenantRequest: (ctx) => ({
      path: '/v1/users',
      init: {
        method: 'POST',
        headers: actingHeaders(ctx, ctx.tenantAUserId),
        body: JSON.stringify({
          name: 'probe',
          loginIdentifier: null,
          password: null,
          storeIds: [ctx.tenantBStoreId],
          roleIds: [ctx.nonexistentId],
          pinVerifier: null,
        }),
      },
      foreignId: ctx.tenantBStoreId,
    }),
    unassignedStore: { kind: 'denied', verdict: PERMISSION_DENIED, rule: RULE_UNASSIGNED_STORE },
    unassignedStoreRequest: (ctx) => ({
      path: '/v1/users',
      init: {
        method: 'POST',
        headers: actingHeaders(ctx, ctx.tenantAUserId),
        body: JSON.stringify({
          name: 'probe',
          loginIdentifier: null,
          password: null,
          storeIds: [ctx.tenantAStore2Id],
          roleIds: [ctx.nonexistentId],
          pinVerifier: null,
        }),
      },
    }),
    unauthenticated: UNAUTH_DENIED,
    unauthenticatedRequest: unauthLeg('POST', () => '/v1/users'),
  },
  'PATCH /v1/users/:userId': {
    crossTenant: { kind: 'denied', verdict: NOT_FOUND, rule: RULE_CROSS_TENANT },
    crossTenantRequest: (ctx) => ({
      path: `/v1/users/${ctx.tenantBUserId}`,
      init: {
        method: 'PATCH',
        headers: actingHeaders(ctx, ctx.tenantAUserId),
        body: JSON.stringify({ name: 'probe' }),
      },
      foreignId: ctx.tenantBUserId,
    }),
    unassignedStore: { kind: 'denied', verdict: PERMISSION_DENIED, rule: RULE_UNASSIGNED_STORE },
    unassignedStoreRequest: (ctx) => ({
      path: `/v1/users/${ctx.tenantAStore2UserId}`,
      init: {
        method: 'PATCH',
        headers: actingHeaders(ctx, ctx.tenantAUserId),
        body: JSON.stringify({ name: 'probe' }),
      },
    }),
    unauthenticated: UNAUTH_DENIED,
    unauthenticatedRequest: unauthLeg('PATCH', (ctx) => `/v1/users/${ctx.tenantBUserId}`),
  },
  'POST /v1/users/:userId/deactivate': {
    crossTenant: { kind: 'denied', verdict: NOT_FOUND, rule: RULE_CROSS_TENANT },
    crossTenantRequest: (ctx) => ({
      path: `/v1/users/${ctx.tenantBUserId}/deactivate`,
      init: { method: 'POST', headers: actingHeaders(ctx, ctx.tenantAUserId) },
      foreignId: ctx.tenantBUserId,
    }),
    unassignedStore: { kind: 'denied', verdict: PERMISSION_DENIED, rule: RULE_UNASSIGNED_STORE },
    unassignedStoreRequest: (ctx) => ({
      path: `/v1/users/${ctx.tenantAStore2UserId}/deactivate`,
      init: { method: 'POST', headers: actingHeaders(ctx, ctx.tenantAUserId) },
    }),
    unauthenticated: UNAUTH_DENIED,
    unauthenticatedRequest: unauthLeg('POST', (ctx) => `/v1/users/${ctx.tenantBUserId}/deactivate`),
  },
  'POST /v1/users/:userId/reactivate': {
    crossTenant: { kind: 'denied', verdict: NOT_FOUND, rule: RULE_CROSS_TENANT },
    crossTenantRequest: (ctx) => ({
      path: `/v1/users/${ctx.tenantBUserId}/reactivate`,
      init: { method: 'POST', headers: actingHeaders(ctx, ctx.tenantAUserId) },
      foreignId: ctx.tenantBUserId,
    }),
    unassignedStore: { kind: 'denied', verdict: PERMISSION_DENIED, rule: RULE_UNASSIGNED_STORE },
    unassignedStoreRequest: (ctx) => ({
      path: `/v1/users/${ctx.tenantAStore2UserId}/reactivate`,
      init: { method: 'POST', headers: actingHeaders(ctx, ctx.tenantAUserId) },
    }),
    unauthenticated: UNAUTH_DENIED,
    unauthenticatedRequest: unauthLeg('POST', (ctx) => `/v1/users/${ctx.tenantBUserId}/reactivate`),
  },
  'POST /v1/users/:userId/pin-verifier': {
    crossTenant: { kind: 'denied', verdict: NOT_FOUND, rule: RULE_CROSS_TENANT },
    crossTenantRequest: (ctx) => ({
      path: `/v1/users/${ctx.tenantBUserId}/pin-verifier`,
      init: {
        method: 'POST',
        headers: actingHeaders(ctx, ctx.tenantAUserId),
        body: JSON.stringify({ verifierRef: ctx.nonexistentId, verifier: DUMMY_VERIFIER }),
      },
      foreignId: ctx.tenantBUserId,
    }),
    unassignedStore: { kind: 'denied', verdict: PERMISSION_DENIED, rule: RULE_UNASSIGNED_STORE },
    unassignedStoreRequest: (ctx) => ({
      path: `/v1/users/${ctx.tenantAStore2UserId}/pin-verifier`,
      init: {
        method: 'POST',
        headers: actingHeaders(ctx, ctx.tenantAUserId),
        body: JSON.stringify({ verifierRef: ctx.nonexistentId, verifier: DUMMY_VERIFIER }),
      },
    }),
    unauthenticated: UNAUTH_DENIED,
    unauthenticatedRequest: unauthLeg(
      'POST',
      (ctx) => `/v1/users/${ctx.tenantBUserId}/pin-verifier`,
    ),
  },

  // ── tenant ────────────────────────────────────────────────────────────────────────────────────
  'PATCH /v1/tenant/settings': {
    crossTenant: { kind: 'denied', verdict: ACTING_USER_INVALID, rule: RULE_CROSS_TENANT },
    crossTenantRequest: (ctx) => ({
      path: '/v1/tenant/settings',
      init: {
        method: 'PATCH',
        headers: actingHeaders(ctx, ctx.tenantBUserId),
        body: JSON.stringify({ idleLockSeconds: 300 }),
      },
      foreignId: ctx.tenantBUserId,
    }),
    unassignedStore: {
      kind: 'absent',
      reason:
        'tenant-scoped setting: the request carries no store id, and `auth.tenant_configure` is satisfied only by a tenant-wide grant (api/02-auth §6.4)',
    },
    unauthenticated: UNAUTH_DENIED,
    unauthenticatedRequest: unauthLeg('PATCH', () => '/v1/tenant/settings'),
  },

  // ── sync ──────────────────────────────────────────────────────────────────────────────────────
  'POST /v1/sync/push': {
    crossTenant: {
      kind: 'dedicated',
      assertion:
        'SEC-TENANT-04 sync push: an op claiming another tenant is rejected per-op inside the 200 envelope (05 §8/§9) and lands nowhere',
    },
    unassignedStore: {
      kind: 'dedicated',
      assertion: 'same leg — the op’s storeId is scope-validated by the same per-op step',
    },
    unauthenticated: UNAUTH_DENIED,
    unauthenticatedRequest: unauthLeg('POST', () => '/v1/sync/push'),
  },
  'POST /v1/sync/pull': {
    crossTenant: {
      kind: 'dedicated',
      assertion:
        'SEC-TENANT-04 sync pull: the drained page carries zero rows outside the bearer device’s tenant/store (api/01-sync §4.1)',
    },
    unassignedStore: { kind: 'dedicated', assertion: 'same leg — the page is store-scoped too' },
    unauthenticated: UNAUTH_DENIED,
    unauthenticatedRequest: unauthLeg('POST', () => '/v1/sync/pull'),
  },

  // ── media (the §2.2 documented exception 1) ───────────────────────────────────────────────────
  //
  // HISTORY: the cross-tenant leg of `POST /v1/media/:id/init` used to answer `500 INTERNAL` (a
  // `media.id` unique violation nothing caught) while the unassigned-store leg answered `404`, so
  // the status distinguished "exists in another tenant" from "does not exist". These rows state the
  // RULE, so they were red until commit `d12face` fixed the route; they are green now.
  //
  // OPEN, RULED, NOT YET FIXED (found by task 141a's sweep; not patched here — this is a no-wire
  // -change task): `init` creates a media row at a caller-supplied id, so it still answers `404` for
  // an id another tenant holds and `200` for a free one. D23 §2 ruled the id be tenant-scoped —
  // uniqueness `(tenant_id, id)` — so the oracle disappears rather than becoming a §2.2 exception.
  // Until that lands the difference is pinned in `KNOWN_EXISTENCE_CONTROL_DIFFERENCES`, whose header
  // says what to do when the fix trips it: DELETE the entry, never widen it.
  'POST /v1/media/:id/init': mediaProbes('POST', '/init', (ctx) => mediaInitBody(ctx)),
  'PUT /v1/media/:id/chunks/:index': mediaProbes(
    'PUT',
    '/chunks/0',
    () => new Uint8Array([1, 2, 3]),
  ),
  'GET /v1/media/:id/status': mediaProbes('GET', '/status'),
  'POST /v1/media/:id/complete': mediaProbes('POST', '/complete', () => '{}'),
  'GET /v1/media/:id': mediaProbes('GET', ''),

  // ── push (the §2.2 documented exception 2) ────────────────────────────────────────────────────
  //
  // The exception is on the TOKEN VALUE (held → 403 vs fresh → 200, D22 §2) — not on the device id
  // probed below, which answers a foreign device and a nonexistent one identically. Both halves are
  // asserted: this row by the cross-tenant walk + its nonexistent-id control, the token pair by
  // `DOCUMENTED_EXISTENCE_EXCEPTIONS` below.
  'POST /v1/push/tokens': {
    crossTenant: { kind: 'denied', verdict: PERMISSION_DENIED, rule: RULE_CROSS_TENANT },
    crossTenantRequest: (ctx) => ({
      path: '/v1/push/tokens',
      init: {
        method: 'POST',
        headers: deviceHeaders(ctx),
        body: JSON.stringify({
          deviceId: ctx.tenantBDeviceId,
          expoPushToken: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]',
        }),
      },
      foreignId: ctx.tenantBDeviceId,
    }),
    unassignedStore: {
      kind: 'absent',
      reason:
        'the token binds to the AUTHENTICATED device (api/04-push §2); the body carries no store id',
    },
    unauthenticated: UNAUTH_DENIED,
    unauthenticatedRequest: unauthLeg('POST', () => '/v1/push/tokens'),
  },

  // ── realtime ──────────────────────────────────────────────────────────────────────────────────
  'GET /v1/realtime': {
    crossTenant: {
      kind: 'absent',
      reason:
        'the socket is scoped to the bearer device; no client-supplied id addresses another tenant (poke fan-out scope is SEC-RT-04)',
    },
    unassignedStore: { kind: 'absent', reason: 'same — the scope is the bearer device’s' },
    unauthenticated: UNAUTH_DENIED,
    unauthenticatedRequest: unauthLeg('GET', () => '/v1/realtime'),
  },
  'GET /v1/realtime/sse': {
    crossTenant: {
      kind: 'absent',
      reason: 'the SSE stream is scoped to the bearer device (SEC-RT-01/04)',
    },
    unassignedStore: { kind: 'absent', reason: 'same — the scope is the bearer device’s' },
    unauthenticated: UNAUTH_DENIED,
    unauthenticatedRequest: unauthLeg('GET', () => '/v1/realtime/sse'),
  },
};

/**
 * security-guide §2.2's documented existence exceptions — the two endpoints allowed to answer in a
 * way that confirms existence, each with the legs that PROVE the documented behaviour.
 *
 * This is an allowlist of what is DOCUMENTED, not an exemption from any check: the nonexistent-id
 * control (`nonexistentControlOf`) runs over every endpoint with no exemptions, and both endpoints
 * below pass it — neither distinguishes on the id it is addressed by. What §2.2 excepts is narrower
 * and is exactly what the legs here assert.
 *
 * Membership is pinned to `ai-docs/security-guide.md` §2.2 in both directions (SEC-TENANT-04), so a
 * third exception cannot be added here to quiet a red probe — it takes an owner ruling and a spec
 * edit first (CLAUDE.md §6).
 */
export const DOCUMENTED_EXISTENCE_EXCEPTIONS: Readonly<Record<EndpointKey, ExistenceException>> = {
  // Exception 1 — a blind fetch by resource id must not become an existence oracle, so every
  // out-of-scope id (cross-tenant, unassigned store, another device's in-flight upload) is the SAME
  // `404` as an id that exists nowhere. This is SEC-MEDIA-03's `404` on every leg.
  'GET /v1/media/:id': {
    rationale:
      '§2.2 exception 1 — id-keyed resource probes: every out-of-scope or nonexistent media id is one indistinguishable 404 (api/03-media §2)',
    indistinguishable: true,
    legs: (ctx) =>
      (
        [
          ['cross-tenant', ctx.tenantBMediaId],
          ['unassigned-store', ctx.tenantAStore2MediaId],
          ['other-device in-flight', ctx.tenantAOtherDeviceMediaId],
          ['nonexistent', ctx.nonexistentId],
        ] as const
      ).map(([leg, id]) => ({
        leg,
        request: {
          path: `/v1/media/${id}`,
          init: { method: 'GET', headers: { Authorization: ctx.tenantAAuth } },
        },
        status: 404,
        code: 'MEDIA_NOT_FOUND',
      })),
  },
  // Exception 2 — an Expo token already held by ANOTHER tenant's device fails closed at 403 (RLS
  // hides the row, so ownership cannot transfer: task 118), while a token nobody holds registers at
  // 200. Allowed by D22 §2 and bounded by the 30/day per-device probe budget charged before the
  // collision path (`apps/server/src/routes/push.ts:43-50` vs `:100`) — NOT by the token's entropy,
  // which Expo does not publish and which §2.2 exception 2 refutes at length. The `rationale` below
  // is printed as the assertion message when this leg fails, i.e. exactly when someone is triaging
  // a live tenant-isolation regression: it must not hand them a premise the spec disowns.
  'POST /v1/push/tokens': {
    rationale:
      '§2.2 exception 2 — push-token registration: a token held by another tenant is 403, a fresh one 200 (D22 §2; justified by the 30/day probe budget, NOT by token entropy)',
    indistinguishable: false,
    legs: (ctx) => {
      const register = (expoPushToken: string): ProbeRequest => ({
        path: '/v1/push/tokens',
        init: {
          method: 'POST',
          headers: deviceHeaders(ctx),
          body: JSON.stringify({ deviceId: ctx.tenantADeviceId, expoPushToken }),
        },
      });
      return [
        {
          leg: 'held by another tenant',
          request: register(ctx.tenantBHeldPushToken),
          status: 403,
          code: 'PERMISSION_DENIED',
        },
        {
          leg: 'fresh',
          request: register('ExponentPushToken[sec-tenant-04-fresh-000]'),
          status: 200,
          code: null,
        },
      ];
    },
  },
};

/**
 * Every `ALL`-method entry Hono records for the composed app — the four global middlewares, the
 * login-only per-IP limiter, and the three `/v1/*` steps (api/00 §13). Asserted as an exact
 * multiset: a new middleware, or an `app.all()` endpoint smuggled past `enumerateEndpoints`'s
 * `ALL` filter, fails here until it is classified.
 */
export const EXPECTED_MIDDLEWARE_MOUNTS: readonly string[] = [
  '/*', // requestId (§13 step 1)
  '/*', // serverTime (§13 step 2)
  '/*', // accessLog (§13 step 3)
  '/*', // compress, realtime/media-excluded (§13 step 4)
  '/v1/*', // bearerAuth (§13 step 6)
  '/v1/*', // per-device rate limit (§13 step 7)
  '/v1/*', // wire cap + gzip decompression (§13 steps 8–9)
  '/v1/auth/login', // per-IP pre-auth limit (§13 step 5)
];
