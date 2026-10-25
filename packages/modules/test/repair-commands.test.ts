// The repair ticket journey through the real runtime: intake, queue, work, price changes, cancel
// and handover — plus the permission split and the transitions a device must refuse.
import { sql } from 'kysely';
import { afterEach, describe, expect, test } from 'vitest';

import { DomainError } from '@bolusi/core';

import { openRepairHarness, intake, type RepairHarness } from './support/repair-harness.js';

let h: RepairHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  const err = await p.then(
    () => new Error(`expected ${code}, but the call resolved`),
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DomainError);
  expect((err as DomainError).code).toBe(code);
}

interface Opened {
  ticketId: string;
  ticketNumber: string;
  customerId: string;
}

async function open(harness: RepairHarness, overrides: Record<string, unknown> = {}) {
  return (await harness.run('openTicket', intake(harness, overrides), harness.cashierId)) as Opened;
}

async function ticket(harness: RepairHarness, ticketId: string, userId = harness.cashierId) {
  return (await harness.query('getTicket', { ticketId }, userId)).rows[0];
}

describe('intake', () => {
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
      customerPhone: '0812-4455-6677',
      deviceModel: 'Galaxy A14',
      outcome: 'received',
      location: 'in_store',
      technicianId: null,
      quoteTotal: 750_000,
      pendingProposals: 0,
      peripherals: ['charger', 'case'],
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

  test('a ticket without all six photos is refused before anything is written', async () => {
    h = await openRepairHarness(2);
    const input = intake(h);
    const fivePhotos: Partial<typeof input.photos> = { ...input.photos };
    delete fivePhotos.bottom;
    await expectCode(
      h.run('openTicket', { ...input, photos: fivePhotos } as never, h.cashierId),
      'VALIDATION_FAILED',
    );
    const count = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM repair_tickets`.execute(h.db);
    expect(count.rows[0]!.n).toBe(0);
  });

  test('a ticket needs at least one price line, and line signs are checked', async () => {
    h = await openRepairHarness(3);
    await expectCode(open(h, { quoteLines: [] }), 'VALIDATION_FAILED');
    await expectCode(
      open(h, { quoteLines: [{ kind: 'discount', description: 'Diskon', amount: 50_000 }] }),
      'VALIDATION_FAILED',
    );
    await expectCode(
      open(h, { quoteLines: [{ kind: 'part', description: 'LCD', amount: -1 }] }),
      'VALIDATION_FAILED',
    );
  });

  test('a customer with no phone number is fine; blank phone becomes null', async () => {
    h = await openRepairHarness(4);
    const opened = await open(h, { customer: { name: 'Mama Yuliana', phone: '  ' } });
    expect((await ticket(h, opened.ticketId)).customerPhone).toBeNull();
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

  test('the cashier assigns; a technician can claim from a colleague; cashiers cannot do the work', async () => {
    h = await openRepairHarness(8);
    const { ticketId } = await open(h);
    await h.run('assignTechnician', { ticketId, technicianId: h.technician2Id }, h.cashierId);
    expect((await ticket(h, ticketId)).technicianId).toBe(h.technician2Id);
    await expectCode(
      h.run('assignTechnician', { ticketId, technicianId: h.technicianId }, h.technicianId),
      'PERMISSION_DENIED',
    );
    await h.run('claimTicket', { ticketId }, h.technicianId);
    expect((await ticket(h, ticketId)).technicianId).toBe(h.technicianId);
    await expectCode(h.run('claimTicket', { ticketId }, h.technicianId), 'INVALID_TRANSITION');
    await expectCode(h.run('startWork', { ticketId }, h.cashierId), 'PERMISSION_DENIED');
  });

  test('cannot mark repaired before work starts', async () => {
    h = await openRepairHarness(9);
    const { ticketId } = await open(h);
    await expectCode(
      h.run('markRepaired', { ticketId, afterPhotos: [h.photo(21)] }, h.technicianId),
      'INVALID_TRANSITION',
    );
  });

  test('work needs a before photo to start and an after photo every time it is marked repaired', async () => {
    h = await openRepairHarness(14);
    const { ticketId } = await open(h);
    const [before, after1, after2, after3] = [h.photo(20), h.photo(21), h.photo(22), h.photo(23)];
    await expectCode(h.run('startWork', { ticketId }, h.technicianId), 'VALIDATION_FAILED');

    await h.run('startWork', { ticketId, beforePhotos: [before] }, h.technicianId);
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
      h.cashierId,
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

    const handover = { ticketId, handoverPhoto: h.photo(7), signature: h.photo(8) };
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
    await h.run('returnDevice', handover, h.cashierId);
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
      h.run('cancelTicket', { ticketId, reason: 'x' }, h.technicianId),
      'PERMISSION_DENIED',
    );
    await h.run('cancelTicket', { ticketId, reason: 'Biaya terlalu mahal' }, h.cashierId);

    const stillHere = await h.query(
      'listTickets',
      { filter: { outcomes: ['cancelled'], location: 'in_store' } },
      h.cashierId,
    );
    expect(stillHere.rows.map((r: { id: string }) => r.id)).toEqual([ticketId]);
    await expectCode(h.run('startWork', { ticketId }, h.technicianId), 'INVALID_TRANSITION');
    await expectCode(
      h.run('cancelTicket', { ticketId, reason: 'again' }, h.cashierId),
      'INVALID_TRANSITION',
    );

    await h.run(
      'returnDevice',
      { ticketId, handoverPhoto: h.photo(7), signature: h.photo(8), note: 'Diambil tanpa servis' },
      h.cashierId,
    );
    expect(await ticket(h, ticketId)).toMatchObject({ outcome: 'cancelled', location: 'returned' });
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
