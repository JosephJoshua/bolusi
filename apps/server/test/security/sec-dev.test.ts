// SEC-DEV server legs (security-guide §6.5). SEC-DEV-06 is a client SQLCipher concern (tasks
// 04/14) and is asserted there, not here.
//
// SEC-DEV-01/02/03 are complete on this surface, so their titles carry the id verbatim.
//
// SEC-DEV-04 / SEC-DEV-05 / SEC-DEV-07 each have a leg this file proves but do NOT complete here.
// SEC-META-01 counts an id as shipped when a title contains it verbatim (`title.includes(id)`) — it
// cannot read this comment — so embedding an id in a leg title below would retire the whole id while
// proving only that leg (task 31's stated residual; found by task 54's class sweep, closed by task
// 61). Per security-guide §2.1.6 a contributing surface names the id in a COMMENT, never a title.
// Where each id is actually COMPLETED:
//
//   SEC-DEV-04 → RETIRED (D18 §2, 2026-07-20): §218 was over-specified; the three real behaviours
//                (1/3/5) ship titled `SEC-DEV-04` in packages/core/test/sync/offline-revocation.test.ts,
//                and the id is off the allowlist. The revoked-device 401 test below is the server
//                wire fact those client behaviours rest on — a contributing leg, so its title carries
//                no id. (The former "allowlisted to task 62" note was doubly stale: SEC-DEV-04 is now
//                retired, and the task renumbered 62 → 70.)
//   SEC-DEV-05 → ai-docs/tasks/26-chaos-harness.md  §219 wants "sync bodies and logs contain no
//                private-key material (harness intercepts ALL outbound requests during enroll +
//                sync cycle)". Below is the enroll-payload leg only; interception is 26's surface.
//   SEC-DEV-07 → COMPLETED end-to-end in apps/server/test/security/sec-dev-07.test.ts (task 70): a
//                real forge (correct signature, stale chain → CHAIN_BROKEN) writes a real anomaly row
//                through the push pipeline, then GET /v1/devices surfaces the owner-visible count —
//                the §221 mitigation firing forge → row → count. The surfacing test below (seeded
//                rows only) is a contributing leg, so its title still carries no id.
//
// Do not "tidy" the ids back into these titles — that is the defect, not the fix. Same discipline
// as apps/server/test/integration/sync/sec-sync.test.ts:66.
import { ed25519 } from '@noble/curves/ed25519.js';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { sha256Hex } from '../../src/crypto/index.js';
import { EnrollReq } from '../../src/identity/schemas.js';
import { uuidv7 } from '../../src/uuidv7.js';
import {
  enroll,
  makeIdentityHarness,
  provision,
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

async function setup() {
  const p = await provision(h, {
    tenantName: 'T',
    storeNames: ['S'],
    ownerName: 'O',
    ownerLogin: `o-${Math.random()}`,
  });
  return {
    p,
    storeId: p.storeIds[0] as string,
    control: await seedControlSession(h, { tenantId: p.tenantId, userId: p.ownerUserId }),
  };
}

function enrollBody(storeId: string, overrides: Record<string, unknown> = {}) {
  return {
    deviceId: uuidv7(h.clock.now()),
    devicePublicKeyB64: Buffer.from(ed25519.keygen().publicKey).toString('base64'),
    storeId,
    deviceName: 'Tablet',
    platform: 'android',
    appVersion: '1.0.0',
    ...overrides,
  };
}

test('SEC-DEV-01 enrollment authorization: a non-holder → 403, no device row, no token; a holder → 201 + audit row', async () => {
  const { p, storeId, control } = await setup();

  // Non-holder: a staff user's control session lacks auth.device_enroll.
  const staff = await seedUser(h, {
    tenantId: p.tenantId,
    name: 'Staff',
    storeIds: [storeId],
    roleKeys: ['staff'],
  });
  const staffControl = await seedControlSession(h, { tenantId: p.tenantId, userId: staff });
  const before = (
    await h.idb.db.selectFrom('devices').select('id').where('kind', '=', 'member').execute()
  ).length;

  const denied = await enroll(h, staffControl, enrollBody(storeId), uuidv7(h.clock.now()));
  expect(denied.status).toBe(403);
  const after = (
    await h.idb.db.selectFrom('devices').select('id').where('kind', '=', 'member').execute()
  ).length;
  expect(after).toBe(before); // no device row, no token minted

  // Holder: the owner enrolls → 201 + an audit row.
  const ok = await enroll(h, control, enrollBody(storeId), uuidv7(h.clock.now()));
  expect(ok.status).toBe(201);
  const okBody = (await ok.json()) as { deviceId: string };
  const audit = await h.idb.db
    .selectFrom('identityAudit')
    .select('id')
    .where('action', '=', 'device.enrolled')
    .where('entityId', '=', okBody.deviceId)
    .executeTakeFirst();
  expect(audit).toBeDefined();
});

test('SEC-DEV-02 token hashed at rest: no plaintext token in devices/control_sessions; a stolen hash does not authenticate', async () => {
  const { storeId, control } = await setup();
  const res = await enroll(h, control, enrollBody(storeId), uuidv7(h.clock.now()));
  const { deviceToken } = (await res.json()) as { deviceToken: string };

  // Scan devices + control_sessions for the plaintext token value.
  const deviceHashes = await h.idb.db.selectFrom('devices').select('tokenHash').execute();
  const sessionHashes = await h.idb.db.selectFrom('controlSessions').select('tokenHash').execute();
  const allHashes = [...deviceHashes, ...sessionHashes].map((r) => r.tokenHash);
  expect(allHashes).not.toContain(deviceToken);
  expect(allHashes).not.toContain(control);
  // The stored value is exactly SHA-256(token) and auth works via that hash lookup.
  expect(allHashes).toContain(sha256Hex(deviceToken));
  const authed = await h.app.request('http://srv.test/v1/devices/me', {
    headers: { Authorization: `Bearer ${deviceToken}` },
  });
  expect(authed.status).toBe(200);

  // A stolen token_hash presented AS a bearer does not authenticate (verifyToken re-hashes it).
  const stolen = await h.app.request('http://srv.test/v1/devices/me', {
    headers: { Authorization: `Bearer ${sha256Hex(deviceToken)}` },
  });
  expect(stolen.status).toBe(401);
});

test('SEC-DEV-03 revocation latency semantics: revoke → next request → 401 DEVICE_REVOKED; signing_key_public retained + pre-revocation state readable', async () => {
  const { p, storeId, control } = await setup();
  const device = await seedDevice(h, { tenantId: p.tenantId, storeId, enrolledBy: p.ownerUserId });
  const pubkeyBefore = (
    await h.idb.db
      .selectFrom('devices')
      .select('signingKeyPublic')
      .where('id', '=', device.deviceId)
      .executeTakeFirstOrThrow()
  ).signingKeyPublic;

  await h.app.request(`http://srv.test/v1/devices/${device.deviceId}/revoke`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${control}` },
  });

  // Very next request with that token → 401 DEVICE_REVOKED.
  const next = await h.app.request('http://srv.test/v1/devices/me/bundle', {
    headers: { Authorization: `Bearer ${device.token}` },
  });
  expect(next.status).toBe(401);
  expect(((await next.json()) as { error: { code: string } }).error.code).toBe('DEVICE_REVOKED');

  // signing_key_public retained forever; pre-revocation directory state (enrolled-by, pubkey)
  // still readable via GET /v1/devices (owner control session).
  const list = await h.app.request('http://srv.test/v1/devices', {
    headers: { Authorization: `Bearer ${control}` },
  });
  const devices = (
    (await list.json()) as {
      devices: Array<{
        deviceId: string;
        signingKeyPublic: string;
        enrolledBy: string | null;
        status: string;
      }>;
    }
  ).devices;
  const row = devices.find((d) => d.deviceId === device.deviceId);
  expect(row?.status).toBe('revoked');
  expect(row?.signingKeyPublic).toBe(pubkeyBefore);
  expect(row?.enrolledBy).toBe(p.ownerUserId);
});

// Server leg of the id named in the header (§218). This is the wire fact the client's offline
// caveat rests on; it is not the whole id, so the title carries no id.
test('revoked-device 401: every identity endpoint returns DEVICE_REVOKED for the revoked token, incl. the /me confirm-then-wipe probe', async () => {
  const { p, storeId, control } = await setup();
  const device = await seedDevice(h, { tenantId: p.tenantId, storeId, enrolledBy: p.ownerUserId });
  await h.app.request(`http://srv.test/v1/devices/${device.deviceId}/revoke`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${control}` },
  });

  const hdr = { Authorization: `Bearer ${device.token}`, 'X-Acting-User': p.ownerUserId };
  for (const path of ['/v1/devices', '/v1/devices/me', '/v1/devices/me/bundle']) {
    const res = await h.app.request(`http://srv.test${path}`, { headers: hdr });
    expect(res.status, `${path} should DEVICE_REVOKED`).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('DEVICE_REVOKED');
  }
});

// Enroll-payload leg of the id named in the header (§219). The sync-bodies + logs half needs a
// harness that intercepts every outbound request (task 26), so the title carries no id.
test('private key never reaches the server on enroll: EnrollReq is .strict() and carries only the public key; audit rows contain no private-key bytes', async () => {
  const { storeId, control } = await setup();

  // .strict(): an enroll body carrying a private key (or any extra field) is rejected — the
  // schema cannot accept private-key material.
  const keypair = ed25519.keygen();
  const privB64 = Buffer.from(keypair.secretKey).toString('base64');
  const parsed = EnrollReq.safeParse({
    deviceId: uuidv7(h.clock.now()),
    devicePublicKeyB64: Buffer.from(keypair.publicKey).toString('base64'),
    storeId,
    deviceName: 'X',
    platform: 'android',
    appVersion: '1',
    devicePrivateKeyB64: privB64, // the forbidden field
  });
  expect(parsed.success).toBe(false);

  // A legitimate enroll: the captured audit rows for the run contain no private-key bytes.
  const res = await enroll(
    h,
    control,
    enrollBody(storeId, { devicePublicKeyB64: Buffer.from(keypair.publicKey).toString('base64') }),
    uuidv7(h.clock.now()),
  );
  expect(res.status).toBe(201);
  const audits = await h.idb.db.selectFrom('identityAudit').select(['before', 'after']).execute();
  const serialized = JSON.stringify(audits);
  expect(serialized).not.toContain(privB64);
});

// Surfacing leg of the id named in the header (§221): the GET's aggregation over SEEDED anomaly
// rows, with deterministic control of the counts. The end-to-end join — a REAL forge writing a real
// anomaly row that this same GET then surfaces — is what COMPLETES SEC-DEV-07, and it lives in
// sec-dev-07.test.ts (titled). This leg seeds its rows, so its title carries no id.
test('key-compromise containment: GET /v1/devices surfaces device_anomalies counts and last-anomaly-at per device', async () => {
  const { p, storeId, control } = await setup();
  const device = await seedDevice(h, { tenantId: p.tenantId, storeId, enrolledBy: p.ownerUserId });

  // Seed anomaly rows (the tamper surface the fraud model exposes to the owner).
  for (const [kind, at] of [
    ['BAD_SIGNATURE', 100],
    ['CHAIN_BROKEN', 300],
  ] as const) {
    await h.idb.db
      .insertInto('deviceAnomalies')
      .values({
        id: uuidv7(h.clock.now()),
        tenantId: p.tenantId,
        deviceId: device.deviceId,
        kind,
        at: BigInt(at),
        detail: null,
      })
      .execute();
  }

  const list = await h.app.request('http://srv.test/v1/devices', {
    headers: { Authorization: `Bearer ${control}` },
  });
  const devices = (
    (await list.json()) as {
      devices: Array<{ deviceId: string; anomalyCount: number; lastAnomalyAt: number | null }>;
    }
  ).devices;
  const row = devices.find((d) => d.deviceId === device.deviceId);
  expect(row?.anomalyCount).toBe(2);
  expect(row?.lastAnomalyAt).toBe(300);
});
