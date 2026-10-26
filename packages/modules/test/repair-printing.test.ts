// Printing a servisan through the real runtime: the down payment taken at intake or later and an
// owner's correction, the print log that marks reprints, and each store's slip settings, also as
// folded on another device in the same store.
import { afterEach, describe, expect, test } from 'vitest';

import { DomainError } from '@bolusi/core';

import { REPAIR_OP } from '../src/repair/constants.js';

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
  test('taken at intake, it is recorded with who took it and survives sync', async () => {
    const h = await harness(6101);
    const ticketId = await openTicket(h, { downPayment: 200_000 });
    const t = await ticket(h, ticketId);
    expect(t.downPayment).toBe(200_000);
    expect(t.downPaymentBy).toBe(h.cashierId);
    expect(t.events.map((e: { kind: string }) => e.kind)).toContain(REPAIR_OP.downPaymentReceived);

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
  });

  test('the counter records one later, once; changing it is an owner correction with a reason', async () => {
    const h = await harness(6104);
    const ticketId = await openTicket(h);
    await h.run('recordDownPayment', { ticketId, amount: 100_000 }, h.cashierId);
    await expectCode(
      h.run('recordDownPayment', { ticketId, amount: 50_000 }, h.cashierId),
      'INVALID_TRANSITION',
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
    await h.run(
      'correctDownPayment',
      { ticketId, amount: 0, reason: 'Uang dikembalikan' },
      h.ownerId,
    );
    const t = await ticket(h, ticketId);
    expect(t.downPayment).toBeNull();
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
  });
});
