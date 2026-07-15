// identity_audit: the redactor (unit) + the mutating-endpoint / provisioning conventions.
import { afterEach, beforeEach, expect, test } from 'vitest';

import { redactSecrets } from '../../src/identity/audit.js';
import {
  makeIdentityHarness,
  provision,
  roleIdOf,
  seedControlSession,
  type IdentityHarness,
} from '../helpers/identity-app.js';

test('redactSecrets collapses a verifier to its asOf only and drops password/token material', () => {
  const input = {
    name: 'Ada',
    password: 'super-secret-password',
    pinVerifier: {
      algorithm: 'argon2id',
      saltB64: 'AAAA',
      mKiB: 32768,
      t: 3,
      p: 1,
      hashB64: 'BBBB',
      asOf: { timestamp: 5, deviceId: '00000000-0000-0000-0000-000000000000', seq: 0 },
    },
    nested: { token: 'bdt_leak', keep: 'ok' },
  };
  const out = redactSecrets(input) as Record<string, unknown>;
  const serialized = JSON.stringify(out);
  expect(serialized).not.toContain('super-secret-password');
  expect(serialized).not.toContain('AAAA'); // salt
  expect(serialized).not.toContain('BBBB'); // hash
  expect(serialized).not.toContain('bdt_leak'); // token
  // The non-secret asOf position survives.
  expect((out['pinVerifier'] as { asOf: { timestamp: number } }).asOf.timestamp).toBe(5);
  expect((out['nested'] as { keep: string }).keep).toBe('ok');
  expect(out['name']).toBe('Ada');
});

let h: IdentityHarness;
beforeEach(async () => {
  h = await makeIdentityHarness();
});
afterEach(async () => {
  await h.close();
});

test('provisioning writes identity_audit rows with actor_user_id NULL and action cli:provision-tenant', async () => {
  const p = await provision(h, {
    tenantName: 'T',
    storeNames: ['S'],
    ownerName: 'O',
    ownerLogin: `o-${Math.random()}`,
  });
  const rows = await h.idb.db
    .selectFrom('identityAudit')
    .selectAll()
    .where('tenantId', '=', p.tenantId)
    .execute();
  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) {
    expect(r.actorUserId).toBeNull();
    expect(r.action).toBe('cli:provision-tenant');
  }
});

test('a mutating endpoint (user create) appends an audit row with the password + pinVerifier redacted', async () => {
  const p = await provision(h, {
    tenantName: 'T',
    storeNames: ['S'],
    ownerName: 'O',
    ownerLogin: `o-${Math.random()}`,
  });
  const storeId = p.storeIds[0] as string;
  const control = await seedControlSession(h, { tenantId: p.tenantId, userId: p.ownerUserId });
  const staffRole = await roleIdOf(h, p.tenantId, 'staff');

  const secretPassword = 'plaintext-password-should-never-be-audited';
  const res = await h.app.request('http://srv.test/v1/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${control}` },
    body: JSON.stringify({
      name: 'Employee',
      loginIdentifier: 'emp1',
      password: secretPassword,
      storeIds: [storeId],
      roleIds: [staffRole],
      pinVerifier: {
        algorithm: 'argon2id',
        saltB64: Buffer.alloc(16, 3).toString('base64'),
        mKiB: 32768,
        t: 3,
        p: 1,
        hashB64: Buffer.alloc(32, 4).toString('base64'),
        asOf: { timestamp: 1, deviceId: '00000000-0000-0000-0000-000000000000', seq: 0 },
      },
    }),
  });
  expect(res.status).toBe(201);
  const { userId } = (await res.json()) as { userId: string };

  const audit = await h.idb.db
    .selectFrom('identityAudit')
    .selectAll()
    .where('action', '=', 'user.created')
    .where('entityId', '=', userId)
    .executeTakeFirstOrThrow();
  const serialized = JSON.stringify(audit);
  expect(serialized).not.toContain(secretPassword);
  expect(serialized).not.toContain(Buffer.alloc(16, 3).toString('base64')); // pin salt
  expect(serialized).not.toContain(Buffer.alloc(32, 4).toString('base64')); // pin hash
  // The non-secret facts remain.
  expect((audit.after as { name: string }).name).toBe('Employee');
});
