// Fan-out scope + token lifecycle (api/04-push §3, §6, §8). Real PG16 (devices/push_tokens/user_prefs
// + RLS via appForTenant), FakePushPort (NO real Expo — CLAUDE.md §6), fake clock + a capturing
// receipt scheduler. The SEC-RT-04 push leg lives here (security-guide §9.2). Assertions read the
// WHOLE captured send-set (T-14), never a sample.
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';

import {
  InMemorySyncCoalescer,
  NO_LIVE_CONNECTIONS,
  sendConflictSurfaced,
  sendDeviceAlert,
  sendSyncWake,
  type LiveConnectionRegistry,
  type PushDeliveryDeps,
} from '../../../src/push/fanout.js';
import { FakePushPort } from '../../../src/push/port.js';
import { RECEIPT_POLL_DELAY_MS, type ReceiptScheduler } from '../../../src/push/receipts.js';
import { expoToken, makePushHarness, type PushHarness } from '../../helpers/push.js';

let h: PushHarness;
let port: FakePushPort;

/** Records scheduled tasks so the ≥ 15 min receipt poll runs on demand under fake timers. */
class CapturingScheduler implements ReceiptScheduler {
  readonly scheduled: { delayMs: number; task: () => Promise<void> }[] = [];
  schedule(delayMs: number, task: () => Promise<void>): void {
    this.scheduled.push({ delayMs, task });
  }
  async runAll(): Promise<void> {
    for (const s of this.scheduled) await s.task();
    this.scheduled.length = 0;
  }
}
let scheduler: CapturingScheduler;

function deps(overrides: Partial<PushDeliveryDeps> = {}): PushDeliveryDeps {
  return {
    forTenant: h.testDb.appForTenant,
    pushPort: port,
    liveConnections: NO_LIVE_CONNECTIONS,
    coalescer: new InMemorySyncCoalescer(),
    receiptScheduler: scheduler,
    now: () => h.clock.now(),
    ...overrides,
  };
}

/** Tokens actually sent, sorted — the whole set. */
function sentTokens(): string[] {
  return port.allSent.map((m) => m.to).sort();
}

beforeAll(async () => {
  h = await makePushHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(() => {
  port = new FakePushPort();
  scheduler = new CapturingScheduler();
});

test('SEC-RT-04 (push leg): tenant-B activity and tenant-A other-store activity → zero pushes to a store-1 device', async () => {
  const a1 = await h.seedDevice('rt04-a');
  const store2 = await h.seedStore(a1.tenantId, 'rt04-a-s2');
  const a2 = await h.seedDeviceInTenant('rt04-a2', { tenantId: a1.tenantId, storeId: store2 });
  const b = await h.seedDevice('rt04-b');
  const tokA1 = expoToken('rt04-a-tok');
  const tokA2 = expoToken('rt04-a2-tok');
  const tokB = expoToken('rt04-b-tok');
  await h.seedPushToken({
    tenantId: a1.tenantId,
    deviceId: a1.deviceId,
    userId: a1.userId,
    token: tokA1,
  });
  await h.seedPushToken({
    tenantId: a1.tenantId,
    deviceId: a2.deviceId,
    userId: a2.userId,
    token: tokA2,
  });
  await h.seedPushToken({
    tenantId: b.tenantId,
    deviceId: b.deviceId,
    userId: b.userId,
    token: tokB,
  });

  // Activity in tenant B: nothing reaches tenant A at all.
  await sendSyncWake(deps(), { tenantId: b.tenantId, opStoreId: b.storeId });
  expect(sentTokens()).toEqual([tokB]);

  // Activity in tenant A's OTHER store (store 2): the store-1 device receives nothing.
  port = new FakePushPort();
  await sendSyncWake(deps(), { tenantId: a1.tenantId, opStoreId: store2 });
  expect(sentTokens()).toEqual([tokA2]);
  expect(sentTokens()).not.toContain(tokA1);
});

test('sync targets in-scope devices, excludes live-connected devices, is data-only', async () => {
  const d1 = await h.seedDevice('sync-a');
  const d2 = await h.seedDeviceInTenant('sync-a2', { tenantId: d1.tenantId, storeId: d1.storeId });
  const t1 = expoToken('sync-a-tok');
  const t2 = expoToken('sync-a2-tok');
  await h.seedPushToken({ tenantId: d1.tenantId, deviceId: d1.deviceId, token: t1 });
  await h.seedPushToken({ tenantId: d1.tenantId, deviceId: d2.deviceId, token: t2 });

  // d2 holds a live realtime connection → excluded (the poke already covers it).
  const live: LiveConnectionRegistry = { isConnected: (id) => id === d2.deviceId };
  await sendSyncWake(deps({ liveConnections: live }), {
    tenantId: d1.tenantId,
    opStoreId: d1.storeId,
  });

  expect(sentTokens()).toEqual([t1]);
  // Data-only: no title/body/channelId on the wire.
  const sent = port.allSent[0]!;
  expect(sent.push).toEqual({ data: { category: 'sync' } });
});

test('sync coalesces to at most one push per device per 60s', async () => {
  const d1 = await h.seedDevice('coalesce');
  const t1 = expoToken('coalesce-tok');
  await h.seedPushToken({ tenantId: d1.tenantId, deviceId: d1.deviceId, token: t1 });
  const shared = deps({ coalescer: new InMemorySyncCoalescer() });
  h.clock.set(1_700_100_000_000);

  await sendSyncWake(shared, { tenantId: d1.tenantId, opStoreId: d1.storeId });
  h.clock.advance(30_000);
  await sendSyncWake(shared, { tenantId: d1.tenantId, opStoreId: d1.storeId }); // within 60s → coalesced
  expect(port.sends).toHaveLength(1);

  h.clock.advance(31_000); // now > 60s since the first send
  await sendSyncWake(shared, { tenantId: d1.tenantId, opStoreId: d1.storeId });
  expect(port.sends).toHaveLength(2);
});

test('conflict targets every active device of the conflict store; carries channelId + a conflicts deep link', async () => {
  const d1 = await h.seedDevice('conf');
  const d2 = await h.seedDeviceInTenant('conf2', { tenantId: d1.tenantId, storeId: d1.storeId });
  const other = await h.seedStore(d1.tenantId, 'conf-other');
  const dOther = await h.seedDeviceInTenant('conf-o', { tenantId: d1.tenantId, storeId: other });
  const t1 = expoToken('conf-a');
  const t2 = expoToken('conf-b');
  const tOther = expoToken('conf-o-tok');
  await h.seedPushToken({
    tenantId: d1.tenantId,
    deviceId: d1.deviceId,
    userId: d1.userId,
    token: t1,
  });
  await h.seedPushToken({
    tenantId: d1.tenantId,
    deviceId: d2.deviceId,
    userId: d2.userId,
    token: t2,
  });
  await h.seedPushToken({
    tenantId: d1.tenantId,
    deviceId: dOther.deviceId,
    userId: dOther.userId,
    token: tOther,
  });
  await h.seedUserPrefs({ userId: d1.userId, tenantId: d1.tenantId, locale: 'en' });
  const conflictId = await h.seedConflict({
    tenantId: d1.tenantId,
    storeId: d1.storeId,
    seed: 'c1',
  });

  await sendConflictSurfaced(deps(), {
    conflictId,
    tenantId: d1.tenantId,
    storeId: d1.storeId,
    category: 'conflict',
  });

  // Only the conflict store's two devices — NOT the other store's device.
  expect(sentTokens()).toEqual([t1, t2].sort());
  const forD1 = port.allSent.find((m) => m.to === t1)!;
  if (!('channelId' in forD1.push)) throw new Error('expected a visible push');
  expect(forD1.push.channelId).toBe('conflict');
  expect(forD1.push.data).toEqual({
    category: 'conflict',
    route: 'conflicts',
    params: { conflictId },
  });
});

test('device targets only registered users holding auth.device_read; a null-user device gets none', async () => {
  const owner = await h.seedDevice('dev-owner');
  const staff = await h.seedDeviceInTenant('dev-staff', {
    tenantId: owner.tenantId,
    storeId: owner.storeId,
  });
  const nulluser = await h.seedDeviceInTenant('dev-null', {
    tenantId: owner.tenantId,
    storeId: owner.storeId,
  });
  const tOwner = expoToken('dev-owner-tok');
  const tStaff = expoToken('dev-staff-tok');
  const tNull = expoToken('dev-null-tok');
  await h.seedPushToken({
    tenantId: owner.tenantId,
    deviceId: owner.deviceId,
    userId: owner.userId,
    token: tOwner,
  });
  await h.seedPushToken({
    tenantId: owner.tenantId,
    deviceId: staff.deviceId,
    userId: staff.userId,
    token: tStaff,
  });
  await h.seedPushToken({
    tenantId: owner.tenantId,
    deviceId: nulluser.deviceId,
    userId: null,
    token: tNull,
  });
  await h.grantDeviceRead({
    tenantId: owner.tenantId,
    userId: owner.userId,
    storeId: owner.storeId,
  });

  const aboutDeviceId = staff.deviceId;
  await sendDeviceAlert(deps(), { tenantId: owner.tenantId, aboutDeviceId });

  expect(sentTokens()).toEqual([tOwner]); // only the device_read holder
  const sent = port.allSent[0]!;
  if (!('channelId' in sent.push)) throw new Error('expected a visible push');
  expect(sent.push.channelId).toBe('device');
  expect(sent.push.data).toEqual({
    category: 'device',
    route: 'devices',
    params: { deviceId: aboutDeviceId },
  });
});

test('a revoked device / a device with no token receives nothing', async () => {
  const active = await h.seedDevice('rev-active');
  const revoked = await h.seedDeviceInTenant('rev-gone', {
    tenantId: active.tenantId,
    storeId: active.storeId,
  });
  const tokenless = await h.seedDeviceInTenant('rev-tokenless', {
    tenantId: active.tenantId,
    storeId: active.storeId,
  });
  const tActive = expoToken('rev-active-tok');
  await h.seedPushToken({ tenantId: active.tenantId, deviceId: active.deviceId, token: tActive });
  await h.seedPushToken({
    tenantId: active.tenantId,
    deviceId: revoked.deviceId,
    token: expoToken('rev-gone-tok'),
  });
  await h.revokeDevice(revoked.deviceId); // status → revoked
  expect(await h.countTokens(tokenless.deviceId)).toBe(0); // precondition: no push_tokens row

  await sendSyncWake(deps(), { tenantId: active.tenantId, opStoreId: active.storeId });
  expect(sentTokens()).toEqual([tActive]); // only the active, token-bearing device
});

test('DeviceNotRegistered in a TICKET deletes the row immediately (api/04-push §8)', async () => {
  const d = await h.seedDevice('dnr-ticket');
  const tok = expoToken('dnr-ticket-tok');
  await h.seedPushToken({ tenantId: d.tenantId, deviceId: d.deviceId, token: tok });
  port.ticketErrors.set(tok, 'DeviceNotRegistered');

  await sendSyncWake(deps(), { tenantId: d.tenantId, opStoreId: d.storeId });
  expect(await h.countTokens(d.deviceId)).toBe(0); // deleted right away
});

test('DeviceNotRegistered in a delayed RECEIPT deletes the row (≥15min, fake timers)', async () => {
  const d = await h.seedDevice('dnr-receipt');
  const tok = expoToken('dnr-receipt-tok');
  await h.seedPushToken({ tenantId: d.tenantId, deviceId: d.deviceId, token: tok });
  port.scriptReceiptError(tok, 'DeviceNotRegistered'); // the OK ticket's receipt reports it later

  await sendSyncWake(deps(), { tenantId: d.tenantId, opStoreId: d.storeId });
  expect(await h.countTokens(d.deviceId)).toBe(1); // ticket was OK — not yet deleted
  expect(scheduler.scheduled).toHaveLength(1);
  expect(scheduler.scheduled[0]!.delayMs).toBe(RECEIPT_POLL_DELAY_MS);

  await scheduler.runAll(); // the ≥15min poll fires
  expect(await h.countTokens(d.deviceId)).toBe(0);
});

test('a healthy send keeps the row and other per-message errors do NOT delete it', async () => {
  const d = await h.seedDevice('keep');
  const tok = expoToken('keep-tok');
  await h.seedPushToken({ tenantId: d.tenantId, deviceId: d.deviceId, token: tok });
  port.ticketErrors.set(tok, 'MessageTooBig'); // an error, but NOT DeviceNotRegistered

  await sendSyncWake(deps(), { tenantId: d.tenantId, opStoreId: d.storeId });
  expect(await h.countTokens(d.deviceId)).toBe(1); // row kept
});

test('a sender that throws never fails the trigger (fire-and-forget, post-commit)', async () => {
  const d = await h.seedDevice('throw');
  await h.seedPushToken({
    tenantId: d.tenantId,
    deviceId: d.deviceId,
    token: expoToken('throw-tok'),
  });
  port.throwOnNextSend = true;
  const logs: unknown[] = [];

  // Must RESOLVE, not reject — a push failure is never a sync error (api/04-push §6).
  await expect(
    sendSyncWake(deps({ logger: (e) => logs.push(e) }), {
      tenantId: d.tenantId,
      opStoreId: d.storeId,
    }),
  ).resolves.toBeUndefined();
  expect(logs).toEqual([expect.objectContaining({ kind: 'dispatch_failed', category: 'sync' })]);
});
