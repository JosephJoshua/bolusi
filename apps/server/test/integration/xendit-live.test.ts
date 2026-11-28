// QRIS against Xendit's real test mode, not a fake: the calls Bolusi makes (xendit.ts) and the whole
// server flow over them. Runs only where XENDIT_TEST_SECRET_KEY holds a test key (`xnd_development_`);
// skipped everywhere else, including CI. Test mode moves no money.
//
// It points the test account's QR webhook at XENDIT_QA_PUBLIC_URL (or a placeholder that never
// answers): the flow here is recorded by the server's own check and the counter's "paid yet?", so it
// does not need the webhook. A tunnel to a running server is how the webhook itself is tried.
import { QRIS_TTL_MS } from '@bolusi/schemas';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  XenditRefusal,
  createXenditClient,
  type XenditPort,
  type XenditQrPayment,
} from '../../src/qris/xendit.js';
import { uuidv7 } from '../../src/uuidv7.js';
import { makeQrisWorld, qrisCalls, type World } from '../helpers/qris-world.js';

const KEY = process.env['XENDIT_TEST_SECRET_KEY'] ?? '';
const LIVE = KEY.startsWith('xnd_development_');
const PUBLIC_URL = process.env['XENDIT_QA_PUBLIC_URL'] ?? 'https://bolusi-qa.invalid';

/** Xendit lists a simulated payment a moment after it is made. */
async function paymentsOf(
  xendit: XenditPort,
  qrId: string,
  until: (payments: readonly XenditQrPayment[]) => boolean,
): Promise<readonly XenditQrPayment[]> {
  for (let attempt = 0; ; attempt += 1) {
    const payments = await xendit.listQrPayments(KEY, qrId);
    if (until(payments) || attempt >= 15) return payments;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

describe.skipIf(!LIVE)('Xendit test mode, as Bolusi calls it', () => {
  const xendit = createXenditClient();
  const expiresAt = () => Date.now() + QRIS_TTL_MS;

  test('points the QR webhook here and gets a callback token, in test mode', async () => {
    const hook = await xendit.setQrWebhook(KEY, `${PUBLIC_URL}/xendit/qr/qa`);
    expect(hook.callbackToken).not.toBe('');
    expect(hook.environment).toBe('test');
  }, 60_000);

  test('a dynamic QR for an exact amount, paid once, listed as succeeded with its time', async () => {
    const qr = await xendit.createDynamicQr(KEY, {
      referenceId: uuidv7(Date.now()),
      amount: 15_000,
      expiresAt: expiresAt(),
    });
    expect(qr.qrId).not.toBe('');
    expect(qr.qrString).not.toBe('');
    expect(await xendit.listQrPayments(KEY, qr.qrId)).toEqual([]);
    const before = Date.now();
    await xendit.simulateQrPayment(KEY, qr.qrId, 15_000);
    const payments = await paymentsOf(xendit, qr.qrId, (list) => list.length > 0);
    expect(payments).toEqual([
      expect.objectContaining({ amount: 15_000, succeeded: true, paidAt: expect.any(Number) }),
    ]);
    expect(Math.abs(payments[0]!.paidAt! - before)).toBeLessThan(5 * 60_000);
  }, 90_000);

  // Test mode takes a QR below what QRIS allows (Rp 100 came back as a QR), so the server's own
  // QRIS_MIN_AMOUNT check is what keeps those out; only a wrong key is Xendit's to refuse here.
  test('a wrong key is refused as such', async () => {
    const wrongKey = await xendit
      .listQrPayments('xnd_development_not_a_real_key_0000000000', 'qr_x')
      .catch((error: unknown) => error);
    expect(wrongKey).toBeInstanceOf(XenditRefusal);
    expect((wrongKey as XenditRefusal).reason).toBe('keyInvalid');
  }, 60_000);
});

describe.skipIf(!LIVE)('the server’s QRIS flow over Xendit test mode', () => {
  let world: World<XenditPort>;
  const { call, connect, chargeBody, paymentOps } = qrisCalls(() => world, KEY);

  beforeEach(async () => {
    world = await makeQrisWorld({ xendit: createXenditClient(), publicUrl: PUBLIC_URL });
    // Xendit refuses a QR that expires in the past: the server's clock is the real one here.
    world.h.clock.set(Date.now());
    const connected = await connect();
    expect(connected.status).toBe(200);
  }, 120_000);

  afterEach(async () => {
    await world?.h.close();
  });

  const create = async (overrides: Record<string, unknown> = {}) => {
    const body = chargeBody({ id: uuidv7(Date.now()), amount: 15_000, ...overrides });
    const response = await call('POST', '/v1/money/qris/charges', { body });
    expect(response.status).toBe(200);
    return { body, charge: (await response.json()) as { id: string; status: string } };
  };
  const status = async (id: string) =>
    (await (await call('GET', `/v1/money/qris/charges/${id}`)).json()) as {
      status: string;
      cancelledAt: number | null;
    };
  /** Lets real time pass on the server's clock too, so its look at Xendit is due again. */
  const wait = async (ms: number) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    world.h.clock.set(Date.now());
  };

  test('the counter shows a QR, the customer pays it, and one payment is recorded', async () => {
    const { body, charge } = await create();
    expect(charge.status).toBe('waiting');
    const paid = await call('POST', `/v1/money/qris/charges/${body.id}/simulate`, {
      as: world.ownerId,
    });
    expect(paid.status).toBe(200);
    let seen = (await paid.json()) as { status: string };
    for (let attempt = 0; seen.status !== 'paid' && attempt < 10; attempt += 1) {
      await wait(5_000);
      seen = await status(body.id);
    }
    expect(seen.status).toBe('paid');
    const ops = await paymentOps();
    expect(ops).toHaveLength(1);
    expect(ops[0]!.payload).toMatchObject({
      amount: 15_000,
      reference: expect.stringMatching(/^test:/),
      provider: 'xendit',
    });
  }, 120_000);

  test('a QR paid after it was cancelled is still recorded by the server’s own check', async () => {
    const { body } = await create();
    const cancelled = await call('POST', `/v1/money/qris/charges/${body.id}/cancel`);
    expect(await cancelled.json()).toMatchObject({ status: 'cancelled' });
    // Another QR for the bill can be shown now.
    await create();
    const row = await world.h.idb.db
      .selectFrom('qrisCharges')
      .select('xenditQrId')
      .where('id', '=', body.id)
      .executeTakeFirstOrThrow();
    // The customer pays the cancelled one anyway: Xendit cannot withdraw it.
    await world.xendit.simulateQrPayment(KEY, row.xenditQrId, 15_000);
    let seen = await status(body.id);
    for (let attempt = 0; seen.status !== 'paid' && attempt < 10; attempt += 1) {
      await wait(21_000);
      await world.h.sweepQris();
      seen = await status(body.id);
    }
    expect(seen).toMatchObject({ status: 'paid', cancelledAt: expect.any(Number) });
    expect(await paymentOps()).toHaveLength(1);
  }, 300_000);
});
