// FR-1045 SERVER arm (task 98): a server-side 403 PERMISSION_DENIED for an authenticated actor who
// lacks the required authority MUST leave an `identity_audit` denial row (action `permission.denied`)
// — the mirror of task 44's client arm, but a DIFFERENT sink (02-permissions §7: server directory
// denials audit to identity_audit, NOT the op-log `auth.permission_denied` fold). Real PG16 (L3).
//
// The whole captured denial set is asserted (T-14): the four §5.4 / permission-gate denial classes
// each produce EXACTLY one row with the right actor/permission/reason, and the deliberately-NOT
// audited classes (FR-1036 not-found masquerade) produce ZERO — so a future edit that silently
// starts (or stops) auditing a class fails here.
import { afterEach, beforeEach, expect, test } from 'vitest';

import { DENIAL_ACTION } from '../../src/identity/denial-audit.js';
import { uuidv7 } from '../../src/uuidv7.js';
import {
  makeIdentityHarness,
  provision,
  roleIdOf,
  seedControlSession,
  seedDevice,
  seedUser,
  type IdentityHarness,
} from '../helpers/identity-app.js';

let h: IdentityHarness;
beforeEach(async () => {
  h = await makeIdentityHarness();
});
afterEach(async () => {
  await h.close();
});

const NIL_DEVICE = '00000000-0000-0000-0000-000000000000';

interface DenialRow {
  actorUserId: string | null;
  permissionId: unknown;
  reason: unknown;
  target: unknown;
}

async function denialRows(tenantId: string): Promise<DenialRow[]> {
  const rows = await h.idb.db
    .selectFrom('identityAudit')
    .selectAll()
    .where('tenantId', '=', tenantId)
    .where('action', '=', DENIAL_ACTION)
    .execute();
  return rows.map((r) => {
    const after = (r.after ?? {}) as Record<string, unknown>;
    return {
      actorUserId: r.actorUserId,
      permissionId: after['permissionId'],
      reason: after['reason'],
      target: after['target'],
    };
  });
}

test('every server permission/restriction denial lands one identity_audit `permission.denied` row (FR-1045)', async () => {
  const p = await provision(h, {
    tenantName: 'T',
    storeNames: ['Store One'],
    ownerName: 'Owner',
    ownerLogin: `owner-${Date.now()}-${Math.random()}`,
  });
  const tenantId = p.tenantId;
  const s1 = p.storeIds[0] as string;
  const ownerId = p.ownerUserId;

  // Actors: a staff (holds none of the gated perms) and a store_owner (holds everything except
  // role_manage / tenant_configure, and is store-scoped so NOT a tenant admin).
  const staff = await seedUser(h, { tenantId, name: 'Staff', storeIds: [s1], roleKeys: ['staff'] });
  const storeOwner = await seedUser(h, {
    tenantId,
    name: 'StoreOwner',
    storeIds: [s1],
    roleKeys: ['store_owner'],
  });
  const mainOwnerRole = await roleIdOf(h, tenantId, 'main_owner');

  // --- Class 1: evaluator gate (requirePermission) — staff PATCH tenant settings → not_granted.
  const r1 = await h.app.request('http://srv.test/v1/tenant/settings', {
    method: 'PATCH',
    headers: bearer(await seedControlSession(h, { tenantId, userId: staff })),
    body: JSON.stringify({ idleLockSeconds: 120 }),
  });
  expect(r1.status).toBe(403);

  // --- Class 2: no-readable-stores list gate — staff GET /v1/devices → not_granted.
  const r2 = await h.app.request('http://srv.test/v1/devices', {
    method: 'GET',
    headers: bearer(await seedControlSession(h, { tenantId, userId: staff })),
  });
  expect(r2.status).toBe(403);

  // --- Class 3: tenant-grant restriction — store_owner creating a tenant-wide (main_owner) role.
  const r3 = await h.app.request('http://srv.test/v1/users', {
    method: 'POST',
    headers: bearer(await seedControlSession(h, { tenantId, userId: storeOwner })),
    body: JSON.stringify({
      name: 'New',
      loginIdentifier: null,
      password: null,
      storeIds: [s1],
      roleIds: [mainOwnerRole],
      pinVerifier: null,
    }),
  });
  expect(r3.status).toBe(403);

  // --- Class 4: privileged-target restriction — store_owner resetting the main_owner's PIN.
  const device = await seedDevice(h, { tenantId, storeId: s1, enrolledBy: ownerId });
  const r4 = await h.app.request(`http://srv.test/v1/users/${ownerId}/pin-verifier`, {
    method: 'POST',
    headers: { ...bearer(device.token), 'X-Acting-User': storeOwner },
    body: JSON.stringify({
      verifierRef: uuidv7(h.clock.now()),
      verifier: {
        algorithm: 'argon2id',
        saltB64: Buffer.alloc(16, 1).toString('base64'),
        mKiB: 32768,
        t: 3,
        p: 1,
        hashB64: Buffer.alloc(32, 2).toString('base64'),
        asOf: { timestamp: 1000, deviceId: NIL_DEVICE, seq: 0 },
      },
    }),
  });
  expect(r4.status).toBe(403);

  // Assert the WHOLE captured set (T-14) — exactly these four tuples, nothing more, nothing less.
  const rows = await denialRows(tenantId);
  const seen = rows
    .map(
      (r) => `${r.actorUserId}|${String(r.permissionId)}|${String(r.reason)}|${String(r.target)}`,
    )
    .sort();
  expect(seen).toEqual(
    [
      `${staff}|auth.tenant_configure|not_granted|PATCH /v1/tenant/settings`,
      `${staff}|auth.device_read|not_granted|GET /v1/devices`,
      `${storeOwner}|auth.role_manage|restriction_violated|POST /v1/users`,
      `${storeOwner}|auth.user_reset_pin|restriction_violated|POST /v1/users/${ownerId}/pin-verifier`,
    ].sort(),
  );
});

test('a not-found masquerade (FR-1036, store not visible) is NOT audited as a denial', async () => {
  const p = await provision(h, {
    tenantName: 'T',
    storeNames: ['Store One'],
    ownerName: 'Owner',
    ownerLogin: `owner-${Date.now()}-${Math.random()}`,
  });
  const tenantId = p.tenantId;
  const control = await seedControlSession(h, { tenantId, userId: p.ownerUserId });

  // The owner holds every permission; the 403 here is the store-existence pre-check (users.ts §5.4.3),
  // i.e. FR-1036 existence-hiding — not "actor lacks a permission", so it carries no permission id and
  // is deliberately NOT written to the FR-1045 trail.
  const res = await h.app.request('http://srv.test/v1/users', {
    method: 'POST',
    headers: bearer(control),
    body: JSON.stringify({
      name: 'New',
      loginIdentifier: null,
      password: null,
      storeIds: [uuidv7(h.clock.now())], // non-existent store id
      roleIds: [await roleIdOf(h, tenantId, 'staff')],
      pinVerifier: null,
    }),
  });
  expect(res.status).toBe(403);
  expect(await denialRows(tenantId)).toHaveLength(0);
});

function bearer(token: string): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}
