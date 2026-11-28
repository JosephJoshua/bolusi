// The world the QRIS integration tests run in (qris/service.ts over the real app and PostgreSQL):
// a tenant with two stores, a counter, a technician, two devices, a QRIS method and a servisan,
// with Xendit either faked at its port or the real test-mode API (xendit-live.test.ts).
import { base64ToBytes, operationFromSignedCoreJcs } from '@bolusi/core';
import { MONEY_OP } from '@bolusi/modules/money';
import type { SignedOperation } from '@bolusi/schemas';

import { serverCryptoPort } from '../../src/oplog/crypto.js';
import { createSecretSealer } from '../../src/qris/seal.js';
import type { QrisConfig } from '../../src/qris/service.js';
import type { XenditPort, XenditQrPayment } from '../../src/qris/xendit.js';
import { XenditRefusal } from '../../src/qris/xendit.js';
import { uuidv7 } from '../../src/uuidv7.js';
import {
  asPerson,
  makeIdentityHarness,
  provision,
  seedDevice,
  seedUser,
  type IdentityHarness,
} from './identity-app.js';

export const BASE = 'http://srv.test';
export const PUBLIC_URL = 'https://api.bolusi.test';
export const TEST_KEY = 'xnd_development_0123456789abcdefghij';
export const CALLBACK_TOKEN = 'cb-token-from-xendit';

/** Xendit, as far as Bolusi uses it: one account, QRs that a test marks paid. */
export class FakeXendit implements XenditPort {
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

  /** Payment reads per QR, to see who asked Xendit and how often. */
  readonly lists = new Map<string, number>();

  listQrPayments(key: string, qrId: string) {
    this.listKeys.push(key);
    this.lists.set(qrId, (this.lists.get(qrId) ?? 0) + 1);
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

export interface World<X extends XenditPort = FakeXendit> {
  readonly h: IdentityHarness;
  readonly xendit: X;
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

export async function makeQrisWorld<X extends XenditPort>(options: {
  readonly xendit: X;
  readonly qris?: boolean;
  /** The tenant's system key goes missing while this says so: no signer to record a payment. */
  readonly signerMissing?: () => boolean;
  /** Where Xendit is told to send webhooks; real Xendit refuses a `.test` host. */
  readonly publicUrl?: string;
}): Promise<World<X>> {
  const { xendit } = options;
  const signerMissing = options.signerMissing ?? (() => false);
  let systemKey: Uint8Array | null = null;
  const qris: QrisConfig = {
    sealer: createSecretSealer(Buffer.alloc(32, 7).toString('base64')),
    xendit,
    publicUrl: options.publicUrl ?? PUBLIC_URL,
  };
  const h = await makeIdentityHarness({
    deps: () => ({
      ...(options.qris === false ? {} : { qris }),
      systemKeyStore: {
        getSystemSigner: () =>
          systemKey === null || signerMissing()
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

/** The calls a test makes, against whichever world `current` returns now. */
export function qrisCalls(current: () => World<XenditPort>, secretKey = TEST_KEY) {
  const call = async function call(
    method: string,
    path: string,
    options: { token?: string; as?: string; body?: unknown; proven?: boolean } = {},
  ): Promise<Response> {
    const token = options.token ?? current().device;
    const as = options.as ?? current().cashierId;
    return Promise.resolve(
      current().h.app.request(`${BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          // The counter PC is shared: the server checked this person's PIN there.
          ...(options.proven === false
            ? { 'X-Acting-User': as }
            : await asPerson(current().h, token, as)),
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      }),
    );
  };

  const connect = (as = current().ownerId, key = secretKey) =>
    call('PUT', `/v1/money/qris/accounts/${current().accountId}`, { as, body: { secretKey: key } });

  function chargeBody(overrides: Record<string, unknown> = {}) {
    return {
      id: uuidv7(current().h.clock.now() + 10),
      accountId: current().accountId,
      document: { kind: 'repair.ticket', id: current().ticketId, label: 'TH0-0001' },
      amount: 150_000,
      ...overrides,
    };
  }

  function callback(chargeId: string, qrId: string, token = CALLBACK_TOKEN): Promise<Response> {
    return Promise.resolve(
      current().h.app.request(`${BASE}/xendit/qr/${current().tenantId}`, {
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
    const rows = await current()
      .h.idb.db.selectFrom('operations')
      .select(['signedCoreJcs', 'hash', 'signature'])
      .where('type', '=', MONEY_OP.paymentReceived)
      .execute();
    return rows.map((row) => operationFromSignedCoreJcs(row.signedCoreJcs, row));
  }

  async function errorCode(response: Response): Promise<string> {
    const body = (await response.json()) as { error?: { code?: string } };
    return body.error?.code ?? '';
  }

  return { call, connect, chargeBody, callback, paymentOps, errorCode };
}
