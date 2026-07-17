// Login (§4.2): uniform-latency 401 with no enumeration oracle, hash-at-rest sessions, and the §9
// rate limits (per-identifier failure lock + per-IP hour cap).
import { afterEach, beforeEach, expect, test } from 'vitest';

import { sha256Hex } from '../../src/crypto/index.js';
import {
  login,
  makeIdentityHarness,
  provision,
  seedUser,
  type IdentityHarness,
} from '../helpers/identity-app.js';

const PASSWORD = 'Owner1PasswordBase58xyz9';

let h: IdentityHarness;
beforeEach(async () => {
  h = await makeIdentityHarness();
});
afterEach(async () => {
  await h.close();
});

async function ownerTenant() {
  const p = await provision(h, {
    tenantName: 'T',
    storeNames: ['S'],
    ownerName: 'Owner',
    ownerLogin: 'ocep',
  });
  return p;
}

test('wrong password, unknown identifier, and a password-less user all return an identical 401 AUTH_INVALID_CREDENTIALS', async () => {
  const p = await ownerTenant();
  // A PIN-only user (no password verifier).
  await seedUser(h, {
    tenantId: p.tenantId,
    name: 'PinOnly',
    loginIdentifier: 'pinonly',
    storeIds: [p.storeIds[0] as string],
    roleKeys: ['staff'],
  });

  const wrong = await login(h, 'ocep', 'totally-wrong-password');
  const unknown = await login(h, 'nobody', 'totally-wrong-password');
  const passwordless = await login(h, 'pinonly', 'totally-wrong-password');

  for (const r of [wrong, unknown, passwordless]) {
    expect(r.status).toBe(401);
    expect((r.body as { error: { code: string } }).error.code).toBe('AUTH_INVALID_CREDENTIALS');
  }
  // Identical bodies — no field distinguishes the three cases.
  expect(JSON.stringify(wrong.body)).toBe(JSON.stringify(unknown.body));
  expect(JSON.stringify(unknown.body)).toBe(JSON.stringify(passwordless.body));
});

test('KDF-spy: the dummy argon2id verifier runs for an unknown identifier (no early return)', async () => {
  await ownerTenant();
  const before = h.dummyCalls();
  const res = await login(h, 'nobody-here', 'some-password-123');
  expect(res.status).toBe(401);
  // The dummy KDF ran even though the identifier does not exist.
  expect(h.dummyCalls()).toBe(before + 1);
});

test('a control session on a device-token-only route (/v1/devices/me/bundle) → 401', async () => {
  const p = await ownerTenant();
  const loginRes = await login(h, 'ocep', PASSWORD);
  const control = loginRes.body['controlSession'] as string;
  const res = await h.app.request('http://srv.test/v1/devices/me/bundle', {
    headers: { Authorization: `Bearer ${control}` },
  });
  expect(res.status).toBe(401);
  expect(p.tenantId).toBeDefined();
});

test('control_sessions stores the hash only — the plaintext token is never at rest', async () => {
  await ownerTenant();
  const loginRes = await login(h, 'ocep', PASSWORD);
  const control = loginRes.body['controlSession'] as string;
  const rows = await h.idb.db.selectFrom('controlSessions').select(['tokenHash']).execute();
  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) {
    expect(r.tokenHash).not.toBe(control);
  }
  // The stored hash is exactly SHA-256(token).
  expect(rows.some((r) => r.tokenHash === sha256Hex(control))).toBe(true);
});

test('a successful login returns the tenant display name for the enrollment confirm step (§4.2)', async () => {
  await ownerTenant();
  const res = await login(h, 'ocep', PASSWORD);
  expect(res.status).toBe(200);
  // The wizard's confirm step renders this (design-system §8.5) so the owner reads WHAT they are
  // binding to before the irreversible enroll POST. It is the tenant's real name, read from the
  // `tenants` row under `forTenant` — never fabricated client-side (T-19).
  expect(res.body['tenantName']).toBe('T');
  expect(res.body['tenantId']).toBeDefined();
});

test('§9 login limits: 6th failure for one identifier within 15 min → 429 (locked), unlocks after the window; 31st request/IP/hour → 429', async () => {
  await ownerTenant();

  // 5 wrong-password attempts are allowed; the 6th is locked.
  for (let i = 0; i < 5; i += 1) {
    const r = await login(h, 'ocep', 'wrong-password-attempt');
    expect(r.status).toBe(401);
  }
  const sixth = await login(h, 'ocep', 'wrong-password-attempt');
  expect(sixth.status).toBe(429);
  expect(
    (sixth.body as { error: { details?: { retryAfterSeconds?: number } } }).error.details
      ?.retryAfterSeconds,
  ).toBeGreaterThan(0);

  // Even the CORRECT password is refused while locked.
  const lockedButCorrect = await login(h, 'ocep', PASSWORD);
  expect(lockedButCorrect.status).toBe(429);

  // Past the 15-minute window → unlocked.
  h.clock.advance(15 * 60 * 1000 + 1000);
  const afterUnlock = await login(h, 'ocep', PASSWORD);
  expect(afterUnlock.status).toBe(200);

  // Per-IP hour cap: exhaust with successful logins (they do not touch the failure counter).
  const fresh = await makeIdentityHarness();
  try {
    await provision(fresh, {
      tenantName: 'T',
      storeNames: ['S'],
      ownerName: 'O',
      ownerLogin: 'ipowner',
    });
    for (let i = 0; i < 29; i += 1) {
      const r = await login(fresh, 'ipowner', 'Owner1PasswordBase58xyz9');
      expect(r.status).toBe(200);
    }
    // 30 successful so far (the 30th is #30); the 31st over the IP window → 429.
    const r30 = await login(fresh, 'ipowner', 'Owner1PasswordBase58xyz9');
    expect(r30.status).toBe(200);
    const r31 = await login(fresh, 'ipowner', 'Owner1PasswordBase58xyz9');
    expect(r31.status).toBe(429);
  } finally {
    await fresh.close();
  }
});
