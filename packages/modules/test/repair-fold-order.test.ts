// A ticket folds to the state the server judged, whatever the phones' clocks said.
//
// The server judges pushed ops in the order they arrive, but every side folds them in canonical
// order (device timestamp first). A phone whose clock is behind can sign a change that folds before
// changes the server accepted earlier, even before the ticket was opened. These tests push ops to a
// "server" (a harness that runs each op's rule before folding it, in arrival order), then fold the
// same ops on another device in a different order, and check both land on what the server judged.
import { sql, type Kysely } from 'kysely';
import { afterEach, expect, test } from 'vitest';

import type { SignedOperation } from '@bolusi/schemas';

import {
  intake,
  openRepairHarness,
  paidHandover,
  type RepairHarness,
} from './support/repair-harness.js';

const open: RepairHarness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

const TABLES = [
  'repair_customers',
  'repair_tickets',
  'repair_quote_lines',
  'repair_ticket_photos',
  'repair_ticket_events',
] as const;

async function dump(h: RepairHarness): Promise<Record<string, unknown[]>> {
  const db = h.db as unknown as Kysely<never>;
  const out: Record<string, unknown[]> = {};
  for (const table of TABLES) {
    const rows = await sql<Record<string, unknown>>`SELECT * FROM ${sql.table(table)}`.execute(db);
    out[table] = rows.rows.map((row) => JSON.stringify(row, Object.keys(row).sort())).sort();
  }
  return out;
}

/**
 * Two devices of one store, the first `behindMs` behind the second, plus a server and a third
 * device that only receive ops.
 */
async function devices(seed: number) {
  const a = await openRepairHarness(seed);
  const shared = {
    tenantId: a.tenantId,
    storeId: a.storeId,
    users: [a.cashierId, a.technicianId, a.technician2Id, a.zeroUserId, a.ownerId, a.storeOwnerId],
  };
  // Seeds one apart: the second device's clock is 1 000 000 ms (about 17 minutes) ahead.
  const b = await openRepairHarness(seed + 1, shared);
  const server = await openRepairHarness(seed + 2, shared);
  const other = await openRepairHarness(seed + 3, shared);
  open.push(a, b, server, other);
  const delivered = new Map<RepairHarness, Set<string>>();
  const arrival = new Map<RepairHarness, number>();
  /** Hands `to` every op of `from` it has not had yet, in `from`'s order. */
  const sync = async (from: RepairHarness, to: RepairHarness): Promise<SignedOperation[]> => {
    const seen = delivered.get(to) ?? new Set<string>();
    delivered.set(to, seen);
    const fresh = (await from.ownOps()).filter((op) => !seen.has(op.id));
    for (const op of fresh) {
      seen.add(op.id);
      const n = (arrival.get(to) ?? 0) + 1;
      arrival.set(to, n);
      // The server runs each op's rule against its records before accepting it.
      if (to === server) await server.checkRule(op);
      await to.deliverPulled(op, n);
    }
    return fresh;
  };
  return { a, b, server, other, sync };
}

async function ticketOf(h: RepairHarness, ticketId: string) {
  return (await h.query('getTicket', { ticketId }, h.ownerId)).rows[0];
}

/** The other device gets every op in the opposite order and must fold to the server's rows. */
async function expectSameAsServer(
  ctx: Awaited<ReturnType<typeof devices>>,
  order: readonly RepairHarness[],
): Promise<void> {
  for (const from of order) await ctx.sync(from, ctx.other);
  expect(await dump(ctx.other)).toStrictEqual(await dump(ctx.server));
}

test('an owner’s offline cancel signed before work started still ends the servisan cancelled', async () => {
  const ctx = await devices(401);
  const { a: owner, b: bench, server, sync } = ctx;
  const { ticketId } = (await owner.run('openTicket', intake(owner), owner.cashierId)) as {
    ticketId: string;
  };
  await sync(owner, bench);
  await sync(owner, server);

  // The owner cancels on a phone whose clock is behind; the technician, unaware, starts work later
  // but syncs first. The server accepts the start, then the cancel (an in-repair ticket is open).
  await owner.run('cancelTicket', { ticketId, reason: 'Pelanggan batal' }, owner.storeOwnerId);
  await bench.run('startWork', { ticketId, beforePhotos: [bench.photo(30)] }, bench.technicianId);
  await sync(bench, server);
  await sync(owner, server);

  const ticket = await ticketOf(server, ticketId);
  expect(ticket.outcome).toBe('cancelled');
  expect(ticket.cancelledBy).toBe(owner.storeOwnerId);
  await expectSameAsServer(ctx, [bench, owner]);
});

test('a repair marked done after an earlier-signed cancel does not undo the cancel', async () => {
  const ctx = await devices(411);
  const { a: owner, b: bench, server, sync } = ctx;
  const { ticketId } = (await owner.run('openTicket', intake(owner), owner.cashierId)) as {
    ticketId: string;
  };
  await sync(owner, bench);
  await bench.run('startWork', { ticketId, beforePhotos: [bench.photo(30)] }, bench.technicianId);
  await sync(owner, server);
  await sync(bench, server);
  await sync(bench, owner);

  await owner.run('cancelTicket', { ticketId, reason: 'Pelanggan batal' }, owner.storeOwnerId);
  await bench.run(
    'markRepaired',
    { ticketId, note: 'Selesai', afterPhotos: [bench.photo(31)] },
    bench.technicianId,
  );
  await sync(bench, server);
  await sync(owner, server);

  expect((await ticketOf(server, ticketId)).outcome).toBe('cancelled');
  await expectSameAsServer(ctx, [owner, bench]);
});

test('a price change signed on a phone running behind still counts in the total', async () => {
  const ctx = await devices(421);
  // The counter that opens the ticket runs ahead; the one that adds the agreed part runs behind.
  const { b: front, a: back, server, sync } = ctx;
  const { ticketId } = (await front.run('openTicket', intake(front), front.cashierId)) as {
    ticketId: string;
  };
  await sync(front, back);
  await sync(front, server);
  await back.run(
    'changeQuote',
    {
      ticketId,
      kind: 'part',
      description: 'Flex',
      amount: 50_000,
      reason: 'Putus',
      customerAgreed: true,
    },
    back.cashierId,
  );
  await sync(back, server);

  expect((await ticketOf(server, ticketId)).quoteTotal).toBe(800_000);
  await expectSameAsServer(ctx, [back, front]);
});

test('a decision signed before its proposal still decides it', async () => {
  const ctx = await devices(431);
  // The technician's phone runs ahead of the counter's.
  const { b: bench, a: counter, server, sync } = ctx;
  const { ticketId } = (await counter.run('openTicket', intake(counter), counter.cashierId)) as {
    ticketId: string;
  };
  await sync(counter, bench);
  await sync(counter, server);
  const proposal = (await bench.run(
    'proposeQuoteChange',
    { ticketId, kind: 'part', description: 'Baterai', amount: 200_000, reason: 'Kembung' },
    bench.technicianId,
  )) as { lineId: string };
  const decline = (await bench.run(
    'proposeQuoteChange',
    { ticketId, kind: 'labour', description: 'Bersihkan', amount: 30_000, reason: 'Kotor' },
    bench.technicianId,
  )) as { lineId: string };
  await sync(bench, counter);
  await sync(bench, server);
  await counter.run(
    'applyProposal',
    { ticketId, lineId: proposal.lineId, customerAgreed: true },
    counter.cashierId,
  );
  await counter.run(
    'declineProposal',
    { ticketId, lineId: decline.lineId, note: 'Mahal' },
    counter.cashierId,
  );
  await sync(counter, server);

  const ticket = await ticketOf(server, ticketId);
  const status = (lineId: string) =>
    ticket.quoteLines.find((line: { id: string }) => line.id === lineId).status;
  expect(status(proposal.lineId)).toBe('applied');
  expect(status(decline.lineId)).toBe('declined');
  expect(ticket.quoteTotal).toBe(950_000);
  await expectSameAsServer(ctx, [counter, bench]);
});

test('work started on a phone running behind is not lost when it folds before the intake', async () => {
  const ctx = await devices(441);
  const { b: front, a: bench, server, sync } = ctx;
  const { ticketId } = (await front.run('openTicket', intake(front), front.cashierId)) as {
    ticketId: string;
  };
  await sync(front, bench);
  await sync(front, server);
  await bench.run('startWork', { ticketId, beforePhotos: [bench.photo(30)] }, bench.technicianId);
  await bench.run('markWaitingForParts', { ticketId, note: 'Tunggu LCD' }, bench.technicianId);
  await sync(bench, server);

  const ticket = await ticketOf(server, ticketId);
  expect(ticket.outcome).toBe('waiting_for_parts');
  expect(ticket.outcomeNote).toBe('Tunggu LCD');
  expect(ticket.technicianId).toBe(bench.technicianId);
  await expectSameAsServer(ctx, [bench, front]);
});

test('a cancel signed before the intake it cancels keeps its fee and stays cancelled', async () => {
  const ctx = await devices(451);
  const { b: front, a: owner, server, sync } = ctx;
  const { ticketId } = (await front.run('openTicket', intake(front), front.cashierId)) as {
    ticketId: string;
  };
  await sync(front, owner);
  await sync(front, server);
  await owner.run(
    'cancelTicket',
    { ticketId, reason: 'Pelanggan batal', fee: 0 },
    owner.storeOwnerId,
  );
  await sync(owner, server);

  const ticket = await ticketOf(server, ticketId);
  expect(ticket.outcome).toBe('cancelled');
  expect(ticket.cancelledBy).toBe(owner.storeOwnerId);
  expect(ticket.cancelFee).toBe(0);
  await expectSameAsServer(ctx, [owner, front]);
});

/** A ticket opened and repaired on `front`, known to every device given. */
async function repairedOn(
  ctx: Awaited<ReturnType<typeof devices>>,
  front: RepairHarness,
  others: readonly RepairHarness[],
): Promise<string> {
  const { ticketId } = (await front.run('openTicket', intake(front), front.cashierId)) as {
    ticketId: string;
  };
  await front.run('startWork', { ticketId, beforePhotos: [front.photo(30)] }, front.technicianId);
  await front.run('markRepaired', { ticketId, afterPhotos: [front.photo(31)] }, front.technicianId);
  for (const to of others) await ctx.sync(front, to);
  return ticketId;
}

async function handoverSlots(h: RepairHarness, ticketId: string): Promise<string[]> {
  const db = h.db as unknown as Kysely<never>;
  const { rows } = await sql<{ slot: string; mediaId: string }>`
    SELECT slot, media_id AS "mediaId" FROM repair_ticket_photos
    WHERE ticket_id = ${ticketId} AND slot IN ('handover', 'signature') ORDER BY slot
  `.execute(db);
  return rows.map((row) => `${row.slot}:${row.mediaId}`);
}

test('a handover taken back on a phone running behind still leaves the phone in the store', async () => {
  const ctx = await devices(461);
  const { b: front, a: owner, server, sync } = ctx;
  const ticketId = await repairedOn(ctx, front, [owner, server]);
  await front.run('returnDevice', (await paidHandover(front, ticketId)) as never, front.cashierId);
  await sync(front, owner);
  await sync(front, server);
  // The owner's clock is behind the counter's: the undo is signed "before" the handover.
  await owner.run('undoHandover', { ticketId, reason: 'Salah servisan' }, owner.ownerId);
  await sync(owner, server);

  const ticket = await ticketOf(server, ticketId);
  expect(ticket.location).toBe('in_store');
  expect(ticket.returnedBy).toBeNull();
  expect(await handoverSlots(server, ticketId)).toEqual([]);
  await expectSameAsServer(ctx, [owner, front]);
});

test('handed over again after an undo signed behind it, the phone is out with the new evidence', async () => {
  const ctx = await devices(471);
  const { b: front, a: owner, server, sync } = ctx;
  const ticketId = await repairedOn(ctx, front, [owner, server]);
  await front.run('returnDevice', (await paidHandover(front, ticketId)) as never, front.cashierId);
  const firstAt = (await ticketOf(front, ticketId)).returnedAt as number;
  await sync(front, owner);
  await sync(front, server);
  await owner.run('undoHandover', { ticketId, reason: 'Salah servisan' }, owner.ownerId);
  await sync(owner, front);
  await sync(owner, server);
  const again = (await paidHandover(front, ticketId, {}, [40, 41])) as {
    handoverPhoto: { mediaId: string };
    signature: { mediaId: string };
  };
  await front.run('returnDevice', again as never, front.cashierId);
  await sync(front, server);

  const ticket = await ticketOf(server, ticketId);
  expect(ticket.location).toBe('returned');
  expect(ticket.returnedBy).toBe(front.cashierId);
  // The warranty counts from the first handover.
  expect(ticket.returnedAt).toBe(firstAt);
  expect(await handoverSlots(server, ticketId)).toEqual([
    `handover:${again.handoverPhoto.mediaId}`,
    `signature:${again.signature.mediaId}`,
  ]);
  await expectSameAsServer(ctx, [owner, front]);
});

test('a correction signed before the intake it corrects is applied once the intake arrives', async () => {
  const ctx = await devices(481);
  const { b: front, a: owner, server, sync } = ctx;
  const { ticketId } = (await front.run('openTicket', intake(front), front.cashierId)) as {
    ticketId: string;
  };
  await sync(front, owner);
  await sync(front, server);
  await owner.run(
    'correctTicketDetails',
    { ticketId, complaint: 'Layar bergaris', passcode: 'pin:1234', reason: 'Salah ketik' },
    owner.ownerId,
  );
  await sync(owner, server);

  const ticket = await ticketOf(server, ticketId);
  expect(ticket.complaint).toBe('Layar bergaris');
  await expectSameAsServer(ctx, [owner, front]);
  // The history says what changed, and never keeps the screen lock it set.
  const db = ctx.other.db as unknown as Kysely<never>;
  const { rows } = await sql<{ detailJson: string }>`
    SELECT detail_json AS "detailJson" FROM repair_ticket_events
    WHERE ticket_id = ${ticketId} AND kind = 'repair.ticket_details_corrected'
  `.execute(db);
  const detail = JSON.parse(rows[0]!.detailJson) as Record<string, unknown>;
  expect(detail['pending']).toBeUndefined();
  expect(detail['changes']).toEqual(
    expect.arrayContaining([expect.objectContaining({ field: 'complaint', to: 'Layar bergaris' })]),
  );
  expect(rows[0]!.detailJson).not.toContain('1234');
});
