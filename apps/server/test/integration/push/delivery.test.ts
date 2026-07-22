// COMPOSED push-delivery wiring (task 134). Two properties, both proven through the REAL server
// composition (`createApp` → resolveDeps default hooks / the pipeline / runPush / the on-revoke
// registry), never through a hook the test installed:
//
//   (1) DELIVERY HAPPENS. The old suites passed because they injected `onConflictSurfaced` the
//       shipping server never installed; here every send reaches `pushPort` via a default the server
//       binds itself. Because delivery is now FIRE-AND-FORGET (api/04-push §1/§6), a composed test
//       drains it with `await h.deliveries.flush()` before asserting — the flush is the test-only
//       seam the production request path never touches.
//   (2) DELIVERY IS NOT LOAD-BEARING. A push whose send blocks (an in-contract Expo outage, §6)
//       must NOT delay or fail the sync-push response. The latency probe below asserts the response
//       returns within a tight bound while the send is still blocked.
//
// Real PG16 (via makeSyncHarness / makePushHarness), FakePushPort (NO real Expo — CLAUDE.md §6),
// tenant-scoped forTenant (RLS enforced through appForTenant) so the tenant-isolation control is
// non-vacuous (T-14b/d).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { breakPreviousHash } from '@bolusi/test-support';
import type { PushResponse } from '@bolusi/schemas';

import type {
  DetectConflictsResult,
  SurfacedConflict,
} from '../../../src/sync/conflict-detection.js';
import { serverCryptoPort } from '../../../src/oplog/index.js';
import type { OutgoingPush } from '../../../src/push/payload.js';
import type { PushPort, PushReceipt, PushTicket } from '../../../src/push/port.js';
import { makeSyncHarness, type SyncHarness } from '../sync/helpers.js';
import { detUuid, expoToken, makePushHarness, type PushHarness } from '../../helpers/push.js';

const note = (title: string, body: string) => ({
  type: 'notes.note_created',
  entityType: 'note',
  payload: { title, body },
});

async function pushJson(res: Response): Promise<PushResponse> {
  return (await res.json()) as PushResponse;
}

/** A push sender whose `send` blocks for `delayMs` before recording — stands in for an in-contract
 *  Expo stall (429/5xx/stalled socket, api/04-push §6). Proves the request path does not await it. */
class SlowPushPort implements PushPort {
  readonly sent: OutgoingPush[][] = [];
  constructor(private readonly delayMs: number) {}
  async send(messages: readonly OutgoingPush[]): Promise<readonly PushTicket[]> {
    await new Promise((r) => setTimeout(r, this.delayMs));
    this.sent.push([...messages]);
    return messages.map((m) => ({
      deviceId: m.deviceId,
      token: m.to,
      status: 'ok' as const,
      receiptId: `r-${m.deviceId}`,
    }));
  }
  getReceipts(): Promise<ReadonlyMap<string, PushReceipt>> {
    return Promise.resolve(new Map());
  }
}

/** Insert a push_tokens row for a device (owner handle — a fixture). */
async function seedToken(
  h: SyncHarness,
  row: { tenantId: string; deviceId: string; userId?: string | null; token: string },
): Promise<void> {
  await h.db
    .insertInto('pushTokens')
    .values({
      id: detUuid(`pt:${row.deviceId}`),
      tenantId: row.tenantId,
      deviceId: row.deviceId,
      userId: row.userId ?? null,
      expoPushToken: row.token,
      updatedAt: 1,
    })
    .execute();
}

/** Grant `auth.device_read` to a user in a store (role + role_permission + user_role). */
async function grantDeviceRead(
  h: SyncHarness,
  row: { tenantId: string; userId: string; storeId: string | null },
): Promise<void> {
  const roleId = detUuid(`role:${row.userId}:${row.storeId ?? 'tenant'}`);
  await h.db
    .insertInto('roles')
    .values({
      id: roleId,
      tenantId: row.tenantId,
      name: `owner-${roleId.slice(0, 6)}`,
      scopeType: 'store',
      createdAt: 1,
    })
    .execute();
  await h.db
    .insertInto('rolePermissions')
    .values({ tenantId: row.tenantId, roleId, permissionId: 'auth.device_read' })
    .execute();
  await h.db
    .insertInto('userRoles')
    .values({ tenantId: row.tenantId, userId: row.userId, roleId, storeId: row.storeId })
    .execute();
}

// ── sync wake / conflict / anomaly + the latency probe — signed-push composition (makeSyncHarness) ─

describe('composed delivery through createApp (signed push path)', () => {
  let h: SyncHarness;
  afterEach(async () => {
    await h.close();
  });

  test('an accepted push delivers a data-only `sync` wake to an in-scope device (runPush → sendSyncWake)', async () => {
    // Predicted failure if the runPush → dispatch(sendSyncWake) wiring is removed: `allSent` is
    // empty after flush, so `.toHaveLength(1)` fails ("expected +0 to be 1"). Confirmed by breaking.
    h = await makeSyncHarness();
    const dev = await h.seedDevice(6100);
    const tok = expoToken('wake-dev');
    await seedToken(h, { tenantId: dev.world.tenantId, deviceId: dev.world.deviceId, token: tok });

    const res = await pushJson(await h.push(dev.auth, dev.world.deviceId, [dev.builder.genesis()]));
    expect(res.results[0]).toMatchObject({ status: 'accepted' });
    await h.deliveries.flush(); // drain the fire-and-forget delivery before asserting

    expect(h.pushPort.allSent).toHaveLength(1);
    const sent = h.pushPort.allSent[0]!;
    expect(sent.to).toBe(tok);
    expect(sent.push).toEqual({ data: { category: 'sync' } }); // data-only: no title/body/channel
  });

  test('POSITIVE CONTROL: a push that accepts nothing (all duplicate) delivers no wake', async () => {
    h = await makeSyncHarness();
    const dev = await h.seedDevice(6101);
    await seedToken(h, {
      tenantId: dev.world.tenantId,
      deviceId: dev.world.deviceId,
      token: expoToken('nowake-dev'),
    });
    const genesis = dev.builder.genesis();

    await h.push(dev.auth, dev.world.deviceId, [genesis]); // accepted → 1 wake
    await h.deliveries.flush();
    expect(h.pushPort.sends).toHaveLength(1);
    await h.push(dev.auth, dev.world.deviceId, [genesis]); // replay → all duplicate → nothing accepted
    await h.deliveries.flush();
    expect(h.pushPort.sends).toHaveLength(1); // still 1 — "always sends" would be 2
  });

  test('a surfaced conflict delivers a `conflict` push via the DEFAULT deps.onConflictSurfaced (not an injected hook)', async () => {
    // detectConflicts is INJECTED (the precondition — how a conflict comes to exist); the hook that
    // DELIVERS (`onConflictSurfaced`) is NOT injected, so this exercises the deps.ts default. The
    // surfaced payload is filled after seedDevice via a mutable holder the injected detector reads.
    // Predicted failure if that default is unbound: no `conflict` message → `.toHaveLength(1)` sees 0.
    let surfaced: SurfacedConflict[] = [];
    h = await makeSyncHarness({
      overrides: {
        detectConflicts: async (): Promise<DetectConflictsResult> => ({ ops: [], surfaced }),
      },
    });
    const dev = await h.seedDevice(6102);
    const conflictId = detUuid('surfaced-conflict-1');
    surfaced = [
      {
        conflictId,
        tenantId: dev.world.tenantId,
        storeId: dev.world.storeId,
        category: 'conflict',
      },
    ];
    const tokA = expoToken('conf-dev');
    await seedToken(h, {
      tenantId: dev.world.tenantId,
      deviceId: dev.world.deviceId,
      userId: dev.world.userId,
      token: tokA,
    });

    // Zero-relationship tenant B: its token must NEVER receive tenant A's conflict.
    const devB = await h.seedDevice(6103);
    const tokB = expoToken('conf-tenantB');
    await seedToken(h, {
      tenantId: devB.world.tenantId,
      deviceId: devB.world.deviceId,
      token: tokB,
    });

    await h.push(dev.auth, dev.world.deviceId, [dev.builder.genesis()]);
    await h.deliveries.flush();

    const conflictSends = h.pushPort.allSent.filter((m) => m.push.data.category === 'conflict');
    expect(conflictSends).toHaveLength(1);
    const msg = conflictSends[0]!;
    expect(msg.to).toBe(tokA);
    if (!('channelId' in msg.push)) throw new Error('expected a visible conflict push');
    expect(msg.push.channelId).toBe('bolusi.conflict');
    expect(msg.push.data).toEqual({
      category: 'conflict',
      route: 'conflicts',
      params: { conflictId },
    });

    // TENANT SCOPING (zero-relationship control): tenant B's token appears in NOTHING delivered.
    expect(h.pushPort.allSent.map((m) => m.to)).not.toContain(tokB);
  });

  test('POSITIVE CONTROL: an accepted push whose detector surfaces NOTHING delivers no `conflict` push', async () => {
    h = await makeSyncHarness({
      overrides: {
        detectConflicts: async (): Promise<DetectConflictsResult> => ({ ops: [], surfaced: [] }),
      },
    });
    const dev = await h.seedDevice(6104);
    await seedToken(h, {
      tenantId: dev.world.tenantId,
      deviceId: dev.world.deviceId,
      userId: dev.world.userId,
      token: expoToken('noconf-dev'),
    });

    await h.push(dev.auth, dev.world.deviceId, [dev.builder.genesis()]);
    await h.deliveries.flush();
    // A `sync` wake may fire (an op was accepted); a `conflict` must NOT — nothing surfaced.
    expect(h.pushPort.allSent.some((m) => m.push.data.category === 'conflict')).toBe(false);
  });

  test('a device anomaly delivers a `device` alert to owner devices via the DEFAULT deps.onDeviceAnomaly', async () => {
    // Predicted failure if the pipeline → deps.onDeviceAnomaly binding is removed: no `device`
    // message → `.toHaveLength(1)` sees 0.
    h = await makeSyncHarness();
    const dev = await h.seedDevice(6105);
    // The pushing device is itself an owner (holds auth.device_read) with a registered token, so it
    // is the recipient of the alert about itself.
    await grantDeviceRead(h, {
      tenantId: dev.world.tenantId,
      userId: dev.world.userId,
      storeId: dev.world.storeId,
    });
    const tok = expoToken('anomaly-owner');
    await seedToken(h, {
      tenantId: dev.world.tenantId,
      deviceId: dev.world.deviceId,
      userId: dev.world.userId,
      token: tok,
    });

    // A CHAIN_BROKEN op (an anomaly kind, anomalies.ts): genesis accepted, then a seq-2 op whose
    // previousHash is wrong. The batch commits; the post-commit device alert fires about this device.
    const genesis = dev.builder.genesis();
    const note1 = dev.builder.append(note('a', 'b'));
    const broken = breakPreviousHash(note1, 'a'.repeat(64), dev.world.secretKey, serverCryptoPort);
    const res = await pushJson(await h.push(dev.auth, dev.world.deviceId, [genesis, broken]));
    expect(res.results[1]).toMatchObject({ status: 'rejected', code: 'CHAIN_BROKEN' });
    await h.deliveries.flush();

    const deviceSends = h.pushPort.allSent.filter((m) => m.push.data.category === 'device');
    expect(deviceSends).toHaveLength(1);
    const msg = deviceSends[0]!;
    expect(msg.to).toBe(tok);
    if (!('channelId' in msg.push)) throw new Error('expected a visible device push');
    expect(msg.push.channelId).toBe('bolusi.device');
    expect(msg.push.data).toEqual({
      category: 'device',
      route: 'devices',
      params: { deviceId: dev.world.deviceId },
    });
  });

  test('a blocked push send NEVER delays or fails the sync-push response (api/04-push §1/§6 — push is not load-bearing)', async () => {
    // The availability property. The injected sender blocks 3s inside `send` (an in-contract Expo
    // stall). If delivery were awaited on the request path, `await h.push` would take ~3s.
    // Predicted failure when the fire-and-forget is broken (await the dispatch): elapsed ≈ 3000ms →
    // `expect(elapsed).toBeLessThan(1500)` reds ("expected ~30xx to be less than 1500").
    const slow = new SlowPushPort(3000);
    h = await makeSyncHarness({ pushPort: slow });
    const dev = await h.seedDevice(6106);
    await seedToken(h, {
      tenantId: dev.world.tenantId,
      deviceId: dev.world.deviceId,
      token: expoToken('latency-dev'),
    });

    const t0 = performance.now();
    const res = await pushJson(await h.push(dev.auth, dev.world.deviceId, [dev.builder.genesis()]));
    const elapsed = performance.now() - t0;

    expect(res.results[0]).toMatchObject({ status: 'accepted' }); // the write path succeeds …
    expect(elapsed).toBeLessThan(1500); // … WITHOUT waiting on the 3s send (bound < the 3s stall)
    expect(slow.sent).toHaveLength(0); // delivery is still in flight — off the request path

    // And the push is NOT dropped: once the network unblocks it delivers.
    await h.deliveries.flush();
    expect(slow.sent).toHaveLength(1);
  }, 20_000);
});

// ── revocation `device` alert — the on-revoke registry composition (makePushHarness) ─────────────

describe('composed revocation alert through createApp', () => {
  let h: PushHarness;
  beforeAll(async () => {
    h = await makePushHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(() => {
    h.pushPort.sends.length = 0;
  });

  test('a revocation fires the composed hook → a `device` alert reaches the owner, never a tenant-B token', async () => {
    // The hook is registered by createApp onto the injected revocationHooks (app.ts, task 134);
    // firing it is exactly what routes/devices.ts does post-commit. Predicted failure if app.ts does
    // not register it: `allSent` is empty after flush → `.toHaveLength(1)` sees 0.
    const owner = await h.seedDevice('rev-owner');
    await h.grantDeviceRead({
      tenantId: owner.tenantId,
      userId: owner.userId,
      storeId: owner.storeId,
    });
    const ownerTok = expoToken('rev-owner-tok');
    await h.seedPushToken({
      tenantId: owner.tenantId,
      deviceId: owner.deviceId,
      userId: owner.userId,
      token: ownerTok,
    });
    // Zero-relationship tenant B: a device_read owner in another tenant with a token must not hear it.
    const bystander = await h.seedDevice('rev-bystander');
    await h.grantDeviceRead({
      tenantId: bystander.tenantId,
      userId: bystander.userId,
      storeId: bystander.storeId,
    });
    const bystanderTok = expoToken('rev-bystander-tok');
    await h.seedPushToken({
      tenantId: bystander.tenantId,
      deviceId: bystander.deviceId,
      userId: bystander.userId,
      token: bystanderTok,
    });

    const revokedDeviceId = detUuid('rev-target');
    await h.revocationHooks.fire({ deviceId: revokedDeviceId, tenantId: owner.tenantId });
    await h.deliveries.flush();

    const deviceSends = h.pushPort.allSent.filter((m) => m.push.data.category === 'device');
    expect(deviceSends).toHaveLength(1);
    const msg = deviceSends[0]!;
    expect(msg.to).toBe(ownerTok);
    if (!('channelId' in msg.push)) throw new Error('expected a visible device push');
    expect(msg.push.data).toEqual({
      category: 'device',
      route: 'devices',
      params: { deviceId: revokedDeviceId },
    });
    // TENANT SCOPING: the revocation was in tenant A; tenant B's owner token is never reached.
    expect(h.pushPort.allSent.map((m) => m.to)).not.toContain(bystanderTok);
  });
});
