// Two people take the same servisan at once, one of them offline. A plain claim never takes a
// servisan someone else took meanwhile: the server refuses it, and the work started with it, so the
// one who took it first keeps it everywhere and the other is told why. Starting work on a servisan
// someone else holds takes it over in the same step, by name.
import { sql, type Kysely } from 'kysely';
import { afterEach, expect, test } from 'vitest';

import { intake, type RepairHarness } from './support/repair-harness.js';
import { judgedStore } from './support/judged-store.js';

const open: RepairHarness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

async function ticketOf(h: RepairHarness, ticketId: string) {
  return (await h.query('getTicket', { ticketId }, h.ownerId)).rows[0];
}

async function dump(h: RepairHarness): Promise<Record<string, unknown[]>> {
  const db = h.db as unknown as Kysely<never>;
  const out: Record<string, unknown[]> = {};
  for (const table of ['repair_tickets', 'repair_ticket_events', 'repair_ticket_photos']) {
    const rows = await sql<Record<string, unknown>>`SELECT * FROM ${sql.table(table)}`.execute(db);
    out[table] = rows.rows.map((row) => JSON.stringify(row, Object.keys(row).sort())).sort();
  }
  return out;
}

/** A servisan nobody holds yet, known to both devices and the server. */
async function unclaimed(seed: number) {
  const ctx = await judgedStore(seed, open);
  const { ticketId } = (await ctx.first.run(
    'openTicket',
    intake(ctx.first),
    ctx.first.cashierId,
  )) as {
    ticketId: string;
  };
  await ctx.push(ctx.first);
  await ctx.pull(ctx.second);
  return { ...ctx, ticketId };
}

for (const benchSignsFirst of [true, false]) {
  const when = benchSignsFirst ? 'signed first' : 'signed later';

  test(`an offline claim and start (${when}) lose to a claim that reached the server first`, async () => {
    const {
      first: bench,
      second: owner,
      server,
      other,
      push,
      pull,
      refused,
      ticketId,
    } = await unclaimed(benchSignsFirst ? 901 : 911);
    // The bench phone runs behind the owner's; moving it past signs its work after the owner.
    if (!benchSignsFirst) bench.advance(2_000_000);
    await bench.run('startWork', { ticketId, beforePhotos: [bench.photo(30)] }, bench.technicianId);
    await owner.run('claimTicket', { ticketId }, owner.ownerId);
    await push(owner);
    await push(bench);

    // The technician's claim and the work it started are refused, each with why; the photos stand.
    expect(refused).toEqual([
      'repair.ticket_claimed:repair.refusal.takenElsewhere',
      'repair.work_started:repair.refusal.takenElsewhere',
    ]);
    await pull(owner);
    await pull(other);
    for (const h of [server, owner, other]) {
      expect(await ticketOf(h, ticketId)).toMatchObject({
        technicianId: owner.ownerId,
        outcome: 'received',
      });
    }
    expect(await dump(other)).toStrictEqual(await dump(server));
  });

  test(`an offline claim and start (${when}) that reached the server first keep the servisan`, async () => {
    const {
      first: bench,
      second: owner,
      server,
      other,
      push,
      pull,
      refused,
      ticketId,
    } = await unclaimed(benchSignsFirst ? 921 : 931);
    if (!benchSignsFirst) bench.advance(2_000_000);
    await bench.run('startWork', { ticketId, beforePhotos: [bench.photo(30)] }, bench.technicianId);
    await owner.run('claimTicket', { ticketId }, owner.ownerId);
    await push(bench);
    await push(owner);

    expect(refused).toEqual(['repair.ticket_claimed:repair.refusal.takenElsewhere']);
    await pull(bench);
    await pull(other);
    // The owner's own refused claim comes off it when its push is refused (core sync refolds).
    for (const h of [server, bench, other]) {
      expect(await ticketOf(h, ticketId)).toMatchObject({
        technicianId: bench.technicianId,
        outcome: 'in_repair',
      });
    }
    expect(await dump(other)).toStrictEqual(await dump(server));
  });
}

test('starting a servisan someone else holds takes it over by name', async () => {
  const { first, second, server, other, push, pull, refused, ticketId } = await unclaimed(941);
  await first.run('claimTicket', { ticketId }, first.technician2Id);
  await push(first);
  await pull(second);
  await second.run(
    'startWork',
    { ticketId, beforePhotos: [second.photo(30)] },
    second.technicianId,
  );
  await push(second);
  expect(refused).toEqual([]);
  await pull(other);
  for (const h of [server, other]) {
    expect(await ticketOf(h, ticketId)).toMatchObject({
      technicianId: second.technicianId,
      outcome: 'in_repair',
    });
  }
  const claims = (await second.ownOps()).filter((op) => op.type === 'repair.ticket_claimed');
  expect(claims.map((op) => op.payload)).toEqual([{ from: first.technician2Id }]);
});

test('a take-over of someone who already lost the servisan is refused', async () => {
  const { first, second, push, pull, refused, ticketId } = await unclaimed(951);
  await first.run('claimTicket', { ticketId }, first.technicianId);
  await push(first);
  await pull(second);
  // Both take it over from the technician, neither aware of the other: the first to arrive wins.
  await first.run('claimTicket', { ticketId }, first.ownerId);
  await second.run('claimTicket', { ticketId }, second.technician2Id);
  await push(first);
  await push(second);
  expect(refused).toEqual(['repair.ticket_claimed:repair.refusal.takenElsewhere']);
});
