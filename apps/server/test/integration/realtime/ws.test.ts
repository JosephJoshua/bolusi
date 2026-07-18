// Realtime WS integration (api/00 §12.1) — a REAL upgrade: `serve()` on an ephemeral port + a `ws`
// client. `app.fetch` cannot drive the upgrade path (the acceptance bar), so these are the only
// tests that exercise auth-at-upgrade, the frozen frame on the wire, scope fan-out over a socket,
// revocation-closes-socket, single-connection, and client-frame hardening end to end.
//
// Adversarial (security-guide §9.2): SEC-RT-01 (unauth/invalid/revoked/query-string → 401, no
// socket), SEC-RT-02 (revoke closes the live socket, reconnect → 401), SEC-RT-04 (tenant B's
// activity produces zero pokes to a tenant-A device — with a zero-relationship control), SEC-RT-05
// (junk client frames dropped, socket healthy; a flood closes it).
import { serve } from '@hono/node-server';
import { afterEach, describe, expect, test } from 'vitest';
import { WebSocket } from 'ws';

import { zSyncPokeMessage, zWsFrame } from '@bolusi/schemas';

import { createApp } from '../../../src/app.js';
import { InMemoryTokenStore, createVerifyToken } from '../../../src/middleware/auth.js';
import { RevocationHooks } from '../../../src/identity/revocation.js';
import { InProcessPokeHub, type PokeScope } from '../../../src/realtime/poke-hub.js';
import { makeRealtimeWebSocketServer } from '../../../src/realtime/serve.js';
import { makeFixture } from '../../helpers/fixtures.js';

interface Rig {
  readonly port: number;
  readonly tokenStore: InMemoryTokenStore;
  readonly pokeHub: InProcessPokeHub;
  readonly revocationHooks: RevocationHooks;
  close(): Promise<void>;
}

const rigs: Rig[] = [];

async function makeRig(): Promise<Rig> {
  const tokenStore = new InMemoryTokenStore();
  const pokeHub = new InProcessPokeHub();
  const revocationHooks = new RevocationHooks();
  const app = createApp({
    verifyToken: createVerifyToken({ store: tokenStore, now: () => Date.now() }),
    pokeHub,
    revocationHooks,
  });
  const wss = makeRealtimeWebSocketServer();
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, websocket: { server: wss } }, () => resolve(s));
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const rig: Rig = {
    port,
    tokenStore,
    pokeHub,
    revocationHooks,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
  rigs.push(rig);
  return rig;
}

afterEach(async () => {
  while (rigs.length > 0) {
    await rigs.pop()?.close();
  }
});

function enroll(
  rig: Rig,
  fields: {
    deviceId: string;
    tenantId: string;
    storeId: string | null;
    token: string;
    revoked?: boolean;
  },
): void {
  rig.tokenStore.add(fields.token, {
    kind: 'device',
    deviceId: fields.deviceId,
    tenantId: fields.tenantId,
    storeId: fields.storeId,
    deviceStatus: fields.revoked === true ? 'revoked' : 'active',
  });
}

function wsUrl(rig: Rig, path = '/v1/realtime'): string {
  return `ws://127.0.0.1:${rig.port}${path}`;
}

/** Open a socket expected to succeed. Resolves once `open` fires; collects text frames. */
function openSocket(
  rig: Rig,
  token: string | undefined,
  path = '/v1/realtime',
): Promise<{ ws: WebSocket; frames: string[]; nextFrame: () => Promise<string> }> {
  const headers = token === undefined ? {} : { Authorization: `Bearer ${token}` };
  const ws = new WebSocket(wsUrl(rig, path), { headers });
  const frames: string[] = [];
  const waiters: ((frame: string) => void)[] = [];
  ws.on('message', (data: Buffer, isBinary: boolean) => {
    const text = isBinary ? '__BINARY__' : data.toString('utf8');
    // Hand the frame to a pending waiter OR buffer it — never both (no double-count).
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter(text);
    else frames.push(text);
  });
  return new Promise((resolve, reject) => {
    ws.once('open', () =>
      resolve({
        ws,
        frames,
        nextFrame: () =>
          new Promise<string>((res) => {
            const pending = frames.shift();
            if (pending !== undefined) res(pending);
            else waiters.push(res);
          }),
      }),
    );
    ws.once('unexpected-response', (_req, res) =>
      reject(new Error(`unexpected-response ${res.statusCode}`)),
    );
    ws.once('error', (err) => reject(err));
  });
}

/** Open a socket expected to be REJECTED at the HTTP upgrade. Resolves with the HTTP status. */
function expectUpgradeRejected(
  rig: Rig,
  headers: Record<string, string>,
  path = '/v1/realtime',
): Promise<number> {
  const ws = new WebSocket(wsUrl(rig, path), { headers });
  return new Promise((resolve, reject) => {
    ws.once('unexpected-response', (_req, res) => {
      ws.terminate();
      resolve(res.statusCode ?? 0);
    });
    ws.once('open', () => {
      ws.close();
      reject(new Error('expected upgrade to be rejected, but the socket opened'));
    });
    ws.once('error', (err) => {
      // Some rejection paths surface as an error carrying the status text; treat 401 there too.
      const status = /\b401\b/.test(String((err as Error).message)) ? 401 : 0;
      if (status === 401) resolve(401);
      else reject(err);
    });
  });
}

function closeEvent(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.once('close', (code) => resolve(code)));
}

describe('realtime WS — real upgrade (api/00 §12.1)', () => {
  test('valid device bearer → open socket; a poke arrives as the frozen sync.poke frame', async () => {
    const rig = await makeRig();
    const fx = makeFixture('ws-ok');
    enroll(rig, {
      deviceId: fx.deviceId,
      tenantId: fx.tenantId,
      storeId: fx.storeId,
      token: fx.deviceToken,
    });
    const { ws, nextFrame } = await openSocket(rig, fx.deviceToken);

    rig.pokeHub.publish([{ tenantId: fx.tenantId, storeId: fx.storeId }]);
    const raw = await nextFrame();

    const parsedJson: unknown = JSON.parse(raw);
    // Frame-level: valid JSON `{ type, payload }`.
    expect(zWsFrame.safeParse(parsedJson).success).toBe(true);
    // Exactly the frozen sync.poke (SEC-RT-03 on the wire): no business value can ride it.
    const poke = zSyncPokeMessage.safeParse(parsedJson);
    expect(poke.success).toBe(true);
    expect(parsedJson).toEqual({ type: 'sync.poke', payload: {} });
    ws.close();
  });

  test('SEC-RT-01 unauthenticated upgrade refused — missing/invalid/revoked/query-string → 401, no socket', async () => {
    const rig = await makeRig();
    const fx = makeFixture('ws-sec01');
    enroll(rig, {
      deviceId: fx.deviceId,
      tenantId: fx.tenantId,
      storeId: fx.storeId,
      token: fx.deviceToken,
      revoked: true, // a revoked device
    });

    // Missing token.
    expect(await expectUpgradeRejected(rig, {})).toBe(401);
    // Invalid token.
    expect(await expectUpgradeRejected(rig, { Authorization: 'Bearer bdt_not_a_real_token' })).toBe(
      401,
    );
    // Revoked device.
    expect(await expectUpgradeRejected(rig, { Authorization: `Bearer ${fx.deviceToken}` })).toBe(
      401,
    );
    // A token in the QUERY STRING is never read — no Authorization header → 401.
    expect(await expectUpgradeRejected(rig, {}, `/v1/realtime?token=${fx.deviceToken}`)).toBe(401);
  });

  test('SEC-RT-02 revocation closes the socket ≤ 5 s; reconnect → 401', async () => {
    const rig = await makeRig();
    const fx = makeFixture('ws-sec02');
    enroll(rig, {
      deviceId: fx.deviceId,
      tenantId: fx.tenantId,
      storeId: fx.storeId,
      token: fx.deviceToken,
    });
    const { ws } = await openSocket(rig, fx.deviceToken);
    const closed = closeEvent(ws);

    // Drive the revocation path: the token now verifies as revoked, and the on-revoke hook fires
    // (real /v1/devices/:id/revoke wiring is task 13; the hook lives in this task).
    enroll(rig, {
      deviceId: fx.deviceId,
      tenantId: fx.tenantId,
      storeId: fx.storeId,
      token: fx.deviceToken,
      revoked: true,
    });
    await rig.revocationHooks.fire({ deviceId: fx.deviceId, tenantId: fx.tenantId });

    // Socket closed by the server, bounded well under 5 s.
    await expect(
      Promise.race([
        closed,
        new Promise((_r, reject) => setTimeout(() => reject(new Error('not closed in 5s')), 5_000)),
      ]),
    ).resolves.toBeTypeOf('number');

    // Reconnect is refused at auth.
    expect(await expectUpgradeRejected(rig, { Authorization: `Bearer ${fx.deviceToken}` })).toBe(
      401,
    );
  });

  test('SEC-RT-04 poke fan-out scope — tenant B activity produces zero pokes to a tenant-A device', async () => {
    const rig = await makeRig();
    const a = makeFixture('ws-sec04-a');
    const b = makeFixture('ws-sec04-b');
    enroll(rig, {
      deviceId: a.deviceId,
      tenantId: a.tenantId,
      storeId: a.storeId,
      token: a.deviceToken,
    });
    enroll(rig, {
      deviceId: b.deviceId,
      tenantId: b.tenantId,
      storeId: b.storeId,
      token: b.deviceToken,
    });
    const deviceA = await openSocket(rig, a.deviceToken);

    // Mixed concurrent activity in tenant B / other store — none is in A's pull scope. A poke
    // carries no scope on the wire, so a leak cannot be masked by coalescing: assert A receives
    // ZERO frames from the foreign activity BEFORE any legitimate poke exists to confuse it.
    const foreignScopes: PokeScope[] = [
      { tenantId: b.tenantId, storeId: b.storeId },
      { tenantId: b.tenantId, storeId: null },
      { tenantId: a.tenantId, storeId: makeFixture('ws-sec04-other-store').storeId }, // A's tenant, a store A is not in
    ];
    rig.pokeHub.publish(foreignScopes);
    await new Promise((r) => setTimeout(r, 100));
    expect(deviceA.frames.length).toBe(0); // the foreign activity left NO trace on A

    // Then ONE legitimate poke in A's own scope — its arrival proves the socket was live all along
    // (so "zero foreign pokes" is a real negative, not a dead socket).
    rig.pokeHub.publish([{ tenantId: a.tenantId, storeId: a.storeId }]);
    const raw = await deviceA.nextFrame();
    expect(JSON.parse(raw)).toEqual({ type: 'sync.poke', payload: {} });
    deviceA.ws.close();
  });

  test('single connection per device: a second upgrade closes the first', async () => {
    const rig = await makeRig();
    const fx = makeFixture('ws-single');
    enroll(rig, {
      deviceId: fx.deviceId,
      tenantId: fx.tenantId,
      storeId: fx.storeId,
      token: fx.deviceToken,
    });
    const first = await openSocket(rig, fx.deviceToken);
    const firstClosed = closeEvent(first.ws);
    const second = await openSocket(rig, fx.deviceToken);

    await expect(
      Promise.race([
        firstClosed,
        new Promise((_r, reject) => setTimeout(() => reject(new Error('first not closed')), 5_000)),
      ]),
    ).resolves.toBeTypeOf('number');

    // The surviving (second) socket still receives pokes.
    rig.pokeHub.publish([{ tenantId: fx.tenantId, storeId: fx.storeId }]);
    expect(JSON.parse(await second.nextFrame())).toEqual({ type: 'sync.poke', payload: {} });
    second.ws.close();
  });

  test('SEC-RT-05 client message hardening — junk frames dropped, socket healthy; flood closes it', async () => {
    const rig = await makeRig();
    const fx = makeFixture('ws-sec05');
    enroll(rig, {
      deviceId: fx.deviceId,
      tenantId: fx.tenantId,
      storeId: fx.storeId,
      token: fx.deviceToken,
    });
    const conn = await openSocket(rig, fx.deviceToken);

    // Oversized (relative to the tiny protocol), malformed, unknown-type, and binary frames.
    conn.ws.send('x'.repeat(8 * 1024));
    conn.ws.send('{ not valid json');
    conn.ws.send(JSON.stringify({ type: 'client.hello', payload: { evil: true } }));
    conn.ws.send(Buffer.from([0x00, 0x01, 0x02, 0x03]));
    await new Promise((r) => setTimeout(r, 50));

    // Still healthy: a poke in scope still arrives (the server ignored every client frame).
    rig.pokeHub.publish([{ tenantId: fx.tenantId, storeId: fx.storeId }]);
    expect(JSON.parse(await conn.nextFrame())).toEqual({ type: 'sync.poke', payload: {} });

    // A flood past the per-connection cap closes the socket.
    const flooded = await openSocket(rig, fx.deviceToken); // fresh single connection for the device
    const floodClosed = closeEvent(flooded.ws);
    for (let i = 0; i < 130; i += 1) flooded.ws.send('{}');
    await expect(
      Promise.race([
        floodClosed,
        new Promise((_r, reject) => setTimeout(() => reject(new Error('flood not closed')), 5_000)),
      ]),
    ).resolves.toBeTypeOf('number');
  });
});
