// Warranty claims through the real runtime: a new servisan that names the one it claims on, free
// while that one's warranty runs, an owner's call once it ended or when the customer pays, and
// never a claim on a claim. Also the counter's view of when a claim can start, and its intake.
import { afterEach, beforeAll, describe, expect, test } from 'vitest';

import { DomainError } from '@bolusi/core';
import { initI18n } from '@bolusi/i18n';

import idCatalog from '../repair/i18n/id.json' with { type: 'json' };
import enCatalog from '../repair/i18n/en.json' with { type: 'json' };
import { registerRepairCatalog } from '../src/repair/i18n.js';

import { DEFAULT_INTAKE_OPTIONS, warrantyUntil } from '../src/repair/intake-options.js';
import {
  claimIntakeDraft,
  claimWarrantyEnded,
  toOpenTicketInput,
  warrantyClaimAction,
} from '../src/repair/flows.js';

import {
  intake,
  openRepairHarness,
  paidHandover,
  type RepairHarness,
} from './support/repair-harness.js';
import { sampleTicket } from './support/repair-rows.js';

const DAY = 86_400_000;

beforeAll(() => {
  initI18n({ locale: 'id' });
  registerRepairCatalog({ id: idCatalog, en: enCatalog });
});

const open: RepairHarness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

async function harness(seed: number): Promise<RepairHarness> {
  const h = await openRepairHarness(seed);
  open.push(h);
  return h;
}

async function expectRefusal(p: Promise<unknown>, code: string, reason: string): Promise<void> {
  const err = await p.then(
    () => new Error(`expected ${code}, but the call resolved`),
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DomainError);
  expect((err as DomainError).code).toBe(code);
  expect(JSON.stringify(err)).toContain(reason);
}

async function ticket(h: RepairHarness, ticketId: string) {
  return (await h.query('getTicket', { ticketId }, h.cashierId)).rows[0];
}

/** A screen repair (30 days' warranty) that went home repaired. */
async function pickedUp(h: RepairHarness, repairTypes: string[] = ['screen']): Promise<string> {
  const ownershipVideo = repairTypes.includes('unlock') ? h.video(9) : null;
  const { ticketId } = (await h.run(
    'openTicket',
    intake(h, { repairTypes, ownershipVideo }),
    h.cashierId,
  )) as { ticketId: string };
  await h.run('startWork', { ticketId, beforePhotos: [h.photo(1)] }, h.technicianId);
  await h.run('markRepaired', { ticketId, afterPhotos: [h.photo(2)] }, h.technicianId);
  await h.run('returnDevice', (await paidHandover(h, ticketId, {}, [3, 4])) as never, h.cashierId);
  return ticketId;
}

async function claim(
  h: RepairHarness,
  original: string,
  userId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const row = await ticket(h, original);
  const { ticketId } = (await h.run(
    'openTicket',
    intake(h, {
      customer: { customerId: row.customerId },
      complaint: 'Layar berkedip lagi',
      quoteLines: [{ kind: 'labour', description: 'Klaim garansi', amount: 0 }],
      claimOf: original,
      ...overrides,
    }),
    userId,
  )) as { ticketId: string };
  return ticketId;
}

describe('opening a claim', () => {
  test('the counter opens a free claim while the warranty runs; both servisan link to each other', async () => {
    const h = await harness(6201);
    const original = await pickedUp(h);
    h.advance(29 * DAY);
    const claimId = await claim(h, original, h.cashierId);

    const opened = await ticket(h, claimId);
    expect(opened.claimOfTicketId).toBe(original);
    expect(opened.claimOf).toMatchObject({ id: original, repairTypes: [{ item: 'screen' }] });
    expect(opened.repairTypes).toEqual([]);
    expect(opened.quoteTotal).toBe(0);
    expect((await ticket(h, original)).claims).toEqual([
      { id: claimId, ticketNumber: opened.ticketNumber },
    ]);
  });

  test('once the warranty ended only an owner opens one', async () => {
    const h = await harness(6202);
    const original = await pickedUp(h);
    h.advance(31 * DAY);
    await expectRefusal(claim(h, original, h.cashierId), 'PERMISSION_DENIED', 'warrantyEnded');
    await claim(h, original, h.storeOwnerId);
  });

  test('a servisan whose types carry no warranty has none to claim on, except by an owner', async () => {
    const h = await harness(6203);
    const original = await pickedUp(h, ['unlock']);
    await expectRefusal(claim(h, original, h.cashierId), 'PERMISSION_DENIED', 'warrantyEnded');
    await claim(h, original, h.ownerId);
  });

  test('charging for a claim is an owner’s call, even while the warranty runs', async () => {
    const h = await harness(6204);
    const original = await pickedUp(h);
    const charged = {
      quoteLines: [{ kind: 'labour', description: 'Ganti konektor', amount: 50_000 }],
    };
    await expectRefusal(
      claim(h, original, h.cashierId, charged),
      'PERMISSION_DENIED',
      'claimChargeOwnerOnly',
    );
    await claim(h, original, h.storeOwnerId, charged);
  });

  test('only on a phone that went home repaired, never on a claim, and never with its own types', async () => {
    const h = await harness(6205);
    const { ticketId: inStore } = (await h.run(
      'openTicket',
      intake(h, { repairTypes: ['screen'] }),
      h.cashierId,
    )) as { ticketId: string };
    await expectRefusal(claim(h, inStore, h.ownerId), 'VALIDATION_FAILED', 'claimNotReturned');

    const original = await pickedUp(h);
    await expectRefusal(
      claim(h, original, h.cashierId, { repairTypes: ['battery'] }),
      'VALIDATION_FAILED',
      'claimWithTypes',
    );
    const first = await claim(h, original, h.cashierId);
    await h.run('startWork', { ticketId: first, beforePhotos: [h.photo(5)] }, h.technicianId);
    await h.run('markRepaired', { ticketId: first, afterPhotos: [h.photo(6)] }, h.technicianId);
    await h.run('returnDevice', (await paidHandover(h, first, {}, [7, 8])) as never, h.cashierId);
    await expectRefusal(claim(h, first, h.ownerId), 'VALIDATION_FAILED', 'claimOfClaim');
    // A second claim names the first servisan again, under the same warranty.
    await claim(h, original, h.cashierId);
    expect((await ticket(h, original)).claims).toHaveLength(2);
  });
});

describe('whose phone, and when', () => {
  test('only for the same customer and phone, whoever asks', async () => {
    const h = await harness(6208);
    const original = await pickedUp(h);
    const other = (await h.run(
      'registerCustomer',
      { name: 'Paulus Mote', phone: '0812-1111-2222' },
      h.cashierId,
    )) as { customerId: string };
    await expectRefusal(
      claim(h, original, h.ownerId, { customer: { customerId: other.customerId } }),
      'VALIDATION_FAILED',
      'claimOtherPhone',
    );
    const otherPhone = {
      brand: 'Samsung',
      model: 'Galaxy A14',
      color: 'Hitam',
      imei: '350000000000001',
    };
    await expectRefusal(
      claim(h, original, h.ownerId, { device: otherPhone }),
      'VALIDATION_FAILED',
      'claimOtherPhone',
    );
    // A phone whose IMEI was not written down can still be claimed on.
    await claim(h, original, h.cashierId, { device: { ...otherPhone, imei: '' } });
  });

  test('a claim signed before the phone went home is not covered', async () => {
    const h = await harness(6209);
    const original = await pickedUp(h);
    // A phone clock set back past the pickup.
    h.advance(-DAY);
    await expectRefusal(claim(h, original, h.cashierId), 'PERMISSION_DENIED', 'warrantyEnded');
  });

  test('cancelling a claim costs nothing unless the owner sets a fee', async () => {
    const h = await harness(6210);
    await h.run('setCancelFees', { beforeWork: 10_000, afterWork: 50_000 }, h.storeOwnerId);
    const free = await claim(h, await pickedUp(h), h.cashierId);
    await h.run('cancelTicket', { ticketId: free, reason: 'Tidak jadi' }, h.storeOwnerId);
    expect((await ticket(h, free)).cancelFee).toBe(0);
    expect((await ticket(h, free)).cancelStandardFee).toBe(0);
  });
});

describe('a claim once open', () => {
  test('a price rise needs an owner; a technician may still propose one', async () => {
    const h = await harness(6206);
    const claimId = await claim(h, await pickedUp(h), h.cashierId);
    const rise = {
      ticketId: claimId,
      kind: 'part',
      description: 'Konektor LCD',
      amount: 75_000,
      reason: 'Konektor ikut rusak',
    };
    await expectRefusal(
      h.run('changeQuote', { ...rise, customerAgreed: true }, h.cashierId),
      'PERMISSION_DENIED',
      'claimChargeOwnerOnly',
    );
    await h.run('proposeQuoteChange', rise, h.technicianId);
    await h.run('changeQuote', { ...rise, customerAgreed: true }, h.storeOwnerId);
    expect((await ticket(h, claimId)).quoteTotal).toBe(75_000);
  });

  test('gets no repair types of its own', async () => {
    const h = await harness(6207);
    const claimId = await claim(h, await pickedUp(h), h.cashierId);
    await expectRefusal(
      h.run('setRepairTypes', { ticketId: claimId, repairTypes: ['battery'] }, h.cashierId),
      'VALIDATION_FAILED',
      'claimWithTypes',
    );
  });
});

describe('the counter’s claim button and intake', () => {
  const returnedAt = Date.UTC(2026, 9, 1);
  const screen = { item: 'screen', label: null, warrantyDays: 30, needsVideo: false };
  const home = sampleTicket({
    outcome: 'repaired',
    location: 'returned',
    returnedAt,
    repairTypes: [screen],
  });
  const counter = { intake: true, warrantyException: false };
  const owner = { intake: true, warrantyException: true };

  test('free while the warranty runs, the owner’s after; never in the store or on a claim', () => {
    const until = warrantyUntil(home.repairTypes, returnedAt)!;
    expect(warrantyClaimAction(home, counter, until)).toBe('free');
    expect(warrantyClaimAction(home, counter, until + 1)).toBeNull();
    expect(warrantyClaimAction(home, owner, until + 1)).toBe('owner');
    expect(warrantyClaimAction({ ...home, location: 'in_store' }, owner, returnedAt)).toBeNull();
    expect(warrantyClaimAction({ ...home, outcome: 'cancelled' }, owner, returnedAt)).toBeNull();
    expect(warrantyClaimAction({ ...home, claimOfTicketId: 't0' }, owner, returnedAt)).toBeNull();
    expect(warrantyClaimAction(home, { intake: false, warrantyException: true }, returnedAt)).toBe(
      null,
    );
  });

  test('starts from the same customer and phone with a free line, and sends no types', () => {
    const draft = claimIntakeDraft(home, 'Klaim garansi');
    expect(draft.customer).toEqual({
      kind: 'existing',
      customerId: home.customerId,
      name: home.customerName,
      phone: home.customerPhone,
    });
    expect(draft.device).toMatchObject({ brand: 'Samsung', model: 'Galaxy A15' });
    expect(draft.complaint).toBe('');
    expect(draft.claimOf).toEqual({
      ticketId: home.id,
      ticketNumber: home.ticketNumber,
      warrantyUntil: returnedAt + 30 * DAY,
    });
    // Judged when shown: an intake kept past the warranty's last day says it ended.
    expect(claimWarrantyEnded(draft.claimOf!, returnedAt + 30 * DAY)).toBe(false);
    expect(claimWarrantyEnded(draft.claimOf!, returnedAt + 30 * DAY + 1)).toBe(true);
    const input = toOpenTicketInput(
      { ...draft, repairTypes: ['screen'] },
      DEFAULT_INTAKE_OPTIONS,
      returnedAt + DAY,
    );
    expect(input.claimOf).toBe(home.id);
    expect(input.repairTypes).toEqual([]);
    expect(input.quoteLines).toEqual([{ kind: 'labour', description: 'Klaim garansi', amount: 0 }]);
  });
});
