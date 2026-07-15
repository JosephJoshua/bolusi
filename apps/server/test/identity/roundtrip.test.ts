// The headline acceptance (task 13): provision a tenant end-to-end, then login + enroll + bundle
// round-trip against the running app. Uses the REAL argon2id KDF so password interop is proven for
// real (the provisioning verifier is what login verifies).
import { ed25519 } from '@noble/curves/ed25519.js';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { uuidv7 } from '../../src/uuidv7.js';
import {
  enroll,
  login,
  makeIdentityHarness,
  provision,
  type IdentityHarness,
} from '../helpers/identity-app.js';

let h: IdentityHarness;

beforeEach(async () => {
  h = await makeIdentityHarness({ realKdf: true });
});
afterEach(async () => {
  await h.close();
});

test('provision → login → enroll → bundle round-trip succeeds', async () => {
  const provisioned = await provision(h, {
    tenantName: 'Bolusi Papua',
    storeNames: ['Toko Jayapura', 'Toko Sentani'],
    ownerName: 'Ocep',
    ownerLogin: 'ocep',
  });
  expect(provisioned.storeIds).toHaveLength(2);

  // Login with the one-time password → a bcs_ control session + the owner's store list.
  const loginRes = await login(h, 'ocep', provisioned.oneTimePassword);
  expect(loginRes.status).toBe(200);
  expect(typeof loginRes.body['controlSession']).toBe('string');
  expect((loginRes.body['controlSession'] as string).startsWith('bcs_')).toBe(true);
  expect(loginRes.body['tenantId']).toBe(provisioned.tenantId);
  expect((loginRes.body['stores'] as unknown[]).length).toBe(2);
  const controlSession = loginRes.body['controlSession'] as string;

  // Enroll a device in store 1 with the control session.
  const deviceId = uuidv7(h.clock.now());
  const publicKeyB64 = Buffer.from(ed25519.keygen().publicKey).toString('base64');
  const enrollRes = await enroll(
    h,
    controlSession,
    {
      deviceId,
      devicePublicKeyB64: publicKeyB64,
      storeId: provisioned.storeIds[0],
      deviceName: 'Cashier tablet',
      platform: 'android',
      appVersion: '1.0.0',
    },
    uuidv7(h.clock.now()),
  );
  expect(enrollRes.status).toBe(201);
  const enrollBody = (await enrollRes.json()) as {
    deviceToken: string;
    bundle: { users: unknown[]; tenant: { id: string } };
    bundleEtag: string;
  };
  expect(enrollBody.deviceToken.startsWith('bdt_')).toBe(true);
  // bdt_ + 43-char base64url (32 bytes) — §8 token format.
  expect(enrollBody.deviceToken.slice(4)).toHaveLength(43);
  expect(enrollBody.bundle.tenant.id).toBe(provisioned.tenantId);
  // The owner is usable on store 1 (their storeIds cover all stores); the system actor is not.
  expect(enrollBody.bundle.users.length).toBeGreaterThanOrEqual(1);

  // Fetch the bundle with the device token; the etag matches the enroll response.
  const bundleRes = await h.app.request('http://srv.test/v1/devices/me/bundle', {
    headers: { Authorization: `Bearer ${enrollBody.deviceToken}` },
  });
  expect(bundleRes.status).toBe(200);
  const bundleBody = (await bundleRes.json()) as { etag: string };
  expect(bundleBody.etag).toBe(enrollBody.bundleEtag);

  // Conditional GET with the etag → 304, empty body.
  const notModified = await h.app.request('http://srv.test/v1/devices/me/bundle', {
    headers: {
      Authorization: `Bearer ${enrollBody.deviceToken}`,
      'If-None-Match': bundleBody.etag,
    },
  });
  expect(notModified.status).toBe(304);
  expect(await notModified.text()).toBe('');
});
