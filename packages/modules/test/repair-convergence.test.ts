// Offline convergence for repair tickets: a phone that receives another device's ticket ops in
// any order (late sync, reordered pulls) must end with exactly the same rows, including the money
// total, as the device that wrote them.
import { sql, type Kysely } from 'kysely';
import { afterEach, expect, test } from 'vitest';

import type { SignedOperation } from '@bolusi/schemas';
import { mulberry32 } from '@bolusi/test-support';

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

async function dump(db: Kysely<never>): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const table of TABLES) {
    const rows = await sql<Record<string, unknown>>`SELECT * FROM ${sql.table(table)}`.execute(db);
    out[table] = rows.rows.map((row) => JSON.stringify(row, Object.keys(row).sort())).sort();
  }
  return out;
}

function shuffled<T>(items: readonly T[], seed: number): T[] {
  const prng = mulberry32(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(prng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

async function writeJourney(a: RepairHarness): Promise<void> {
  const first = (await a.run('openTicket', intake(a), a.cashierId)) as {
    ticketId: string;
    customerId: string;
  };
  const second = (await a.run(
    'openTicket',
    intake(a, { customer: { name: 'Mama Wenda', phone: '0813 1111 2222' } }),
    a.cashierId,
  )) as { ticketId: string; customerId: string };

  await a.run(
    'startWork',
    { ticketId: first.ticketId, beforePhotos: [a.photo(20)] },
    a.technicianId,
  );
  const proposal = (await a.run(
    'proposeQuoteChange',
    {
      ticketId: first.ticketId,
      kind: 'part',
      description: 'Flex',
      amount: 40_000,
      reason: 'Putus',
    },
    a.technicianId,
  )) as { lineId: string };
  await a.run(
    'applyProposal',
    { ticketId: first.ticketId, lineId: proposal.lineId, customerAgreed: true },
    a.cashierId,
  );
  await a.run(
    'changeQuote',
    {
      ticketId: first.ticketId,
      kind: 'discount',
      description: 'Diskon',
      amount: -20_000,
      reason: 'Langganan',
      customerAgreed: true,
    },
    a.storeOwnerId,
  );
  const unconfirmed = (await a.run(
    'changeQuote',
    {
      ticketId: first.ticketId,
      kind: 'labour',
      description: 'Bersihkan',
      amount: 15_000,
      reason: 'Kotor',
      customerAgreed: false,
    },
    a.cashierId,
  )) as { lineId: string };
  await a.run(
    'applyProposal',
    { ticketId: first.ticketId, lineId: unconfirmed.lineId, customerAgreed: true },
    a.cashierId,
  );
  await a.run(
    'markRepaired',
    { ticketId: first.ticketId, note: 'OK', afterPhotos: [a.photo(21)] },
    a.technicianId,
  );
  await a.run('returnDevice', (await paidHandover(a, first.ticketId)) as never, a.cashierId);
  await a.run(
    'cancelTicket',
    { ticketId: second.ticketId, reason: 'Tidak jadi', fee: 25_000 },
    a.storeOwnerId,
  );
  await a.run(
    'correctCustomerDetails',
    { customerId: second.customerId, name: 'Mama Wenda', phone: '081200000000' },
    a.cashierId,
  );
}

test('any arrival order converges to the writer’s rows, re-folding along the way', async () => {
  const a = await openRepairHarness(101);
  open.push(a);
  await writeJourney(a);
  const ops: SignedOperation[] = await a.ownOps();
  const expected = await dump(a.db as unknown as Kysely<never>);
  expect(expected['repair_tickets']).toHaveLength(2);

  let refolds = 0;
  for (const seed of [1, 2, 3, 4, 5]) {
    const b = await openRepairHarness(200 + seed, {
      tenantId: a.tenantId,
      storeId: a.storeId,
      users: [
        a.cashierId,
        a.technicianId,
        a.technician2Id,
        a.zeroUserId,
        a.ownerId,
        a.storeOwnerId,
      ],
    });
    open.push(b);
    const before = b.engine.stats.snapshot().refolds;
    let arrival = 1;
    for (const op of shuffled(ops, seed)) await b.deliverPulled(op, arrival++);
    refolds += b.engine.stats.snapshot().refolds - before;
    expect(await dump(b.db as unknown as Kysely<never>)).toStrictEqual(expected);
  }
  // A run that never re-folded would prove nothing about out-of-order arrival.
  expect(refolds).toBeGreaterThan(0);
});

test('replaying the same ops twice changes nothing (no double-counted money)', async () => {
  const a = await openRepairHarness(102);
  open.push(a);
  await writeJourney(a);
  const ops = await a.ownOps();
  const b = await openRepairHarness(300, {
    tenantId: a.tenantId,
    storeId: a.storeId,
    users: [a.cashierId, a.technicianId, a.technician2Id, a.zeroUserId, a.ownerId, a.storeOwnerId],
  });
  open.push(b);
  let arrival = 1;
  for (const op of ops) await b.deliverPulled(op, arrival++);
  const once = await dump(b.db as unknown as Kysely<never>);
  await b.engine.rebuild('repair');
  expect(await dump(b.db as unknown as Kysely<never>)).toStrictEqual(once);
});

test('two devices acting on one ticket offline converge; approval beats a concurrent decline', async () => {
  const a = await openRepairHarness(103);
  open.push(a);
  const b = await openRepairHarness(104, {
    tenantId: a.tenantId,
    storeId: a.storeId,
    users: [a.cashierId, a.technicianId, a.technician2Id, a.zeroUserId, a.ownerId, a.storeOwnerId],
  });
  open.push(b);

  const opened = (await a.run('openTicket', intake(a), a.cashierId)) as { ticketId: string };
  const ticketId = opened.ticketId;
  await a.run('startWork', { ticketId, beforePhotos: [a.photo(20)] }, a.technicianId);
  const proposal = (await a.run(
    'proposeQuoteChange',
    { ticketId, kind: 'part', description: 'Baterai', amount: 200_000, reason: 'Kembung' },
    a.technicianId,
  )) as { lineId: string };
  await a.run('markRepaired', { ticketId, afterPhotos: [a.photo(21)] }, a.technicianId);

  // Sync A → B, then both go offline.
  let arrivalB = 1;
  for (const op of await a.ownOps()) await b.deliverPulled(op, arrivalB++);
  const synced = new Set((await a.ownOps()).map((op) => op.id));

  await a.run(
    'applyProposal',
    { ticketId, lineId: proposal.lineId, customerAgreed: true },
    a.cashierId,
  );
  await b.run('declineProposal', { ticketId, lineId: proposal.lineId, note: 'Mahal' }, b.cashierId);
  await a.run('returnDevice', (await paidHandover(a, ticketId)) as never, a.cashierId);
  await b.run('returnDevice', (await paidHandover(b, ticketId)) as never, b.cashierId);

  // Reconnect: each receives the other's offline ops.
  let arrivalA = 1;
  for (const op of await b.ownOps()) await a.deliverPulled(op, arrivalA++);
  for (const op of await a.ownOps()) if (!synced.has(op.id)) await b.deliverPulled(op, arrivalB++);

  const dumpA = await dump(a.db as unknown as Kysely<never>);
  expect(await dump(b.db as unknown as Kysely<never>)).toStrictEqual(dumpA);

  const t = (await a.query('getTicket', { ticketId }, a.cashierId)).rows[0];
  expect(t.location).toBe('returned');
  expect(t.quoteLines.find((l: { id: string }) => l.id === proposal.lineId).status).toBe('applied');
  expect(t.quoteTotal).toBe(950_000);
  expect(t.photos.filter((p: { slot: string }) => p.slot === 'signature')).toHaveLength(1);
});
