// Task 198 steps 1–3: the host-side network sync harness — `startHarnessServer` (a REAL loopback TCP
// socket over the production `app.fetch`), `socketBaseFetch` (reuse the in-process transports over the
// wire), and `describeDeviceHandoff` (the out-of-band bearer + emulator URL an on-device CHAOS runner
// receives). Runs in the harness lane (`pnpm chaos`), NOT the SEC-inventory sweep lane: the adversarial
// subset below is HARNESS-CORRECTNESS — it proves the socket seam does not BYPASS the auth/tenant layer
// that `@bolusi/server` already catalogues and secures (SEC-AUTH revocation, cross-tenant RLS). The
// production endpoints it serves are the SEC-owned surfaces; this file guards that opening a port added
// no hole. §2.5 is satisfied by these adversarial tests existing + being falsified BEFORE review — each
// negative below was watched red (see FALSIFY notes) — not by a SEC id for test-only infra.
import { FakeClock, mulberry32 } from '@bolusi/test-support';
import { describe, expect, test } from 'vitest';

import { VirtualDevice } from './device.js';
import { mintIdentities } from './identities.js';
import { describeDeviceHandoff, socketBaseFetch } from './net-server.js';
import { rawPush } from './raw-wire.js';
import { startHarnessServer } from './server.js';
import { HttpTransport, pullDevice, pushDevice } from './transport.js';

const CLOCK_BASE = 1_726_100_000_000;
const PUSH_URL = 'http://harness.test/v1/sync/push';

/** A device authoring one note, so a push over the socket carries REAL ops (genesis + a notes op). */
async function openAuthoring(
  identity: Parameters<typeof VirtualDevice.open>[0]['identity'],
  seed: number,
): Promise<VirtualDevice> {
  const device = await VirtualDevice.open({
    identity,
    clock: new FakeClock(CLOCK_BASE),
    prng: mulberry32(seed),
  });
  await device.createNote({ title: 'over-the-wire', body: 'x' });
  return device;
}

describe('startHarnessServer — real socket exposure (task 198 step 1)', () => {
  test('the socket serves the SAME app as the in-process fetch (error-envelope parity)', async () => {
    const running = await startHarnessServer();
    try {
      // Missing bearer ⇒ a deterministic, DB-independent 401 from the auth middleware — identical
      // whether the request arrives in-process (`app.request`) or over the socket (`app.fetch`),
      // because it is the SAME handler reached two ways.
      const inproc = await running.server.fetch(PUSH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"ops":[]}',
      });
      const sock = await fetch(`${running.url}/v1/sync/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"ops":[]}',
      });
      const inprocBody = (await inproc.json()) as { error?: { code?: string } };
      const sockBody = (await sock.json()) as { error?: { code?: string } };

      expect(inproc.status).toBe(401); // denominator: it IS the auth path
      expect(sock.status).toBe(inproc.status);
      expect(sockBody.error?.code).toBe(inprocBody.error?.code);
    } finally {
      await running.close();
    }
  });

  test('binds host loopback only — never the LAN (a token-minting server, §2.5)', async () => {
    const running = await startHarnessServer();
    try {
      expect(running.address).toBe('127.0.0.1');
      expect(running.url).toBe(`http://127.0.0.1:${running.port}`);
    } finally {
      await running.close();
    }
  });

  test('close() shuts the socket — a subsequent request is refused', async () => {
    const running = await startHarnessServer();
    const url = running.url;
    await running.close();
    // undici rejects with ECONNREFUSED once the listener is gone.
    await expect(
      fetch(`${url}/v1/sync/push`, { method: 'POST', body: '{"ops":[]}' }),
    ).rejects.toThrow();
  });

  test('a seeded device pushes REAL ops over the socket (the full production pipeline)', async () => {
    const running = await startHarnessServer();
    const [identity] = mintIdentities(70_101, 1).devices;
    const seeded = await running.server.seedDevice(identity!);
    const device = await openAuthoring(identity!, 70_101);
    try {
      const transport = new HttpTransport(socketBaseFetch(running.url), seeded.auth);
      const push = await pushDevice(device, transport);
      expect(push.rejected).toBe(0);
      expect(push.synced).toBeGreaterThan(0); // ops crossed the wire AND the real server applied them
    } finally {
      await device.close();
      await running.close();
    }
  });
});

describe('describeDeviceHandoff — out-of-band device handoff (task 198 step 3)', () => {
  test('maps the bound port to the emulator host-loopback alias + strips the Bearer prefix', async () => {
    const running = await startHarnessServer();
    const [identity] = mintIdentities(70_301, 1).devices;
    const seeded = await running.server.seedDevice(identity!);
    try {
      const handoff = describeDeviceHandoff(running, seeded);
      expect(handoff.emulatorUrl).toBe(`http://10.0.2.2:${running.port}`);
      expect(handoff.reverseUrl).toBe(`http://127.0.0.1:${running.port}`);
      expect(handoff.bearer).toBe(seeded.auth.replace(/^Bearer /, ''));
      expect(handoff.bearer.startsWith('bdt_harness_')).toBe(true);
      expect(handoff.bearer).not.toContain('Bearer');
      expect(handoff.tenantId).toBe(identity!.tenantId);
      expect(handoff.deviceId).toBe(identity!.deviceId);
    } finally {
      await running.close();
    }
  });
});

// ── §2.5 adversarial: the socket seam must not bypass production auth/tenant isolation (step 2) ──────
describe('§2.5 the network socket enforces the same auth the in-process app does (task 198 step 2)', () => {
  test('a REVOKED device token is refused over the socket (401 DEVICE_REVOKED), never served', async () => {
    // FALSIFY: seeding this device `active` instead of `revoked` made the push authenticate and reach
    // a post-auth 422 (empty-body validation) rather than 401 DEVICE_REVOKED — both asserts below went
    // red — confirming the 401 is genuine revocation, not a blanket deny of every push.
    const running = await startHarnessServer({ testAuthSeam: true });
    const [revokedId] = mintIdentities(80_101, 1).devices;
    const [activeId] = mintIdentities(80_102, 1).devices;
    const revoked = await running.server.seedDevice(revokedId!, { status: 'revoked' });
    const active = await running.server.seedDevice(activeId!, { status: 'active' });
    try {
      const rejected = await rawPush(socketBaseFetch(running.url), revoked.auth, {
        deviceId: revokedId!.deviceId,
        ops: [],
      });
      expect(rejected.httpStatus).toBe(401);
      expect(rejected.errorCode).toBe('DEVICE_REVOKED');

      // Positive control: an ACTIVE token over the SAME socket AUTHENTICATES — it gets PAST auth to a
      // non-401 response (an empty push fails later body validation with 422, which is post-auth), so
      // the 401 above is revocation-specific, not a blanket reject of every request.
      const accepted = await rawPush(socketBaseFetch(running.url), active.auth, {
        deviceId: activeId!.deviceId,
        ops: [],
      });
      expect(accepted.httpStatus).not.toBe(401);
      expect(accepted.errorCode).not.toBe('DEVICE_REVOKED');
    } finally {
      await running.close();
    }
  });

  test('an unauthenticated caller is refused and NO bearer token leaks in the response body', async () => {
    // FALSIFY: asserting `toContain('bdt_harness_')` (the inverse) went red — the 401 bodies carry no
    // token material — and dropping `testAuthSeam` made the garbage-token case a 500, not a 401, so the
    // production verifier is what renders the clean AUTH_TOKEN_INVALID here.
    const running = await startHarnessServer({ testAuthSeam: true });
    const [identity] = mintIdentities(80_201, 1).devices;
    const seeded = await running.server.seedDevice(identity!); // a real token EXISTS server-side
    const rawToken = seeded.auth.replace(/^Bearer /, '');
    try {
      const noAuth = await fetch(`${running.url}/v1/sync/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"ops":[]}',
      });
      const garbage = await fetch(`${running.url}/v1/sync/push`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer bdt_harness_deadbeef',
          'Content-Type': 'application/json',
        },
        body: '{"ops":[]}',
      });
      expect(noAuth.status).toBe(401);
      expect(garbage.status).toBe(401);

      const noAuthText = await noAuth.text();
      const garbageText = await garbage.text();
      for (const body of [noAuthText, garbageText]) {
        expect(body).not.toContain('bdt_harness_'); // the handoff is out-of-band; the socket mints none
        expect(body).not.toContain(rawToken);
      }
    } finally {
      await running.close();
    }
  });

  test("a tenant's bearer cannot reach another tenant over the socket — cross-tenant pull is empty", async () => {
    // FALSIFY: pointing device B's transport at tenant A's bearer (`seededA1.auth`) made B's pull apply
    // tenant A's ops (applied > 0) — red — so the 0 below is real RLS isolation, and the A2 control
    // proves the pull path itself works (an empty result is isolation, not a broken pull).
    const running = await startHarnessServer();
    const tenantA = mintIdentities(98_001, 2).devices; // [A1, A2] — same tenant + store
    const [b1] = mintIdentities(98_002, 1).devices; // tenant B (different seed ⇒ different tenant)
    const [a1, a2] = tenantA;

    const seededA1 = await running.server.seedDevice(a1!);
    const seededA2 = await running.server.seedDevice(a2!);
    const seededB1 = await running.server.seedDevice(b1!);

    const authorA1 = await openAuthoring(a1!, 98_001);
    const pullerA2 = await VirtualDevice.open({
      identity: a2!,
      clock: new FakeClock(CLOCK_BASE),
      prng: mulberry32(98_003),
    });
    const pullerB1 = await VirtualDevice.open({
      identity: b1!,
      clock: new FakeClock(CLOCK_BASE),
      prng: mulberry32(98_004),
    });
    try {
      // A1 pushes real ops into tenant A over the socket.
      const pushed = await pushDevice(
        authorA1,
        new HttpTransport(socketBaseFetch(running.url), seededA1.auth),
      );
      expect(pushed.synced).toBeGreaterThan(0);

      // Cross-tenant: B1 (tenant B) pulls over the socket and receives NONE of tenant A's ops.
      const pullB = await pullDevice(
        pullerB1,
        new HttpTransport(socketBaseFetch(running.url), seededB1.auth),
      );
      expect(pullB.applied).toBe(0);

      // Positive control: A2 (same tenant as A1) DOES receive A1's ops — the pull path works.
      const pullA2 = await pullDevice(
        pullerA2,
        new HttpTransport(socketBaseFetch(running.url), seededA2.auth),
      );
      expect(pullA2.applied).toBeGreaterThan(0);
    } finally {
      await authorA1.close();
      await pullerA2.close();
      await pullerB1.close();
      await running.close();
    }
  });
});
