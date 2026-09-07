// TASK 201-B (subtask d) — the in-process proof for the lane serve support behind
// `scripts/harness-serve-lane.mjs`. Two concerns, proven without a socket (the child-process proof that
// the real `.mjs` entry boots + binds loopback lives in `serve-lane-child.test.ts`):
//   • provisionLaneOwner — over a REAL `productionAuth` HarnessServer, the deterministic LANE_OTP it
//     provisions actually authenticates through the D14 login definer (200), a wrong password fails
//     closed (401), and the LANE_PIN it seeds travels in the enroll bundle and verifies (accept correct,
//     reject wrong) on the SAME argon2id. So the literals the marker hands the Maestro flows are exactly
//     the ones that enroll + unlock the app — not decorative.
//   • the ready marker — `parseLaneReady(formatLaneReady(x))` round-trips byte-for-byte, tolerates the
//     surrounding whitespace a `console.log` line carries, and rejects a non-marker line. This is the
//     format↔parse agreement the lane driver depends on to read the bound port + credentials.
import {
  bytesToBase64,
  createUuidV7Generator,
  verifyPinAgainst,
  type PinVerifier,
} from '@bolusi/core';
import { deriveDeviceKeypair, noblePort } from '@bolusi/test-support';
import { afterEach, describe, expect, test } from 'vitest';

import { HarnessServer } from '../src/server.js';
import {
  formatLaneReady,
  parseLaneReady,
  provisionLaneOwner,
  type LaneCredentials,
  type LaneReady,
} from '../src/serve-lane.js';

// In-process `app.request` routing — the origin is arbitrary (path-routed), never a bound socket.
const BASE = 'http://lane.test';

async function login(server: HarnessServer, login: string, password: string): Promise<Response> {
  return server.fetch(`${BASE}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ loginIdentifier: login, password }),
  });
}

async function enroll(
  server: HarnessServer,
  controlSession: string,
  storeId: string,
): Promise<Response> {
  const ids = createUuidV7Generator({
    now: () => server.clock.now(),
    randomBytes: (n) => noblePort.randomBytes(n),
  });
  return server.fetch(`${BASE}/v1/devices/enroll`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${controlSession}`,
      'Idempotency-Key': ids(),
    },
    body: JSON.stringify({
      deviceId: ids(),
      devicePublicKeyB64: bytesToBase64(deriveDeviceKeypair(3, 0).publicKey),
      storeId,
      deviceName: 'Tablet Kasir',
      platform: 'android',
      appVersion: '1.0.0',
    }),
  });
}

describe('task 201-B: provisionLaneOwner over a productionAuth server', () => {
  let server: HarnessServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  test('the lane credentials authenticate: LANE_OTP logs in, a wrong password is rejected', async () => {
    server = await HarnessServer.boot({ productionAuth: true });
    const creds = await provisionLaneOwner(server);

    // The marker's oneTimePassword resolves through findLoginCredential (definer) + real argon2id.
    const ok = await login(server, creds.ownerLogin, creds.oneTimePassword);
    expect(ok.status).toBe(200);
    expect(typeof ((await ok.json()) as { controlSession?: unknown }).controlSession).toBe(
      'string',
    );

    // The production login path fails closed on a bad password — the seam mints no bypass.
    const bad = await login(server, creds.ownerLogin, 'not-the-lane-password');
    expect(bad.status).toBe(401);
  });

  test('the seeded LANE_PIN travels in the enroll bundle and verifies (accept correct, reject wrong)', async () => {
    server = await HarnessServer.boot({ productionAuth: true });
    const creds = await provisionLaneOwner(server);

    const loginRes = await login(server, creds.ownerLogin, creds.oneTimePassword);
    const controlSession = ((await loginRes.json()) as { controlSession: string }).controlSession;
    const enrollRes = await enroll(server, controlSession, creds.storeId);
    expect(enrollRes.status).toBe(201);
    const { bundle } = (await enrollRes.json()) as {
      bundle: { users: { id: string; pinVerifier: PinVerifier | null }[] };
    };

    const owner = bundle.users.find((u) => u.id === creds.ownerUserId);
    expect(owner?.pinVerifier).not.toBeNull();

    // The carried verifier accepts the marker's PIN and rejects a wrong one, on the SAME argon2id — so a
    // device typing LANE_PIN really unlocks, and typing anything else does not.
    const carried = owner?.pinVerifier as PinVerifier;
    expect(await verifyPinAgainst(noblePort, carried, new TextEncoder().encode(creds.pin))).toBe(
      true,
    );
    expect(await verifyPinAgainst(noblePort, carried, new TextEncoder().encode('000000'))).toBe(
      false,
    );
  });
});

describe('task 201-B: the lane ready marker round-trips', () => {
  const sample: LaneReady = {
    url: 'http://127.0.0.1:3000',
    address: '127.0.0.1',
    port: 3000,
    credentials: {
      ownerLogin: 'gudang-selatan',
      oneTimePassword: 'harness-otp-password-201b',
      pin: '314159',
      tenantId: '0a111111-1111-7111-8111-111111111111',
      storeId: '0b222222-2222-7222-8222-222222222222',
      ownerUserId: '0c333333-3333-7333-8333-333333333333',
    } satisfies LaneCredentials,
  };

  test('parseLaneReady inverts formatLaneReady exactly', () => {
    expect(parseLaneReady(formatLaneReady(sample))).toEqual(sample);
  });

  test('parseLaneReady tolerates the surrounding whitespace a console.log line carries', () => {
    // The driver reads accumulated stdout; the marker line arrives with a trailing newline (and possibly
    // leading indentation). The trim in parseLaneReady must not defeat the match.
    expect(parseLaneReady(`  ${formatLaneReady(sample)}\n`)).toEqual(sample);
  });

  test('parseLaneReady rejects a non-marker line', () => {
    expect(parseLaneReady('some other server log line')).toBeUndefined();
    // The prefix requires the exact `: ` separator — the bare marker word is not a payload line.
    expect(parseLaneReady('BOLUSI_LANE_READY without a colon')).toBeUndefined();
  });
});
