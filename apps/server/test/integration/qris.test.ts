// Integrated QRIS through Xendit (qris/service.ts) over the real app and PostgreSQL, with Xendit
// faked at its port: connecting an account, making a QR, and a confirmed payment becoming a money
// record signed by the tenant's system device, exactly once.
import { base64ToBytes, operationFromSignedCoreJcs, verifyOp } from '@bolusi/core';
import { MONEY_OP } from '@bolusi/modules/money';
import type { SignedOperation } from '@bolusi/schemas';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { serverCryptoPort } from '../../src/oplog/crypto.js';
import { createSecretSealer } from '../../src/qris/seal.js';
import type { QrisConfig } from '../../src/qris/service.js';
import type { XenditPort, XenditQrPayment } from '../../src/qris/xendit.js';
import { XenditRefusal } from '../../src/qris/xendit.js';
import { uuidv7 } from '../../src/uuidv7.js';
import {
  makeIdentityHarness,
  provision,
  seedDevice,
  seedUser,
  type IdentityHarness,
} from '../helpers/identity-app.js';

const BASE = 'http://srv.test';
const PUBLIC_URL = 'https://api.bolusi.test';
const TEST_KEY = 'xnd_development_0123456789abcdefghij';
const CALLBACK_TOKEN = 'cb-token-from-xendit';

/** Xendit, as far as Bolusi uses it: one account, QRs that a test marks paid. */
class FakeXendit implements XenditPort {
  readonly webhooks: { key: string; url: string }[] = [];
  readonly qrs = new Map<
    string,
    { referenceId: string; amount: number; payments: XenditQrPayment[] }
  >();
  created = 0;
  /** The key each payments read was made with. */
  readonly listKeys: string[] = [];
  down = false;
  /** An owner regenerated the account's callback token in Xendit. */
  rotated = '';

  setQrWebhook(secretKey: string, url: string) {
    if (!secretKey.startsWith('xnd_')) return Promise.reject(new XenditRefusal('keyInvalid'));
    this.webhooks.push({ key: secretKey, url });
    // Each Xendit account has its own token; the test key's is CALLBACK_TOKEN until rotated.
    const callbackToken =
      secretKey === TEST_KEY ? `${CALLBACK_TOKEN}${this.rotated}` : `token-of-${secretKey}`;
    return Promise.resolve({ callbackToken, environment: 'test' as const });
  }

  createDynamicQr(_key: string, input: { referenceId: string; amount: number }) {
    this.created += 1;
    const qrId = `qr_${String(this.created)}`;
    this.qrs.set(qrId, { referenceId: input.referenceId, amount: input.amount, payments: [] });
    return Promise.resolve({ qrId, qrString: `qr-string-${String(this.created)}` });
  }

  listQrPayments(key: string, qrId: string) {
    this.listKeys.push(key);
    if (this.down) return Promise.reject(new XenditRefusal('notFound'));
    return Promise.resolve(this.qrs.get(qrId)?.payments ?? []);
  }

  simulateQrPayment(_key: string, qrId: string, amount: number) {
    this.pay(qrId, amount);
    return Promise.resolve();
  }

  pay(qrId: string, amount?: number, paidAt: number | null = null) {
    const qr = this.qrs.get(qrId);
    if (qr === undefined) throw new Error(`no ${qrId}`);
    qr.payments.push({
      paymentId: `qrpy_${qrId}`,
      amount: amount ?? qr.amount,
      succeeded: true,
      paidAt,
    });
  }
}

interface World {
  readonly h: IdentityHarness;
  readonly xendit: FakeXendit;
  readonly tenantId: string;
  readonly storeId: string;
  readonly otherStoreId: string;
  readonly ownerId: string;
  readonly cashierId: string;
  readonly technicianId: string;
  readonly systemDeviceId: string;
  readonly device: string;
  readonly otherDevice: string;
  readonly accountId: string;
  readonly ticketId: string;
  readonly systemPublicKey: Uint8Array;
}

let world: World;
/** The tenant's system key goes missing: no signer to record a payment with. */
let signerMissing = false;

async function makeWorld(options: { qris?: boolean } = {}): Promise<World> {
  const xendit = new FakeXendit();
  let systemKey: Uint8Array | null = null;
  const qris: QrisConfig = {
    sealer: createSecretSealer(Buffer.alloc(32, 7).toString('base64')),
    xendit,
    publicUrl: PUBLIC_URL,
  };
  const h = await makeIdentityHarness({
    deps: () => ({
      ...(options.qris === false ? {} : { qris }),
      systemKeyStore: {
        getSystemSigner: () =>
          systemKey === null || signerMissing
            ? undefined
            : (hash) => serverCryptoPort.sign(hash, systemKey!),
      },
    }),
  });
  const p = await provision(h, {
    tenantName: 'Bolusi',
    storeNames: ['Toko Utama', 'Toko Abepura'],
    ownerName: 'Owner',
    ownerLogin: 'owner@bolusi.test',
  });
  systemKey = base64ToBytes(p.systemDevicePrivateKeyB64);
  const [storeId, otherStoreId] = p.storeIds as [string, string];
  const cashierId = await seedUser(h, {
    tenantId: p.tenantId,
    name: 'Kasir',
    storeIds: [storeId],
    roleKeys: ['cashier'],
  });
  const technicianId = await seedUser(h, {
    tenantId: p.tenantId,
    name: 'Teknisi',
    storeIds: [storeId],
    roleKeys: ['technician'],
  });
  const device = await seedDevice(h, { tenantId: p.tenantId, storeId });
  const otherDevice = await seedDevice(h, { tenantId: p.tenantId, storeId: otherStoreId });

  const accountId = uuidv7(h.clock.now());
  const at = BigInt(h.clock.now());
  await h.idb.db
    .insertInto('moneyAccounts')
    .values({
      id: accountId,
      tenantId: p.tenantId,
      storeId,
      kind: 'qris',
      name: 'QRIS Toko',
      active: 1,
      storeIdsJson: null,
      createdAt: at,
      updatedBy: p.ownerUserId,
      updatedAt: at,
    })
    .execute();
  const ticketId = uuidv7(h.clock.now() + 1);
  await h.idb.db
    .insertInto('repairTickets')
    .values({
      id: ticketId,
      tenantId: p.tenantId,
      storeId,
      ticketNumber: 'TH0-0001',
      customerId: uuidv7(h.clock.now() + 2),
      deviceBrand: 'Samsung',
      deviceModel: 'A15',
      deviceColor: 'Hitam',
      complaint: 'Layar pecah',
      intakeNotes: '',
      checklistJson: '[]',
      peripheralsJson: '[]',
      location: 'counter',
      outcome: 'repaired',
      quoteTotal: 150_000,
      createdBy: p.ownerUserId,
      createdAt: at,
      updatedAt: at,
    })
    .execute();

  const system = await h.idb.db
    .selectFrom('devices')
    .select('signingKeyPublic')
    .where('id', '=', p.systemDeviceId)
    .executeTakeFirstOrThrow();
  return {
    h,
    xendit,
    tenantId: p.tenantId,
    storeId,
    otherStoreId,
    ownerId: p.ownerUserId,
    cashierId,
    technicianId,
    systemDeviceId: p.systemDeviceId,
    device: device.token,
    otherDevice: otherDevice.token,
    accountId,
    ticketId,
    systemPublicKey: base64ToBytes(system.signingKeyPublic),
  };
}

beforeEach(async () => {
  signerMissing = false;
  world = await makeWorld();
}, 120_000);

afterEach(async () => {
  await world?.h.close();
});

function call(
  method: string,
  path: string,
  options: { token?: string; as?: string; body?: unknown } = {},
): Promise<Response> {
  return Promise.resolve(
    world.h.app.request(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${options.token ?? world.device}`,
        'X-Acting-User': options.as ?? world.cashierId,
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  );
}

const connect = (as = world.ownerId, secretKey = TEST_KEY) =>
  call('PUT', `/v1/money/qris/accounts/${world.accountId}`, { as, body: { secretKey } });

function chargeBody(overrides: Record<string, unknown> = {}) {
  return {
    id: uuidv7(world.h.clock.now() + 10),
    accountId: world.accountId,
    document: { kind: 'repair.ticket', id: world.ticketId, label: 'TH0-0001' },
    amount: 150_000,
    ...overrides,
  };
}

function callback(chargeId: string, qrId: string, token = CALLBACK_TOKEN): Promise<Response> {
  return Promise.resolve(
    world.h.app.request(`${BASE}/xendit/qr/${world.tenantId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-callback-token': token },
      body: JSON.stringify({
        event: 'qr.payment',
        data: { id: `qrpy_${qrId}`, qr_id: qrId, reference_id: chargeId, status: 'SUCCEEDED' },
      }),
    }),
  );
}

async function paymentOps(): Promise<SignedOperation[]> {
  const rows = await world.h.idb.db
    .selectFrom('operations')
    .select(['signedCoreJcs', 'hash', 'signature'])
    .where('type', '=', MONEY_OP.paymentReceived)
    .execute();
  return rows.map((row) => operationFromSignedCoreJcs(row.signedCoreJcs, row));
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error?: { code?: string } };
  return body.error?.code ?? '';
}

describe('connecting a QRIS account', () => {
  test('an owner connects it: the webhook points here and the key is kept sealed', async () => {
    const response = await connect();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      accountId: world.accountId,
      environment: 'test',
    });
    expect(world.xendit.webhooks).toEqual([
      { key: TEST_KEY, url: `${PUBLIC_URL}/xendit/qr/${world.tenantId}` },
    ]);
    const row = await world.h.idb.db
      .selectFrom('qrisConnections')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(row.secretSealed).not.toContain(TEST_KEY);
    expect(row.callbackTokenHash).not.toContain(CALLBACK_TOKEN);

    const listed = await call('GET', '/v1/money/qris/accounts');
    expect(await listed.json()).toMatchObject({
      connections: [{ accountId: world.accountId, environment: 'test' }],
    });
  });

  test('the counter cannot connect one', async () => {
    expect((await connect(world.cashierId)).status).toBe(403);
    expect(world.xendit.webhooks).toEqual([]);
  });

  test('a key Xendit refuses is said so, and nothing is kept', async () => {
    const response = await connect(world.ownerId, 'not-a-xendit-key-at-all-0000');
    expect(response.status).toBe(422);
    expect(await errorCode(response)).toBe('QRIS_KEY_REFUSED');
    const rows = await world.h.idb.db.selectFrom('qrisConnections').selectAll().execute();
    expect(rows).toEqual([]);
  });

  test('another store cannot see or connect this store’s account', async () => {
    await connect();
    const listed = await call('GET', '/v1/money/qris/accounts', {
      token: world.otherDevice,
      as: world.ownerId,
    });
    expect(await listed.json()).toEqual({ connections: [] });
    const other = await call('PUT', `/v1/money/qris/accounts/${world.accountId}`, {
      token: world.otherDevice,
      as: world.ownerId,
      body: { secretKey: TEST_KEY },
    });
    expect(other.status).toBe(404);
  });

  test('disconnecting stops new QRs, and a QR already shown is still recorded', async () => {
    await connect();
    const shown = chargeBody();
    expect((await call('POST', '/v1/money/qris/charges', { body: shown })).status).toBe(200);
    const response = await call('DELETE', `/v1/money/qris/accounts/${world.accountId}`, {
      as: world.ownerId,
    });
    expect(response.status).toBe(204);
    const listed = await call('GET', '/v1/money/qris/accounts');
    expect(await listed.json()).toEqual({ connections: [] });
    const another = await call('POST', '/v1/money/qris/charges', {
      body: chargeBody({ id: uuidv7(world.h.clock.now() + 99) }),
    });
    expect(await errorCode(another)).toBe('QRIS_NOT_CONNECTED');

    world.xendit.pay('qr_1');
    expect((await callback(shown.id, 'qr_1')).status).toBe(200);
    expect(await paymentOps()).toHaveLength(1);
  });
});

describe('a QR for a payment', () => {
  beforeEach(async () => {
    expect((await connect()).status).toBe(200);
  });

  test('the counter gets a QR, and asking again with the same id gives the same one', async () => {
    const body = chargeBody();
    const first = await call('POST', '/v1/money/qris/charges', { body });
    expect(first.status).toBe(200);
    const charge = (await first.json()) as Record<string, unknown>;
    expect(charge).toMatchObject({
      id: body.id,
      status: 'waiting',
      amount: 150_000,
      qrString: 'qr-string-1',
      environment: 'test',
    });
    const again = await call('POST', '/v1/money/qris/charges', { body });
    expect(await again.json()).toEqual(charge);
    expect(world.xendit.created).toBe(1);

    const changed = await call('POST', '/v1/money/qris/charges', {
      body: { ...body, amount: 100_000 },
    });
    expect(changed.status).toBe(409);
  });

  test('someone who cannot take payments gets no QR', async () => {
    const response = await call('POST', '/v1/money/qris/charges', {
      as: world.technicianId,
      body: chargeBody(),
    });
    expect(response.status).toBe(403);
    expect(world.xendit.created).toBe(0);
  });

  test('the payment rule is checked first: a servisan of another store is refused', async () => {
    const response = await call('POST', '/v1/money/qris/charges', {
      body: chargeBody({ document: { kind: 'repair.ticket', id: uuidv7(1), label: 'X' } }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: 'CHANGE_REFUSED', details: { reason: 'money.refusal.documentNotFound' } },
    });
    expect(world.xendit.created).toBe(0);
  });

  test('no QR is shown when the server could not record its payment', async () => {
    signerMissing = true;
    const response = await call('POST', '/v1/money/qris/charges', { body: chargeBody() });
    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe('QRIS_UNAVAILABLE');
    expect(world.xendit.created).toBe(0);
  });

  test('a charge is only seen from its own store', async () => {
    const body = chargeBody();
    await call('POST', '/v1/money/qris/charges', { body });
    const elsewhere = await call('GET', `/v1/money/qris/charges/${body.id}`, {
      token: world.otherDevice,
      as: world.ownerId,
    });
    expect(elsewhere.status).toBe(404);
  });
});

describe('recording the payment', () => {
  let chargeId: string;

  beforeEach(async () => {
    expect((await connect()).status).toBe(200);
    const body = chargeBody();
    chargeId = body.id;
    expect((await call('POST', '/v1/money/qris/charges', { body })).status).toBe(200);
  });

  test('a confirmed payment becomes one money record signed by the system device', async () => {
    world.xendit.pay('qr_1');
    expect((await callback(chargeId, 'qr_1')).status).toBe(200);
    // Xendit calls back again (it retries): still one payment.
    expect((await callback(chargeId, 'qr_1')).status).toBe(200);

    const ops = await paymentOps();
    expect(ops).toHaveLength(1);
    const [op] = ops as [SignedOperation];
    expect(op).toMatchObject({
      deviceId: world.systemDeviceId,
      storeId: world.storeId,
      entityId: chargeId,
      source: 'system',
      payload: {
        document: { kind: 'repair.ticket', id: world.ticketId, label: 'TH0-0001' },
        account: `account:${world.accountId}`,
        amount: 150_000,
        // A test-mode payment says so.
        reference: 'test:qrpy_qr_1',
        tendered: null,
      },
    });
    expect(verifyOp(op, world.systemPublicKey, serverCryptoPort)).toBe(true);

    const entry = await world.h.idb.db
      .selectFrom('moneyEntries')
      .select(['kind', 'amount', 'documentId'])
      .where('id', '=', chargeId)
      .executeTakeFirstOrThrow();
    expect(entry).toEqual({
      kind: 'payment_received',
      amount: '150000',
      documentId: world.ticketId,
    });
    expect(world.h.pokes).toContainEqual({ tenantId: world.tenantId, storeId: world.storeId });

    const status = await call('GET', `/v1/money/qris/charges/${chargeId}`);
    expect(await status.json()).toMatchObject({ status: 'paid' });
  });

  test('a callback is not believed until Xendit shows the payment, and Xendit is asked to retry', async () => {
    expect((await callback(chargeId, 'qr_1')).status).toBe(503);
    expect(await paymentOps()).toEqual([]);
    world.xendit.pay('qr_1');
    expect((await callback(chargeId, 'qr_1')).status).toBe(200);
    expect(await paymentOps()).toHaveLength(1);
  });

  test('the payment carries the time the customer paid, not the time it was confirmed', async () => {
    const paidAt = world.h.clock.now() + 60_000;
    world.xendit.pay('qr_1', undefined, paidAt);
    world.h.clock.advance(3 * 60 * 60 * 1000);
    expect((await callback(chargeId, 'qr_1')).status).toBe(200);
    const [op] = (await paymentOps()) as [SignedOperation];
    expect(op.timestamp).toBe(paidAt);
  });

  test('a callback and a device asking at the same moment still record one payment', async () => {
    world.xendit.pay('qr_1');
    const results = await Promise.all([
      callback(chargeId, 'qr_1'),
      call('GET', `/v1/money/qris/charges/${chargeId}`),
      callback(chargeId, 'qr_1'),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(await paymentOps()).toHaveLength(1);
  });

  test('a callback token rotated in Xendit (and reconnected) is still accepted for a QR shown before', async () => {
    world.xendit.rotated = '-new';
    expect((await connect()).status).toBe(200);
    world.xendit.pay('qr_1');
    expect((await callback(chargeId, 'qr_1', `${CALLBACK_TOKEN}-new`)).status).toBe(200);
    expect(await paymentOps()).toHaveLength(1);
  });

  test('a callback without a body, or for a QR this server did not make, is let go', async () => {
    const empty = await world.h.app.request(`${BASE}/xendit/qr/${world.tenantId}`, {
      method: 'POST',
      headers: { 'x-callback-token': CALLBACK_TOKEN },
    });
    expect(empty.status).toBe(200);
    expect((await callback(chargeId, 'qr_elsewhere')).status).toBe(200);
    expect(await paymentOps()).toEqual([]);
  });

  test('reconnecting the account to another Xendit account still records a QR already shown', async () => {
    expect((await connect(world.ownerId, 'xnd_development_another_account_key')).status).toBe(200);
    world.xendit.pay('qr_1');
    expect((await callback(chargeId, 'qr_1')).status).toBe(200);
    expect(await paymentOps()).toHaveLength(1);
    expect(world.xendit.listKeys).toEqual([TEST_KEY]);
  });

  test('a wrong callback token records nothing', async () => {
    world.xendit.pay('qr_1');
    expect((await callback(chargeId, 'qr_1', 'guessed')).status).toBe(401);
    expect(await paymentOps()).toEqual([]);
  });

  test('when Xendit cannot be asked, the callback is answered 503 so Xendit retries', async () => {
    world.xendit.pay('qr_1');
    world.xendit.down = true;
    expect((await callback(chargeId, 'qr_1')).status).toBe(503);
    expect(await paymentOps()).toEqual([]);
  });

  test('with no callback at all, the device asking finds the payment', async () => {
    const waiting = await call('GET', `/v1/money/qris/charges/${chargeId}`);
    expect(await waiting.json()).toMatchObject({ status: 'waiting' });
    world.xendit.pay('qr_1');
    // Asked again at once: Xendit is not asked again yet.
    const soon = await call('GET', `/v1/money/qris/charges/${chargeId}`);
    expect(await soon.json()).toMatchObject({ status: 'waiting' });
    world.h.clock.advance(5_000);
    const later = await call('GET', `/v1/money/qris/charges/${chargeId}`);
    expect(await later.json()).toMatchObject({ status: 'paid' });
    expect(await paymentOps()).toHaveLength(1);
  });

  test('in test mode an owner can have Xendit pay a QR, and the counter cannot', async () => {
    const counter = await call('POST', `/v1/money/qris/charges/${chargeId}/simulate`);
    expect(counter.status).toBe(403);
    const response = await call('POST', `/v1/money/qris/charges/${chargeId}/simulate`, {
      as: world.ownerId,
    });
    expect(await response.json()).toMatchObject({ status: 'paid' });
    expect(await paymentOps()).toHaveLength(1);
  });

  test('someone who cannot take payments cannot follow a charge', async () => {
    const response = await call('GET', `/v1/money/qris/charges/${chargeId}`, {
      as: world.technicianId,
    });
    expect(response.status).toBe(403);
  });

  test('a QR expires after fifteen minutes', async () => {
    world.h.clock.advance(15 * 60 * 1000 + 1);
    const response = await call('GET', `/v1/money/qris/charges/${chargeId}`);
    expect(await response.json()).toMatchObject({ status: 'expired' });
  });
});

test('without the deployment set up for it, QRIS through Xendit is unavailable', async () => {
  await world.h.close();
  world = await makeWorld({ qris: false });
  const response = await connect();
  expect(response.status).toBe(503);
  expect(await errorCode(response)).toBe('QRIS_UNAVAILABLE');
}, 120_000);
