// TASK 201-B — the boot-path proof (layer 2 over the createApp-level de-risk in
// `pglite-production-auth.test.ts`): `HarnessServer.boot({ productionAuth: true })` +
// `listen()` stands the REAL `@bolusi/server` on a REAL loopback TCP socket with the DB-backed auth
// path ENGAGED, and a REAL login → device enroll succeeds OVER HTTP (not in-process `app.request`).
// This is the emulator-faithful shape: the lane reaches this exact socket via `10.0.2.2` + `adb
// reverse`, so proving login→enroll over `fetch(running.url)` here is the local stand-in for the lane.
//
// WHAT MAKES 201 GREEN VS RED (the load-bearing assertion). Enroll presents the `bcs_` control session
// from login as its Bearer; the server resolves it via `findControlSessionByTokenHash` (a D14 definer)
// ONLY because `productionAuth` omitted `verifyToken` and injected the PGlite `authDirectory`. Boot
// WITHOUT `productionAuth` injects the in-memory token-map verifier, which does not know a real `bcs_`
// token → enroll 401. So `enroll → 201` is the direct witness that the boot extension routed auth
// through the production definer path. (§2.11 falsification: flip `productionAuth` off → enroll 401.)
//
// SEAMS EXERCISED (all task-201-B additions): the `productionAuth` boot option, the exposed
// `server.forTenant` (used to run the real `provisionTenant` transaction), and the deterministic
// `generatePassword` provision seam (a fixed one-time password, argon2id UNTOUCHED) that the
// provision-and-serve emulator entry will bake into the Maestro login flow.
import { bytesToBase64, createUuidV7Generator } from '@bolusi/core';
import { type ProvisionResult } from '@bolusi/server/test-support';
import { deriveDeviceKeypair, noblePort } from '@bolusi/test-support';
import { afterEach, describe, expect, test } from 'vitest';

// The deterministic provision seam (LANE_OTP injected as the one-time password, argon2id UNTOUCHED) and
// the provision transaction itself are the SHARED harness-provision helpers (§2.8) — the same ones the
// lane serve entry and the PGlite de-risk use. This test proves that seam works over a REAL socket.
import { LANE_OTP, LANE_OWNER_LOGIN, provisionHarnessOwner } from '../src/harness-provision.js';
import { HarnessServer, type RunningHarnessServer } from '../src/server.js';

async function provisionOwner(server: HarnessServer): Promise<ProvisionResult> {
  return provisionHarnessOwner(server, { oneTimePassword: LANE_OTP });
}

async function httpLogin(baseUrl: string, password: string): Promise<Response> {
  return fetch(`${baseUrl}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ loginIdentifier: LANE_OWNER_LOGIN, password }),
  });
}

async function httpEnroll(
  running: RunningHarnessServer,
  controlSession: string,
  storeId: string,
): Promise<Response> {
  const ids = createUuidV7Generator({
    now: () => running.server.clock.now(),
    randomBytes: (n) => noblePort.randomBytes(n),
  });
  return fetch(`${running.url}/v1/devices/enroll`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${controlSession}`,
      'Idempotency-Key': ids(),
    },
    body: JSON.stringify({
      deviceId: ids(),
      devicePublicKeyB64: bytesToBase64(deriveDeviceKeypair(7, 0).publicKey),
      storeId,
      deviceName: 'Tablet Kasir',
      platform: 'android',
      appVersion: '1.0.0',
    }),
  });
}

describe('task 201-B: HarnessServer.boot({ productionAuth }) serves real auth over a loopback socket', () => {
  let running: RunningHarnessServer | undefined;
  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  test('a real login → device enroll succeeds over HTTP against the bound socket', async () => {
    const server = await HarnessServer.boot({ productionAuth: true });
    running = await server.listen();

    // §2.5: the token-minting server binds loopback ONLY — never the LAN.
    expect(running.address).toBe('127.0.0.1');

    const provisioned = await provisionOwner(server);
    // The deterministic provision seam is wired: the returned OTP is the injected literal.
    expect(provisioned.oneTimePassword).toBe(LANE_OTP);

    // LOGIN over HTTP — findLoginCredential (definer) + real argon2id verify, over PGlite.
    const loginRes = await httpLogin(running.url, LANE_OTP);
    expect(loginRes.status).toBe(200);
    const controlSession = ((await loginRes.json()) as { controlSession: string }).controlSession;
    expect(typeof controlSession).toBe('string');

    // ENROLL over HTTP — the Bearer control session resolves via findControlSessionByTokenHash
    // (definer). 201 here is the witness that boot routed auth through the production DB path.
    const enrollRes = await httpEnroll(running, controlSession, provisioned.storeIds[0]);
    expect(enrollRes.status).toBe(201);
    const enrollBody = (await enrollRes.json()) as { deviceToken?: unknown };
    expect(typeof enrollBody.deviceToken).toBe('string');
  });

  test('a wrong password is rejected by the real argon2id verify (login 401)', async () => {
    const server = await HarnessServer.boot({ productionAuth: true });
    running = await server.listen();
    await provisionOwner(server);

    const res = await httpLogin(running.url, 'not-the-password');
    // The production login path runs the real verifier and fails closed on a bad password.
    expect(res.status).toBe(401);
  });
});

// §2.5 / §2.11: the loopback-only bind is THE control of this token-minting surface, and it is CLOSED BY
// CONSTRUCTION — enforced at the bind site in `listen()` whenever the server booted `productionAuth`, not
// left to the `.mjs` caller-check (a comment until now). This proves the REJECT branch directly: a real
// productionAuth server refuses a non-loopback `hostname` and opens no socket, so no future caller can
// talk this surface onto the LAN. (Falsified: removing the `listen()` guard makes `0.0.0.0` bind and
// resolve, flipping this red.)
describe('task 201-B: a productionAuth server refuses a non-loopback bind (closed by construction)', () => {
  let server: HarnessServer | undefined;
  afterEach(async () => {
    // Each `listen()` below throws before opening a socket, so there is no RunningHarnessServer to close;
    // tear the booted PGlite handle down directly so a refused bind never leaks the DB.
    await server?.close();
    server = undefined;
  });

  test('listen({ hostname }) refuses every non-loopback host and opens no socket', async () => {
    server = await HarnessServer.boot({ productionAuth: true });
    // Each is a bind a token-minting server must NEVER accept: `0.0.0.0` exposes every interface;
    // `192.168.*` / `10.0.2.2` are network-reachable (10.0.2.2 is how the emulator GUEST reaches the
    // host, never a host bind); `::1` / `localhost` are off the IPv4 `adb reverse` path this lane needs.
    for (const hostname of ['0.0.0.0', '192.168.1.5', '10.0.2.2', '::1', 'localhost']) {
      await expect(server.listen({ hostname }), hostname).rejects.toThrow(/non-loopback bind/);
    }
  });
});
