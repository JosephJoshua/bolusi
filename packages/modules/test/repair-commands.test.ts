// The repair ticket journey through the real runtime: intake, queue, work, price changes, cancel
// and handover — plus the permission split and the transitions a device must refuse.
import { sql } from 'kysely';
import { afterEach, describe, expect, test } from 'vitest';

import { DomainError, refusalKeyOf } from '@bolusi/core';

import { HANDOVER_UNDO_WINDOW_MS, REPAIR_OP } from '../src/repair/constants.js';
import { REPAIR_DOCUMENT_KIND } from '../src/repair/money-document.js';
import { maxTicketCounter } from '../src/repair/queries.js';

import {
  accessoriesBack,
  openRepairHarness,
  intake,
  paidHandover,
  type RepairHarness,
} from './support/repair-harness.js';

let h: RepairHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

async function expectCode(p: Promise<unknown>, code: string, refusal?: string): Promise<void> {
  const err = await p.then(
    () => new Error(`expected ${code}, but the call resolved`),
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DomainError);
  expect((err as DomainError).code).toBe(code);
  // The reason the phone shows, from the type's declared refusals.
  if (refusal !== undefined) expect(refusalKeyOf(err)).toBe(`repair.refusal.${refusal}`);
}

interface Opened {
  ticketId: string;
  ticketNumber: string;
  customerId: string;
}

async function open(
  harness: RepairHarness,
  overrides: Record<string, unknown> = {},
  userId = harness.cashierId,
) {
  return (await harness.run('openTicket', intake(harness, overrides), userId)) as Opened;
}

async function ticket(harness: RepairHarness, ticketId: string, userId = harness.cashierId) {
  return (await harness.query('getTicket', { ticketId }, userId)).rows[0];
}

describe('intake', () => {
  test('opening the same intake id twice returns the first ticket and writes nothing new', async () => {
    h = await openRepairHarness(41);
    const ticketId = '01920000-0000-7000-8000-00000000a141';
    const first = await open(h, { ticketId });
    expect(first.ticketId).toBe(ticketId);
    const countOps = async () =>
      Number(
        (await sql<{ c: number }>`SELECT COUNT(*) AS c FROM operations`.execute(h!.db)).rows[0]!.c,
      );
    const before = await countOps();

    // A draft restored after the app died mid-submit, sent again (even with other answers).
    const again = await open(h, { ticketId, complaint: 'Baterai bocor' });
    expect(again).toEqual(first);
    expect(await countOps()).toBe(before);
    const tickets = await h.query('listTickets', {}, h.cashierId);
    expect(tickets.rows.filter((row: { id: string }) => row.id === ticketId)).toHaveLength(1);
    expect((await ticket(h, ticketId)).complaint).not.toBe('Baterai bocor');
  });

  test('openTicket registers the customer, numbers the ticket and records the quote and photos', async () => {
    h = await openRepairHarness(1);
    const first = await open(h);
    const second = await open(h, { customer: { customerId: first.customerId } });

    expect(first.ticketNumber).toMatch(/^[0-9A-Z]{3}-0001$/);
    expect(second.ticketNumber).toBe(first.ticketNumber.replace('0001', '0002'));
    expect(second.customerId).toBe(first.customerId);

    const t = await ticket(h, first.ticketId);
    expect(t).toMatchObject({
      customerName: 'Yohanis Wenda',
      customerPhone: '081244556677',
      deviceModel: 'Galaxy A14',
      outcome: 'received',
      location: 'in_store',
      technicianId: null,
      quoteTotal: 750_000,
      pendingProposals: 0,
      peripherals: [
        { item: 'charger', label: null },
        { item: 'case', label: null },
      ],
    });
    expect(t.quoteLines.map((l: { status: string }) => l.status)).toEqual(['intake', 'intake']);
    expect(t.photos.map((p: { slot: string }) => p.slot).sort()).toEqual([
      'back',
      'bottom',
      'front',
      'left',
      'right',
      'top',
    ]);
    expect(t.events.map((e: { kind: string }) => e.kind)).toEqual(['repair.ticket_opened']);
    expect(t.createdBy).toBe(h.cashierId);
  });

  test('a ticket missing a photo angle the store asks for is refused before anything is written', async () => {
    h = await openRepairHarness(2);
    const input = intake(h);
    const fivePhotos = input.photos.filter((p) => p.slot !== 'bottom');
    await expectCode(
      h.run('openTicket', { ...input, photos: fivePhotos }, h.cashierId),
      'VALIDATION_FAILED',
    );
    const count = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM repair_tickets`.execute(h.db);
    expect(count.rows[0]!.n).toBe(0);
  });

  test('a ticket needs at least one price line, and line signs are checked', async () => {
    h = await openRepairHarness(3);
    await expectCode(open(h, { quoteLines: [] }), 'VALIDATION_FAILED');
    await expectCode(
      open(
        h,
        { quoteLines: [{ kind: 'discount', description: 'Diskon', amount: 50_000 }] },
        h.storeOwnerId,
      ),
      'VALIDATION_FAILED',
    );
    await expectCode(
      open(h, { quoteLines: [{ kind: 'part', description: 'LCD', amount: -1 }] }),
      'VALIDATION_FAILED',
    );
  });

  test('the price can come down to nothing but never below zero', async () => {
    h = await openRepairHarness(31);
    await expectCode(
      open(
        h,
        { quoteLines: [{ kind: 'discount', description: 'Diskon', amount: -1 }] },
        h.storeOwnerId,
      ),
      'VALIDATION_FAILED',
    );
    const { ticketId } = await open(h, {
      quoteLines: [{ kind: 'labour', description: 'Cek mesin', amount: 100_000 }],
    });
    const discount = (amount: number) => ({
      ticketId,
      kind: 'discount',
      description: 'Diskon',
      amount,
      reason: 'Gratis',
      customerAgreed: true,
    });
    await expectCode(h.run('changeQuote', discount(-100_001), h.storeOwnerId), 'VALIDATION_FAILED');
    // Only an owner may propose a discount; the main owner also holds the technician's permission.
    const propose = (amount: number) =>
      h!.run(
        'proposeQuoteChange',
        { ticketId, kind: 'discount', description: 'Diskon', amount, reason: 'Rusak' },
        h!.ownerId,
      ) as Promise<{ lineId: string }>;
    // A proposal that could never be applied is refused when it is made.
    await expectCode(propose(-150_000), 'VALIDATION_FAILED');
    const proposal = await propose(-60_000);
    await h.run('changeQuote', discount(-100_000), h.storeOwnerId);
    await expectCode(
      h.run(
        'applyProposal',
        { ticketId, lineId: proposal.lineId, customerAgreed: true },
        h.storeOwnerId,
      ),
      'VALIDATION_FAILED',
    );
    expect((await ticket(h, ticketId)).quoteTotal).toBe(0);
  });

  test('a total that offline merges pushed below zero can still be corrected upwards', async () => {
    h = await openRepairHarness(32);
    const { ticketId } = await open(h, {
      quoteLines: [{ kind: 'labour', description: 'Cek mesin', amount: 100_000 }],
    });
    // Two offline discounts that were each valid on their own device, merged.
    await sql`UPDATE repair_tickets SET quote_total = -50000 WHERE id = ${ticketId}`.execute(h.db);
    const line = (kind: string, amount: number) => ({
      ticketId,
      kind,
      description: kind,
      amount,
      reason: 'Koreksi',
      customerAgreed: true,
    });
    await expectCode(
      h.run('changeQuote', line('discount', -1), h.storeOwnerId),
      'VALIDATION_FAILED',
    );
    // -50,000 + 20,000 is still below zero, but it moves the right way.
    await h.run('changeQuote', line('labour', 20_000), h.cashierId);
  });

  test('a customer with no phone number is fine; blank phone becomes null', async () => {
    h = await openRepairHarness(4);
    const opened = await open(h, { customer: { name: 'Mama Yuliana', phone: '  ' } });
    expect((await ticket(h, opened.ticketId)).customerPhone).toBeNull();
  });

  test('a phone number is stored one way and one that cannot be dialled is refused', async () => {
    h = await openRepairHarness(4);
    const opened = await open(h, {
      customer: { name: 'Mama Yuliana', phone: '+62 812-3456-7890' },
    });
    expect((await ticket(h, opened.ticketId)).customerPhone).toBe('081234567890');
    for (const phone of ['0812345', '08123456789012345', '12345678', '+1 555 0100']) {
      await expectCode(
        h.run('openTicket', intake(h, { customer: { name: 'Mama Yuliana', phone } }), h.cashierId),
        'VALIDATION_FAILED',
      );
    }
  });

  test('an IMEI must be 15 digits with a valid check digit', async () => {
    h = await openRepairHarness(4);
    const device = { brand: 'Samsung', model: 'Galaxy A14', color: 'Hitam' };
    for (const imei of ['35678910445566', '356789104455667']) {
      await expectCode(
        h.run('openTicket', intake(h, { device: { ...device, imei } }), h.cashierId),
        'VALIDATION_FAILED',
      );
    }
    const opened = await open(h, { device: { ...device, imei: '35678910-4455660' } });
    expect((await ticket(h, opened.ticketId)).deviceImei).toBe('356789104455660');
  });

  test('retyping a returning customer reuses them; another name on the number is someone new', async () => {
    h = await openRepairHarness(4);
    const first = await open(h, { customer: { name: 'Yohanis Wenda', phone: '0812-4455-6677' } });
    const again = await open(h, { customer: { name: ' yohanis  wenda', phone: '081244556677' } });
    expect(again.customerId).toBe(first.customerId);
    const other = await open(h, { customer: { name: 'Mama Wenda', phone: '081244556677' } });
    expect(other.customerId).not.toBe(first.customerId);
  });

  test('technicians and unprivileged users cannot take devices in', async () => {
    h = await openRepairHarness(5);
    await expectCode(h.run('openTicket', intake(h), h.technicianId), 'PERMISSION_DENIED');
    await expectCode(h.run('openTicket', intake(h), h.zeroUserId), 'PERMISSION_DENIED');
    await expectCode(h.query('listTickets', {}, h.zeroUserId), 'PERMISSION_DENIED');
  });

  test('customer details can be corrected, and search finds them by spelling variant', async () => {
    h = await openRepairHarness(6);
    const opened = await open(h);
    await h.run(
      'correctCustomerDetails',
      { customerId: opened.customerId, name: 'Yohanis Wenda', phone: '081244556678' },
      h.cashierId,
    );
    const found = await h.query('searchCustomers', { text: 'johanes' }, h.cashierId);
    expect(found.rows).toEqual([expect.objectContaining({ phone: '081244556678' })]);
    const byTicket = await h.query('searchTickets', { text: opened.ticketNumber }, h.technicianId);
    expect(byTicket.rows.map((r: { id: string }) => r.id)).toEqual([opened.ticketId]);
  });
});

describe('queue and work', () => {
  test('starting an unassigned ticket claims it; progress flows to repaired', async () => {
    h = await openRepairHarness(7);
    const { ticketId } = await open(h);

    const queue = await h.query('listTickets', { filter: { unassigned: true } }, h.technicianId);
    expect(queue.rows.map((r: { id: string }) => r.id)).toEqual([ticketId]);

    await h.run('startWork', { ticketId, beforePhotos: [h.photo(20)] }, h.technicianId);
    let t = await ticket(h, ticketId);
    expect(t).toMatchObject({ outcome: 'in_repair', technicianId: h.technicianId });

    await h.run('markWaitingForParts', { ticketId, note: 'LCD dipesan' }, h.technicianId);
    t = await ticket(h, ticketId);
    expect(t).toMatchObject({ outcome: 'waiting_for_parts', outcomeNote: 'LCD dipesan' });

    await h.run('startWork', { ticketId }, h.technicianId);
    await h.run(
      'markRepaired',
      { ticketId, note: 'Tes sentuh OK', afterPhotos: [h.photo(21)] },
      h.technicianId,
    );
    t = await ticket(h, ticketId);
    expect(t.outcome).toBe('repaired');
    expect(t.events.map((e: { kind: string }) => e.kind)).toEqual([
      'repair.ticket_opened',
      'repair.ticket_claimed',
      'repair.work_photos_added',
      'repair.work_started',
      'repair.work_paused',
      'repair.work_started',
      'repair.work_photos_added',
      'repair.marked_repaired',
    ]);

    const mine = await h.query(
      'listTickets',
      { filter: { technicianId: h.technicianId, outcomes: ['repaired'] } },
      h.technicianId,
    );
    expect(mine.rows).toHaveLength(1);
  });

  test('technician loads count only the repairs each one still holds in the store', async () => {
    h = await openRepairHarness(81);
    const first = await open(h);
    const second = await open(h);
    const third = await open(h);
    await open(h); // unassigned: nobody's load
    for (const { ticketId } of [first, second]) {
      await h.run('assignTechnician', { ticketId, technicianId: h.technicianId }, h.cashierId);
    }
    await h.run(
      'assignTechnician',
      { ticketId: third.ticketId, technicianId: h.technician2Id },
      h.cashierId,
    );
    // A cancelled repair is no longer being worked on.
    await h.run(
      'cancelTicket',
      { ticketId: second.ticketId, reason: 'Batal', fee: 0 },
      h.storeOwnerId,
    );

    const loads = (await h.query('technicianLoads', {}, h.cashierId)).rows as {
      technicianId: string;
      load: number;
    }[];
    expect(new Map(loads.map((row) => [row.technicianId, row.load]))).toEqual(
      new Map([
        [h.technicianId, 1],
        [h.technician2Id, 1],
      ]),
    );
  });

  test('the cashier assigns; a technician can claim from a colleague; cashiers cannot do the work', async () => {
    h = await openRepairHarness(8);
    const { ticketId } = await open(h);
    await h.run('assignTechnician', { ticketId, technicianId: h.technician2Id }, h.cashierId);
    expect((await ticket(h, ticketId)).technicianId).toBe(h.technician2Id);
    // Only someone who can do the repair work can be given the phone.
    await expectCode(
      h.run('assignTechnician', { ticketId, technicianId: h.zeroUserId }, h.cashierId),
      'VALIDATION_FAILED',
    );
    await expectCode(
      h.run('assignTechnician', { ticketId, technicianId: h.technicianId }, h.technicianId),
      'PERMISSION_DENIED',
    );
    await h.run('claimTicket', { ticketId }, h.technicianId);
    expect((await ticket(h, ticketId)).technicianId).toBe(h.technicianId);
    await expectCode(h.run('claimTicket', { ticketId }, h.technicianId), 'INVALID_TRANSITION');
    await expectCode(h.run('startWork', { ticketId }, h.cashierId), 'PERMISSION_DENIED');
  });

  test('cannot mark repaired before work starts: the type`s rule refuses it before saving', async () => {
    h = await openRepairHarness(9);
    const { ticketId } = await open(h);
    const before = (await h.ownOps()).length;
    await expectCode(
      h.run('markRepaired', { ticketId, afterPhotos: [h.photo(21)] }, h.technicianId),
      'INVALID_TRANSITION',
      'notStarted',
    );
    // Neither the photos nor the transition were saved: one command, one transaction.
    expect(await h.ownOps()).toHaveLength(before);
  });

  test('work needs a before photo to start and an after photo every time it is marked repaired', async () => {
    h = await openRepairHarness(14);
    const { ticketId } = await open(h);
    const [before, after1, after2, after3] = [h.photo(20), h.photo(21), h.photo(22), h.photo(23)];
    await expectCode(
      h.run('startWork', { ticketId }, h.technicianId),
      'VALIDATION_FAILED',
      'needsBeforePhoto',
    );

    await h.run('startWork', { ticketId, beforePhotos: [before] }, h.technicianId);
    // The input itself requires the photo, so the form refuses before any rule runs.
    await expectCode(h.run('markRepaired', { ticketId }, h.technicianId), 'VALIDATION_FAILED');
    await h.run('markRepaired', { ticketId, afterPhotos: [after1] }, h.technicianId);

    // Reopening keeps the earlier before photo; the next completion needs its own after photo.
    await h.run('startWork', { ticketId }, h.technicianId);
    await expectCode(
      h.run('markRepaired', { ticketId, afterPhotos: [] }, h.technicianId),
      'VALIDATION_FAILED',
    );
    await h.run('markRepaired', { ticketId, afterPhotos: [after2, after3] }, h.technicianId);

    const slots = (await ticket(h, ticketId)).photos.map((p: { slot: string }) => p.slot);
    expect(slots).toEqual(
      expect.arrayContaining([
        `before:${before.mediaId}`,
        `after:${after1.mediaId}`,
        `after:${after2.mediaId}`,
        `after:${after3.mediaId}`,
      ]),
    );
    expect(slots).toHaveLength(6 + 4);
  });
});

describe('discounts (owners only)', () => {
  const discountLine = { kind: 'discount', description: 'Diskon', amount: -20_000 };

  test('counter staff cannot lower a price at intake; an owner can', async () => {
    h = await openRepairHarness(33);
    const lines = [{ kind: 'labour', description: 'Ganti LCD', amount: 300_000 }, discountLine];
    await expectCode(open(h, { quoteLines: lines }), 'PERMISSION_DENIED');
    const opened = await open(h, { quoteLines: lines }, h.storeOwnerId);
    expect((await ticket(h, opened.ticketId)).quoteTotal).toBe(280_000);
  });

  test('later, only an owner may change or propose a line that lowers the price', async () => {
    h = await openRepairHarness(34);
    const { ticketId } = await open(h);
    const change = (amount: number, kind = 'discount') => ({
      ticketId,
      kind,
      description: 'Koreksi',
      amount,
      reason: 'Langganan',
      customerAgreed: true,
    });
    await expectCode(h.run('changeQuote', change(-20_000), h.cashierId), 'PERMISSION_DENIED');
    // An adjustment is a discount too when it lowers the price.
    await expectCode(
      h.run('changeQuote', change(-20_000, 'adjustment'), h.cashierId),
      'PERMISSION_DENIED',
    );
    await expectCode(
      h.run(
        'proposeQuoteChange',
        { ticketId, kind: 'discount', description: 'Diskon', amount: -20_000, reason: 'Rusak' },
        h.technicianId,
      ),
      'PERMISSION_DENIED',
    );
    // Raising the price stays the counter's and the technician's.
    await h.run('changeQuote', change(15_000, 'adjustment'), h.cashierId);
    await h.run(
      'proposeQuoteChange',
      { ticketId, kind: 'part', description: 'Baterai', amount: 150_000, reason: 'Drop' },
      h.technicianId,
    );
    await h.run('changeQuote', change(-20_000), h.storeOwnerId);
    const t = await ticket(h, ticketId);
    expect(t.quoteLines.filter((l: { amount: number }) => l.amount < 0)).toHaveLength(1);
  });

  test('a proposal that lowers the price, or is applied lower than nothing, needs an owner to apply', async () => {
    h = await openRepairHarness(35);
    const { ticketId } = await open(h);
    const owners = (await h.run(
      'proposeQuoteChange',
      { ticketId, kind: 'discount', description: 'Diskon', amount: -10_000, reason: 'Langganan' },
      h.ownerId,
    )) as { lineId: string };
    await expectCode(
      h.run(
        'applyProposal',
        { ticketId, lineId: owners.lineId, customerAgreed: true },
        h.cashierId,
      ),
      'PERMISSION_DENIED',
    );
    const technicians = (await h.run(
      'proposeQuoteChange',
      { ticketId, kind: 'adjustment', description: 'Ongkos', amount: 10_000, reason: 'Ekstra' },
      h.technicianId,
    )) as { lineId: string };
    // The counter may settle on a different amount, but not turn the line into a discount.
    await expectCode(
      h.run(
        'applyProposal',
        { ticketId, lineId: technicians.lineId, customerAgreed: true, amount: -5_000 },
        h.cashierId,
      ),
      'PERMISSION_DENIED',
    );
    await h.run(
      'applyProposal',
      { ticketId, lineId: owners.lineId, customerAgreed: true },
      h.storeOwnerId,
    );
    await h.run('declineProposal', { ticketId, lineId: technicians.lineId }, h.cashierId);
    const lines = (await ticket(h, ticketId)).quoteLines as { id: string; status: string }[];
    expect(lines.find((l) => l.id === owners.lineId)?.status).toBe('applied');
  });
});

describe('a price change waits for the customer', () => {
  test('a change the customer has not agreed to waits, then counts once they agree', async () => {
    h = await openRepairHarness(36);
    const { ticketId } = await open(h);
    const { lineId } = (await h.run(
      'changeQuote',
      {
        ticketId,
        kind: 'part',
        description: 'Lem',
        amount: 20_000,
        reason: 'Lem lepas',
        customerAgreed: false,
      },
      h.cashierId,
    )) as { lineId: string };
    const waiting = await ticket(h, ticketId);
    expect(waiting.quoteTotal).toBe(750_000);
    expect(waiting.pendingProposals).toBe(1);
    expect(waiting.quoteLines.find((l: { id: string }) => l.id === lineId)).toMatchObject({
      status: 'proposed',
      customerAgreed: null,
      createdBy: h.cashierId,
    });

    // There is no applying it without the customer's yes.
    await expectCode(
      h.run('applyProposal', { ticketId, lineId, customerAgreed: false }, h.cashierId),
      'VALIDATION_FAILED',
    );
    await h.run('applyProposal', { ticketId, lineId, customerAgreed: true }, h.cashierId);
    const agreed = await ticket(h, ticketId);
    expect(agreed.quoteTotal).toBe(770_000);
    expect(agreed.pendingProposals).toBe(0);
    expect(agreed.quoteLines.find((l: { id: string }) => l.id === lineId)).toMatchObject({
      status: 'applied',
      customerAgreed: true,
    });
  });

  test('a change the customer turns down never counts', async () => {
    h = await openRepairHarness(37);
    const { ticketId } = await open(h);
    const { lineId } = (await h.run(
      'changeQuote',
      {
        ticketId,
        kind: 'labour',
        description: 'Ekstra',
        amount: 50_000,
        reason: 'Lama',
        customerAgreed: false,
      },
      h.cashierId,
    )) as { lineId: string };
    await h.run('declineProposal', { ticketId, lineId, note: 'Tidak mau' }, h.cashierId);
    const t = await ticket(h, ticketId);
    expect(t.quoteTotal).toBe(750_000);
    expect(t.pendingProposals).toBe(0);
  });
});

describe('price changes', () => {
  test('a technician proposes; it does not count until the cashier applies it', async () => {
    h = await openRepairHarness(10);
    const { ticketId } = await open(h);
    const proposal = (await h.run(
      'proposeQuoteChange',
      {
        ticketId,
        kind: 'part',
        description: 'Konektor charger',
        amount: 75_000,
        reason: 'Konektor longgar ditemukan saat bongkar',
      },
      h.technicianId,
    )) as { lineId: string };

    let t = await ticket(h, ticketId);
    expect(t.quoteTotal).toBe(750_000);
    expect(t.pendingProposals).toBe(1);
    const waiting = await h.query(
      'listTickets',
      { filter: { hasPendingProposals: true } },
      h.cashierId,
    );
    expect(waiting.rows).toHaveLength(1);

    await expectCode(
      h.run(
        'applyProposal',
        { ticketId, lineId: proposal.lineId, customerAgreed: true },
        h.technicianId,
      ),
      'PERMISSION_DENIED',
    );
    await h.run(
      'applyProposal',
      { ticketId, lineId: proposal.lineId, customerAgreed: true, amount: 60_000 },
      h.cashierId,
    );
    t = await ticket(h, ticketId);
    expect(t.quoteTotal).toBe(810_000);
    expect(t.pendingProposals).toBe(0);
    expect(t.quoteLines.find((l: { id: string }) => l.id === proposal.lineId)).toMatchObject({
      status: 'applied',
      amount: 60_000,
      customerAgreed: true,
      decidedBy: h.cashierId,
    });
    await expectCode(
      h.run(
        'applyProposal',
        { ticketId, lineId: proposal.lineId, customerAgreed: true },
        h.cashierId,
      ),
      'INVALID_TRANSITION',
    );
  });

  test('declined proposals never count; cashier changes count immediately', async () => {
    h = await openRepairHarness(11);
    const { ticketId } = await open(h);
    const proposal = (await h.run(
      'proposeQuoteChange',
      { ticketId, kind: 'labour', description: 'Bersih mesin', amount: 50_000, reason: 'Kotor' },
      h.technicianId,
    )) as { lineId: string };
    await h.run(
      'declineProposal',
      { ticketId, lineId: proposal.lineId, note: 'Pelanggan menolak' },
      h.cashierId,
    );
    await h.run(
      'changeQuote',
      {
        ticketId,
        kind: 'discount',
        description: 'Diskon pelanggan tetap',
        amount: -50_000,
        reason: 'Pelanggan tetap',
        customerAgreed: true,
      },
      h.storeOwnerId,
    );
    const t = await ticket(h, ticketId);
    expect(t.quoteTotal).toBe(700_000);
    expect(t.quoteLines.map((l: { status: string }) => l.status)).toEqual([
      'intake',
      'intake',
      'declined',
      'applied',
    ]);
    await expectCode(
      h.run(
        'changeQuote',
        { ticketId, kind: 'part', description: 'x', amount: 1, reason: 'y', customerAgreed: false },
        h.technicianId,
      ),
      'PERMISSION_DENIED',
    );
  });
});

describe('cancel and handover', () => {
  test('repaired device is handed back with photo and signature; then the ticket is closed', async () => {
    h = await openRepairHarness(12);
    const { ticketId } = await open(h);
    await h.run('startWork', { ticketId, beforePhotos: [h.photo(20)] }, h.technicianId);

    const handover = {
      ticketId,
      handoverPhoto: h.photo(7),
      signature: h.photo(8),
      checklist: accessoriesBack(),
    };
    await expectCode(h.run('returnDevice', handover, h.cashierId), 'INVALID_TRANSITION');

    await h.run('markRepaired', { ticketId, afterPhotos: [h.photo(21)] }, h.technicianId);
    await h.run(
      'proposeQuoteChange',
      { ticketId, kind: 'part', description: 'Baut', amount: 5_000, reason: 'Hilang' },
      h.technicianId,
    );
    await expectCode(h.run('returnDevice', handover, h.cashierId), 'INVALID_TRANSITION');
    const pending = (await ticket(h, ticketId)).quoteLines.find(
      (l: { status: string }) => l.status === 'proposed',
    );
    await h.run('declineProposal', { ticketId, lineId: pending.id }, h.cashierId);

    await expectCode(h.run('returnDevice', handover, h.technicianId), 'PERMISSION_DENIED');
    // Not until it is paid; then the rest of the bill is taken at the counter.
    await expectCode(h.run('returnDevice', handover, h.cashierId), 'VALIDATION_FAILED');
    await h.run('returnDevice', (await paidHandover(h, ticketId)) as never, h.cashierId);
    const t = await ticket(h, ticketId);
    expect(t).toMatchObject({ outcome: 'repaired', location: 'returned', returnedBy: h.cashierId });
    expect(t.photos.map((p: { slot: string }) => p.slot)).toEqual(
      expect.arrayContaining(['handover', 'signature']),
    );

    await expectCode(h.run('returnDevice', handover, h.cashierId), 'INVALID_TRANSITION');
    await expectCode(h.run('startWork', { ticketId }, h.technicianId), 'INVALID_TRANSITION');
    await expectCode(
      h.run(
        'changeQuote',
        { ticketId, kind: 'part', description: 'x', amount: 1, reason: 'y', customerAgreed: true },
        h.cashierId,
      ),
      'INVALID_TRANSITION',
    );
  });

  test('a cancelled device stays in store until handed back, and is listed that way', async () => {
    h = await openRepairHarness(13);
    const { ticketId } = await open(h);
    await expectCode(
      h.run('cancelTicket', { ticketId, reason: 'x', fee: 0 }, h.technicianId),
      'PERMISSION_DENIED',
    );
    await h.run(
      'cancelTicket',
      { ticketId, reason: 'Biaya terlalu mahal', fee: 0 },
      h.storeOwnerId,
    );

    const stillHere = await h.query(
      'listTickets',
      { filter: { outcomes: ['cancelled'], location: 'in_store' } },
      h.cashierId,
    );
    expect(stillHere.rows.map((r: { id: string }) => r.id)).toEqual([ticketId]);
    await expectCode(h.run('startWork', { ticketId }, h.technicianId), 'INVALID_TRANSITION');
    await expectCode(
      h.run('cancelTicket', { ticketId, reason: 'again', fee: 0 }, h.storeOwnerId),
      'INVALID_TRANSITION',
    );

    await h.run(
      'returnDevice',
      {
        ticketId,
        handoverPhoto: h.photo(7),
        signature: h.photo(8),
        note: 'Diambil tanpa servis',
        checklist: accessoriesBack(),
      },
      h.cashierId,
    );
    expect(await ticket(h, ticketId)).toMatchObject({ outcome: 'cancelled', location: 'returned' });
  });

  // Regression: a proposal left open when the repair was cancelled (or one that synced in after the
  // cancel) can no longer be decided, so it used to keep the customer's phone in the store forever.
  test('an open proposal on a cancelled ticket does not block handing the phone back', async () => {
    h = await openRepairHarness(17);
    const { ticketId } = (await h.run('openTicket', intake(h), h.cashierId)) as {
      ticketId: string;
    };
    await h.run('startWork', { ticketId, beforePhotos: [h.photo(20)] }, h.technicianId);
    await h.run(
      'proposeQuoteChange',
      { ticketId, kind: 'part', description: 'Baterai', amount: 150_000, reason: 'Kembung' },
      h.technicianId,
    );
    await h.run('cancelTicket', { ticketId, reason: 'Pelanggan batal', fee: 0 }, h.storeOwnerId);
    const pending = (await ticket(h, ticketId)).quoteLines.find(
      (l: { status: string }) => l.status === 'proposed',
    );
    await expectCode(
      h.run('applyProposal', { ticketId, lineId: pending.id, customerAgreed: true }, h.cashierId),
      'INVALID_TRANSITION',
    );

    await h.run(
      'returnDevice',
      { ticketId, handoverPhoto: h.photo(7), signature: h.photo(8), checklist: accessoriesBack() },
      h.cashierId,
    );
    expect(await ticket(h, ticketId)).toMatchObject({ outcome: 'cancelled', location: 'returned' });
  });
});

describe('correcting a saved servisan', () => {
  test('the counter corrects the customer and the phone; the history says before and after', async () => {
    h = await openRepairHarness(30);
    const opened = await open(h);
    await h.run(
      'correctTicketDetails',
      {
        ticketId: opened.ticketId,
        customer: { name: 'Yohanis Wenda', phone: '0813 1111 2222' },
        device: { brand: 'Samsung', model: 'Galaxy A15', color: 'Biru', imei: '356789104455660' },
        passcode: 'pin:1234',
        reason: 'Salah ketik',
      },
      h.cashierId,
    );
    const t = await ticket(h, opened.ticketId);
    expect(t).toMatchObject({
      customerPhone: '081311112222',
      deviceModel: 'Galaxy A15',
      deviceColor: 'Biru',
      devicePasscode: 'pin:1234',
    });
    const event = t.events.find(
      (e: { kind: string }) => e.kind === 'repair.ticket_details_corrected',
    );
    expect(event.detail).toEqual({
      reason: 'Salah ketik',
      changes: [
        { field: 'customerPhone', from: '081244556677', to: '081311112222' },
        { field: 'model', from: 'Galaxy A14', to: 'Galaxy A15' },
        { field: 'color', from: 'Hitam', to: 'Biru' },
        // The screen lock's code is never shown, only that it changed.
        { field: 'passcode' },
      ],
    });
    const found = await h.query('searchCustomers', { text: '081311112222' }, h.cashierId);
    expect(found.rows.map((r: { id: string }) => r.id)).toEqual([opened.customerId]);
  });

  test('a customer with other servisans is never renamed: the servisan moves instead', async () => {
    h = await openRepairHarness(34);
    const first = await open(h);
    const second = await open(h, { customer: { customerId: first.customerId } });
    // Intake picked the wrong Yohanis: this servisan is Mama Wenda's.
    const mama = { name: 'Mama Wenda', phone: '0813 1111 2222' };
    await h.run('correctTicketDetails', { ticketId: second.ticketId, customer: mama }, h.cashierId);
    const moved = await ticket(h, second.ticketId);
    expect(moved).toMatchObject({ customerName: 'Mama Wenda', customerPhone: '081311112222' });
    expect(moved.customerId).not.toBe(first.customerId);
    expect(await ticket(h, first.ticketId)).toMatchObject({
      customerId: first.customerId,
      customerName: 'Yohanis Wenda',
      customerPhone: '081244556677',
    });
    expect(moved.events.at(-1).detail.changes).toEqual([
      { field: 'customerName', from: 'Yohanis Wenda', to: 'Mama Wenda' },
      { field: 'customerPhone', from: '081244556677', to: '081311112222' },
    ]);
    // Typed back to the first customer's details, it rejoins that record rather than make a third.
    await h.run(
      'correctTicketDetails',
      { ticketId: second.ticketId, customer: { name: 'Yohanis Wenda', phone: '081244556677' } },
      h.cashierId,
    );
    expect((await ticket(h, second.ticketId)).customerId).toBe(first.customerId);
  });

  test('a customer picked from the list takes the servisan, even one with no number', async () => {
    h = await openRepairHarness(35);
    const mine = await open(h);
    const other = await open(h, { customer: { name: 'Mama Wenda', phone: null } });
    await h.run(
      'correctTicketDetails',
      { ticketId: mine.ticketId, customer: { customerId: other.customerId } },
      h.cashierId,
    );
    const moved = await ticket(h, mine.ticketId);
    expect(moved).toMatchObject({ customerId: other.customerId, customerName: 'Mama Wenda' });
    // Neither record was renamed.
    expect(await ticket(h, other.ticketId)).toMatchObject({ customerName: 'Mama Wenda' });
    const found = await h.query('searchCustomers', { text: '081244556677' }, h.cashierId);
    expect(found.rows.map((r: { name: string }) => r.name)).toEqual(['Yohanis Wenda']);
    await expectCode(
      h.run(
        'correctTicketDetails',
        { ticketId: mine.ticketId, customer: { customerId: 'nobody' } },
        h.cashierId,
      ),
      'ENTITY_NOT_FOUND',
    );
  });

  test('nothing to correct, a bad number, a technician, or a phone gone home are refused', async () => {
    h = await openRepairHarness(31);
    const { ticketId } = await open(h);
    const same = { ticketId, complaint: 'Layar retak, sentuhan tidak responsif' };
    await expectCode(h.run('correctTicketDetails', same, h.cashierId), 'VALIDATION_FAILED');
    await expectCode(
      h.run(
        'correctTicketDetails',
        { ticketId, customer: { name: 'Y', phone: '0812' } },
        h.cashierId,
      ),
      'VALIDATION_FAILED',
    );
    const fix = { ticketId, complaint: 'Layar retak' };
    await expectCode(h.run('correctTicketDetails', fix, h.technicianId), 'PERMISSION_DENIED');

    await h.run('startWork', { ticketId, beforePhotos: [h.photo(20)] }, h.technicianId);
    await h.run('markRepaired', { ticketId, afterPhotos: [h.photo(21)] }, h.technicianId);
    await h.run('returnDevice', (await paidHandover(h, ticketId)) as never, h.cashierId);
    await expectCode(
      h.run('correctTicketDetails', fix, h.cashierId),
      'INVALID_TRANSITION',
      'returned',
    );
    const t = await ticket(h, ticketId);
    await expectCode(
      h.run(
        'correctCustomerDetails',
        { customerId: t.customerId, name: 'Orang Lain', phone: null },
        h.cashierId,
      ),
      'INVALID_TRANSITION',
      'returned',
    );
  });

  test('a customer with two servisans is never renamed in place', async () => {
    h = await openRepairHarness(38);
    const first = await open(h);
    await open(h, { customer: { customerId: first.customerId } });
    await expectCode(
      h.run(
        'correctCustomerDetails',
        { customerId: first.customerId, name: 'Orang Lain', phone: null },
        h.cashierId,
      ),
      'INVALID_TRANSITION',
      'customerShared',
    );
  });

  test("a move's history must name the customer it moves to", async () => {
    h = await openRepairHarness(39);
    const mine = await open(h);
    const other = await open(h, { customer: { name: 'Mama Wenda', phone: null } });
    await h.run(
      'correctTicketDetails',
      { ticketId: mine.ticketId, customer: { customerId: other.customerId } },
      h.cashierId,
    );
    const moved = (await h.ownOps()).findLast(
      (op) => op.type === REPAIR_OP.ticketDetailsCorrected,
    )!;
    const payload = moved.payload as Record<string, unknown>;
    // A crafted change claiming a different "now" than the record it points at is refused.
    const forged = {
      ...moved,
      payload: { ...payload, customer: { name: 'Orang Lain', phone: '081311112222' } },
    };
    await expect(h.checkRule(moved)).resolves.toBeUndefined();
    const refused = await h.checkRule(forged).then(
      () => null,
      (e: unknown) => e,
    );
    expect(refusalKeyOf(refused)).toBe('repair.refusal.customerMismatch');
  });

  test("a warranty claim keeps its servisan's phone", async () => {
    h = await openRepairHarness(32);
    const { ticketId } = await open(h);
    await h.run('startWork', { ticketId, beforePhotos: [h.photo(20)] }, h.technicianId);
    await h.run('markRepaired', { ticketId, afterPhotos: [h.photo(21)] }, h.technicianId);
    await h.run('returnDevice', (await paidHandover(h, ticketId)) as never, h.cashierId);
    const original = await ticket(h, ticketId);
    const claim = await open(
      h,
      {
        customer: { customerId: original.customerId },
        claimOf: ticketId,
        quoteLines: [{ kind: 'labour', description: 'Klaim garansi', amount: 0 }],
      },
      h.ownerId,
    );
    await expectCode(
      h.run(
        'correctTicketDetails',
        {
          ticketId: claim.ticketId,
          device: {
            brand: 'Samsung',
            model: 'Galaxy A14',
            color: 'Hitam',
            imei: '350000000000006',
          },
        },
        h.cashierId,
      ),
      'VALIDATION_FAILED',
      'claimSamePhone',
    );
    // Its colour or complaint can still be put right.
    await h.run(
      'correctTicketDetails',
      { ticketId: claim.ticketId, complaint: 'Layar bergaris' },
      h.cashierId,
    );
    // And the original's handover can no longer be taken back.
    await expectCode(
      h.run('undoHandover', { ticketId, reason: 'Salah' }, h.ownerId),
      'INVALID_TRANSITION',
      'handoverHasClaim',
    );
  });
});

describe('undoing a handover', () => {
  test('an owner takes a mistaken handover back; it can then be handed over properly', async () => {
    h = await openRepairHarness(33);
    const { ticketId } = await open(h);
    const reason = { ticketId, reason: 'Salah servisan, HP masih di rak' };
    await expectCode(h.run('undoHandover', reason, h.ownerId), 'INVALID_TRANSITION', 'notReturned');
    await h.run('startWork', { ticketId, beforePhotos: [h.photo(20)] }, h.technicianId);
    await h.run('markRepaired', { ticketId, afterPhotos: [h.photo(21)] }, h.technicianId);
    await h.run('returnDevice', (await paidHandover(h, ticketId)) as never, h.cashierId);

    await expectCode(h.run('undoHandover', reason, h.cashierId), 'PERMISSION_DENIED');
    const signatureOf = (row: { photos: { slot: string; mediaId: string }[] }) =>
      row.photos.find((p) => p.slot === 'signature')?.mediaId;
    const wrongSignature = signatureOf(await ticket(h, ticketId));
    await h.run('undoHandover', reason, h.ownerId);
    let t = await ticket(h, ticketId);
    expect(t).toMatchObject({ location: 'in_store', returnedBy: null });
    expect(t.photos.map((p: { slot: string }) => p.slot)).not.toContain('signature');
    expect(t.events.at(-1)).toMatchObject({
      kind: 'repair.handover_reversed',
      detail: { reason: 'Salah servisan, HP masih di rak' },
    });
    // Already paid: the real handover takes no second payment, and keeps its own evidence.
    await h.run(
      'returnDevice',
      (await paidHandover(h, ticketId, {}, [9, 10])) as never,
      h.cashierId,
    );
    t = await ticket(h, ticketId);
    expect(t.location).toBe('returned');
    const money = await h.moneyQuery(
      'documentMoney',
      { kind: REPAIR_DOCUMENT_KIND, id: ticketId },
      h.ownerId,
    );
    expect(money.rows[0]).toMatchObject({ charged: t.quoteTotal, balance: 0 });
    expect(signatureOf(t)).toEqual(expect.any(String));
    expect(signatureOf(t)).not.toBe(wrongSignature);
  });

  test('only within a day of the first handover, and a manager only within the cancel limit', async () => {
    h = await openRepairHarness(36);
    const handedOver = async (amount: number) => {
      const { ticketId } = await open(h!, {
        quoteLines: [{ kind: 'labour', description: 'Ganti konektor', amount }],
      });
      await h!.run('startWork', { ticketId, beforePhotos: [h!.photo(20)] }, h!.technicianId);
      await h!.run('markRepaired', { ticketId, afterPhotos: [h!.photo(21)] }, h!.technicianId);
      await h!.run('returnDevice', (await paidHandover(h!, ticketId)) as never, h!.cashierId);
      return ticketId;
    };
    const reason = (ticketId: string) => ({ ticketId, reason: 'Salah servisan' });
    const dear = await handedOver(750_000);
    await expectCode(h.run('undoHandover', reason(dear), h.managerId), 'PERMISSION_DENIED');
    const cheap = await handedOver(40_000);
    await h.run('undoHandover', reason(cheap), h.managerId);

    const firstHandover = (await ticket(h, cheap)).returnedAt;
    expect(firstHandover).toEqual(expect.any(Number));
    h.advance(HANDOVER_UNDO_WINDOW_MS + 1);
    await expectCode(
      h.run('undoHandover', reason(dear), h.ownerId),
      'INVALID_TRANSITION',
      'undoTooLate',
    );
    // Handed over properly later, the warranty still counts from the first handover, and taking
    // it back again does not restart the window.
    await h.run('returnDevice', (await paidHandover(h, cheap, {}, [9, 10])) as never, h.cashierId);
    expect((await ticket(h, cheap)).returnedAt).toBe(firstHandover);
    await expectCode(
      h.run('undoHandover', reason(cheap), h.ownerId),
      'INVALID_TRANSITION',
      'undoTooLate',
    );
  });

  test('a handover taken back is never cancelled, nor moved to another customer or phone', async () => {
    h = await openRepairHarness(37);
    const { ticketId } = await open(h);
    await open(h, { customer: { name: 'Mama Wenda', phone: '0813 1111 2222' } });
    await h.run('startWork', { ticketId, beforePhotos: [h.photo(20)] }, h.technicianId);
    await h.run('markRepaired', { ticketId, afterPhotos: [h.photo(21)] }, h.technicianId);
    await h.run('returnDevice', (await paidHandover(h, ticketId)) as never, h.cashierId);
    await h.run('undoHandover', { ticketId, reason: 'Salah servisan' }, h.ownerId);

    await expectCode(
      h.run('cancelTicket', { ticketId, reason: 'Batal' }, h.ownerId),
      'INVALID_TRANSITION',
      'handedOverBefore',
    );
    await expectCode(
      h.run(
        'correctTicketDetails',
        { ticketId, customer: { name: 'Mama Wenda', phone: '0813 1111 2222' } },
        h.cashierId,
      ),
      'INVALID_TRANSITION',
      'handedOverBefore',
    );
    await expectCode(
      h.run(
        'correctTicketDetails',
        {
          ticketId,
          device: { brand: 'Xiaomi', model: 'Redmi 12', color: 'Hitam', imei: '350000000000006' },
        },
        h.cashierId,
      ),
      'VALIDATION_FAILED',
      'handedOverBefore',
    );
    // Its colour or complaint can still be put right.
    await h.run('correctTicketDetails', { ticketId, complaint: 'Layar bergaris' }, h.cashierId);
  });
});

describe('at-rest encryption seam', () => {
  test('without the cipher the harness reads plaintext; the plugin seals customer columns', async () => {
    // The production connection installs the column cipher; this harness does not, so it reads
    // plaintext. The sealing itself is covered by db-client's raw-file test via the column map.
    h = await openRepairHarness(14);
    await open(h);
    const raw = await sql<{ name: string }>`SELECT name FROM repair_customers`.execute(h.db);
    expect(raw.rows[0]!.name).toBe('Yohanis Wenda');
  });
});

describe('ticket numbers', () => {
  test('the counter is compared as a number past 9999 and ignores other device codes', async () => {
    h = await openRepairHarness(15);
    const first = await open(h);
    const code = first.ticketNumber.slice(0, 3);
    const otherCode = code === 'ZZZ' ? 'YYY' : 'ZZZ';
    // As text `XXX-9999` sorts after `XXX-10000`; a text MAX would mint a duplicate here.
    await sql`UPDATE repair_tickets SET ticket_number = ${`${code}-9999`}`.execute(h.db);
    expect((await open(h)).ticketNumber).toBe(`${code}-10000`);
    const third = await open(h);
    expect(third.ticketNumber).toBe(`${code}-10001`);
    // Another device's higher counter does not move ours.
    await sql`UPDATE repair_tickets SET ticket_number = ${`${otherCode}-50000`} WHERE id = ${third.ticketId}`.execute(
      h.db,
    );
    expect((await open(h)).ticketNumber).toBe(`${code}-10001`);
  });

  test('malformed numbers synced from elsewhere cannot wedge the counter', async () => {
    h = await openRepairHarness(17);
    const first = await open(h);
    const code = first.ticketNumber.slice(0, 3);
    // As integers these cast to INT64 max (every later number would collide) or to 12.
    await sql`UPDATE repair_tickets SET ticket_number = ${`${code}-99999999999999999999`}`.execute(
      h.db,
    );
    const second = await open(h);
    await sql`UPDATE repair_tickets SET ticket_number = ${`${code}-12x`} WHERE id = ${second.ticketId}`.execute(
      h.db,
    );
    expect(second.ticketNumber).toBe(`${code}-0001`);
    expect((await open(h)).ticketNumber).toBe(`${code}-0001`);
  });

  test('finding the next counter is one index seek, not a scan of the store', async () => {
    h = await openRepairHarness(16);
    const compiled = maxTicketCounter(h.db, h, 'K7Q').compile();
    const rows = await h.db.executeQuery<{ detail: string }>({
      ...compiled,
      sql: `EXPLAIN QUERY PLAN ${compiled.sql}`,
    });
    expect(rows.rows.map((r) => r.detail).join('\n')).toMatch(
      /USING COVERING INDEX idx_repair_tickets_device_counter/,
    );
  });
});
