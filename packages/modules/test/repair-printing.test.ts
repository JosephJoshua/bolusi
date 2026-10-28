// Printing a servisan through the real runtime: the down payment taken at intake or later and an
// owner's correction, the print log that marks reprints, and each store's slip settings, also as
// folded on another device in the same store.
import { afterEach, describe, expect, test } from 'vitest';

import { DomainError } from '@bolusi/core';

import { intake, openRepairHarness, type RepairHarness } from './support/repair-harness.js';

const open: RepairHarness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

async function harness(seed: number): Promise<RepairHarness> {
  const h = await openRepairHarness(seed);
  open.push(h);
  return h;
}

async function peer(a: RepairHarness, seed: number): Promise<RepairHarness> {
  const b = await openRepairHarness(seed, {
    tenantId: a.tenantId,
    storeId: a.storeId,
    users: [a.cashierId, a.technicianId, a.technician2Id, a.zeroUserId, a.ownerId, a.storeOwnerId],
  });
  open.push(b);
  return b;
}

async function sync(from: RepairHarness, to: RepairHarness): Promise<void> {
  let seq = 1;
  for (const op of await from.ownOps()) await to.deliverPulled(op, seq++);
}

async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  const err = await p.then(
    () => new Error(`expected ${code}, but the call resolved`),
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DomainError);
  expect((err as DomainError).code).toBe(code);
}

async function openTicket(h: RepairHarness, overrides: Record<string, unknown> = {}) {
  const { ticketId } = (await h.run('openTicket', intake(h, overrides), h.cashierId)) as {
    ticketId: string;
  };
  return ticketId;
}

async function ticket(h: RepairHarness, ticketId: string) {
  return (await h.query('getTicket', { ticketId }, h.cashierId)).rows[0];
}

describe('down payment', () => {
  async function ledger(h: RepairHarness, ticketId: string) {
    return (
      await h.moneyQuery('documentMoney', { kind: 'repair.ticket', id: ticketId }, h.cashierId)
    ).rows[0] as {
      balance: number;
      entries: {
        kind: string;
        account: string;
        amount: number;
        createdBy: string;
        reference: string | null;
        voidedAt: number | null;
      }[];
    };
  }

  test('taken at intake, it is a payment in the money ledger, by its method, and survives sync', async () => {
    const h = await harness(6101);
    const { accountId } = (await h.money(
      'saveAccount',
      { kind: 'edc', name: 'EDC BRI' },
      h.storeOwnerId,
    )) as { accountId: string };
    const ticketId = await openTicket(h, {
      downPayment: 200_000,
      downPaymentAccount: `account:${accountId}`,
      downPaymentReference: '004512',
    });
    expect((await ticket(h, ticketId)).downPayment).toBe(200_000);
    expect((await ledger(h, ticketId)).entries).toMatchObject([
      {
        kind: 'payment_received',
        account: `account:${accountId}`,
        amount: 200_000,
        reference: '004512',
        createdBy: h.cashierId,
      },
    ]);
    // Paid ahead: nothing is owed yet.
    expect((await ledger(h, ticketId)).balance).toBe(-200_000);

    const b = await peer(h, 6102);
    await sync(h, b);
    expect((await ticket(b, ticketId)).downPayment).toBe(200_000);
  });

  test('no down payment records nothing, and one above the price is refused as a typo', async () => {
    const h = await harness(6103);
    const ticketId = await openTicket(h);
    expect((await ticket(h, ticketId)).downPayment).toBeNull();
    // The intake price is Rp 750.000.
    await expectCode(
      h.run('openTicket', intake(h, { downPayment: 7_500_000 }), h.cashierId),
      'VALIDATION_FAILED',
    );
    // An EDC payment needs its approval code.
    const { accountId } = (await h.money(
      'saveAccount',
      { kind: 'edc', name: 'EDC BRI' },
      h.storeOwnerId,
    )) as { accountId: string };
    await expectCode(
      h.run(
        'openTicket',
        intake(h, { downPayment: 100_000, downPaymentAccount: `account:${accountId}` }),
        h.cashierId,
      ),
      'VALIDATION_FAILED',
    );
  });

  test('the counter adds to it later; lowering it is an owner correction with a reason', async () => {
    const h = await harness(6104);
    const ticketId = await openTicket(h);
    await h.run('recordDownPayment', { ticketId, amount: 100_000 }, h.cashierId);
    await h.run('recordDownPayment', { ticketId, amount: 50_000 }, h.cashierId);
    expect((await ticket(h, ticketId)).downPayment).toBe(150_000);
    // Never above the price, together.
    await expectCode(
      h.run('recordDownPayment', { ticketId, amount: 650_000 }, h.cashierId),
      'VALIDATION_FAILED',
    );
    await expectCode(
      h.run('correctDownPayment', { ticketId, amount: 50_000, reason: 'Salah ketik' }, h.cashierId),
      'PERMISSION_DENIED',
    );
    await h.run(
      'correctDownPayment',
      { ticketId, amount: 50_000, reason: 'Salah ketik' },
      h.storeOwnerId,
    );
    expect((await ticket(h, ticketId)).downPayment).toBe(50_000);
    await expectCode(
      h.run('correctDownPayment', { ticketId, amount: 50_000, reason: 'Lagi' }, h.storeOwnerId),
      'VALIDATION_FAILED',
    );
    await h.run('correctDownPayment', { ticketId, amount: 0, reason: 'Salah catat' }, h.ownerId);
    expect((await ticket(h, ticketId)).downPayment).toBeNull();
    // The mistaken payments stay in the history, voided with the owner's reason.
    const entries = (await ledger(h, ticketId)).entries;
    expect(entries.every((entry) => entry.voidedAt !== null)).toBe(true);
    expect(entries).toHaveLength(3);
  });

  test('a cancelled servisan takes no new down payment', async () => {
    const h = await harness(6106);
    const ticketId = await openTicket(h);
    await h.run('cancelTicket', { ticketId, reason: 'Pelanggan batal', fee: 0 }, h.storeOwnerId);
    await expectCode(
      h.run('recordDownPayment', { ticketId, amount: 50_000 }, h.storeOwnerId),
      'INVALID_TRANSITION',
    );
    expect((await ticket(h, ticketId)).downPayment).toBeNull();
  });

  test('a technician cannot record one', async () => {
    const h = await harness(6105);
    const ticketId = await openTicket(h);
    await expectCode(
      h.run('recordDownPayment', { ticketId, amount: 10_000 }, h.technicianId),
      'PERMISSION_DENIED',
    );
  });
});

describe('print log', () => {
  test('each print is counted per slip, so the next one is a reprint', async () => {
    const h = await harness(6201);
    const ticketId = await openTicket(h);
    expect((await ticket(h, ticketId)).slipPrints).toEqual({ intake: 0, handover: 0 });
    await h.run('recordSlipPrinted', { ticketId, slip: 'intake' }, h.cashierId);
    await h.run('recordSlipPrinted', { ticketId, slip: 'intake' }, h.technicianId);
    expect((await ticket(h, ticketId)).slipPrints).toEqual({ intake: 2, handover: 0 });

    const b = await peer(h, 6202);
    await sync(h, b);
    expect((await ticket(b, ticketId)).slipPrints).toEqual({ intake: 2, handover: 0 });
  });

  test('the handover slip waits until the phone is ready to collect', async () => {
    const h = await harness(6203);
    const ticketId = await openTicket(h);
    await expectCode(
      h.run('recordSlipPrinted', { ticketId, slip: 'handover' }, h.cashierId),
      'INVALID_TRANSITION',
    );
    await h.run('cancelTicket', { ticketId, reason: 'Batal' }, h.storeOwnerId);
    await h.run('recordSlipPrinted', { ticketId, slip: 'handover' }, h.cashierId);
    expect((await ticket(h, ticketId)).slipPrints.handover).toBe(1);
  });
});

describe('store slip settings', () => {
  const SETTINGS = {
    name: '  Bolusi Cell Sorong ',
    address: 'Jl. Basuki Rahmat 12',
    phone: '0812-4800-1234',
    logo: null,
    logoOnDotMatrix: false,
    intakeTerms: 'Bawa nota ini.\nBiaya bisa berubah.',
    handoverTerms: '   ',
  };

  test('a store that set nothing prints its own name and the default terms', async () => {
    const h = await harness(6301);
    expect((await h.query('printSettings', {}, h.cashierId)).rows[0]).toEqual({
      name: null,
      address: '',
      phone: '',
      logo: null,
      logoOnDotMatrix: false,
      intakeTerms: null,
      handoverTerms: null,
    });
  });

  test('owners save them, trimmed, blank terms meaning the defaults; the counter cannot', async () => {
    const h = await harness(6302);
    await expectCode(h.run('setPrintSettings', SETTINGS, h.cashierId), 'PERMISSION_DENIED');
    await h.run('setPrintSettings', SETTINGS, h.storeOwnerId);
    const expected = {
      name: 'Bolusi Cell Sorong',
      address: 'Jl. Basuki Rahmat 12',
      phone: '0812-4800-1234',
      logo: null,
      logoOnDotMatrix: false,
      intakeTerms: 'Bawa nota ini.\nBiaya bisa berubah.',
      handoverTerms: null,
    };
    expect((await h.query('printSettings', {}, h.cashierId)).rows[0]).toEqual(expected);
    await expectCode(h.run('setPrintSettings', SETTINGS, h.storeOwnerId), 'VALIDATION_FAILED');

    const withLogo = { ...SETTINGS, logo: h.photo(9), logoOnDotMatrix: true };
    await h.run('setPrintSettings', withLogo, h.ownerId);
    const b = await peer(h, 6303);
    await sync(h, b);
    const synced = (await b.query('printSettings', {}, b.cashierId)).rows[0];
    expect(synced.logo).toEqual({
      mediaId: withLogo.logo.mediaId,
      sha256: withLogo.logo.sha256,
      mime: withLogo.logo.mime,
    });
    expect(synced.logoOnDotMatrix).toBe(true);

    // Changing the terms without the logo's ref keeps the logo; null removes it.
    const { logo, ...withoutLogo } = withLogo;
    await h.run(
      'setPrintSettings',
      { ...withoutLogo, handoverTerms: 'Garansi 7 hari.' },
      h.ownerId,
    );
    const kept = (await h.query('printSettings', {}, h.cashierId)).rows[0];
    expect(kept.logo?.mediaId).toBe(logo.mediaId);
    expect(kept.handoverTerms).toBe('Garansi 7 hari.');
    await h.run('setPrintSettings', { ...withoutLogo, logo: null }, h.ownerId);
    expect((await h.query('printSettings', {}, h.cashierId)).rows[0].logo).toBeNull();
  });
});
