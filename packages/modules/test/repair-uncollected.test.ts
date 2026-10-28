// Phones nobody collected, through the real runtime: a finished phone records when it was ready to
// collect, a reopen clears that, the board's view lists the ones past the store's limit (longest
// waiting first), and only owners set the limit, for their own store.
import { afterEach, describe, expect, test } from 'vitest';

import { DomainError } from '@bolusi/core';

import { DEFAULT_UNCOLLECTED_DAYS, REPAIR_OP } from '../src/repair/constants.js';
import { boardFilter, uncollectedBefore, uncollectedDays } from '../src/repair/flows.js';
import { listTicketsInput } from '../src/repair/queries.js';
import { repairOperations, storeUncollectedDaysChangedPayload } from '../src/repair/operations.js';

import { intake, openRepairHarness, type RepairHarness } from './support/repair-harness.js';

const DAY = 86_400_000;

const open: RepairHarness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

async function harness(seed: number): Promise<RepairHarness> {
  const h = await openRepairHarness(seed);
  open.push(h);
  return h;
}

async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  const err = await p.then(
    () => new Error(`expected ${code}, but the call resolved`),
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DomainError);
  expect((err as DomainError).code).toBe(code);
}

async function openTicket(h: RepairHarness): Promise<string> {
  const { ticketId } = (await h.run('openTicket', intake(h), h.cashierId)) as { ticketId: string };
  return ticketId;
}

async function repair(h: RepairHarness, ticketId: string, n: number): Promise<void> {
  await h.run('startWork', { ticketId, beforePhotos: [h.photo(n)] }, h.technicianId);
  await h.run('markRepaired', { ticketId, afterPhotos: [h.photo(n + 1)] }, h.technicianId);
}

async function ticket(h: RepairHarness, ticketId: string) {
  return (await h.query('getTicket', { ticketId }, h.cashierId)).rows[0];
}

function eventAt(row: { events: { kind: string; at: number }[] }, kind: string): number {
  return row.events.filter((e) => e.kind === kind).at(-1)!.at;
}

describe('when a phone was ready to collect', () => {
  test('marking it repaired or cancelling it records the time; a reopen clears it', async () => {
    const h = await harness(5301);
    const repaired = await openTicket(h);
    const cancelled = await openTicket(h);
    expect((await ticket(h, repaired)).readyAt).toBeNull();

    await repair(h, repaired, 1);
    const done = await ticket(h, repaired);
    expect(done.readyAt).toBe(eventAt(done, REPAIR_OP.markedRepaired));

    await h.run('cancelTicket', { ticketId: cancelled, reason: 'Batal', fee: 0 }, h.storeOwnerId);
    const gone = await ticket(h, cancelled);
    expect(gone.readyAt).toBe(gone.cancelledAt);

    await h.run('startWork', { ticketId: repaired }, h.technicianId);
    expect((await ticket(h, repaired)).readyAt).toBeNull();
    await h.run('markRepaired', { ticketId: repaired, afterPhotos: [h.photo(9)] }, h.technicianId);
    const again = await ticket(h, repaired);
    expect(again.readyAt).toBeGreaterThan(done.readyAt);
  });
});

describe('the not-collected view', () => {
  test('lists finished phones still in the store, ready before the cut-off, longest waiting first', async () => {
    const h = await harness(5302);
    const first = await openTicket(h);
    const second = await openTicket(h);
    const returned = await openTicket(h);
    const working = await openTicket(h);
    await repair(h, second, 1);
    await repair(h, first, 3);
    await repair(h, returned, 5);
    await h.run(
      'returnDevice',
      { ticketId: returned, handoverPhoto: h.photo(7), signature: h.photo(8) },
      h.cashierId,
    );
    await h.run('startWork', { ticketId: working, beforePhotos: [h.photo(9)] }, h.technicianId);

    const latest = (await ticket(h, first)).readyAt as number;
    const list = async (readyBefore: number) =>
      (
        await h.query(
          'listTickets',
          { filter: boardFilter('uncollected', h.cashierId, readyBefore), sort: 'readyAt.asc' },
          h.cashierId,
        )
      ).rows.map((r: { id: string }) => r.id);

    // The second was repaired first, so it has waited longest.
    expect(await list(latest + 1)).toEqual([second, first]);
    expect(await list(latest)).toEqual([second]);
    const count = await h.query(
      'countTickets',
      { filter: boardFilter('uncollected', h.cashierId, latest + 1) },
      h.cashierId,
    );
    expect(count.rows[0].count).toBe(2);

    // Pages by cursor, oldest first.
    const page = await h.query(
      'listTickets',
      {
        filter: boardFilter('uncollected', h.cashierId, latest + 1),
        sort: 'readyAt.asc',
        limit: 1,
      },
      h.cashierId,
    );
    const next = await h.query(
      'listTickets',
      {
        filter: boardFilter('uncollected', h.cashierId, latest + 1),
        sort: 'readyAt.asc',
        limit: 1,
        cursor: page.nextCursor,
      },
      h.cashierId,
    );
    expect([...page.rows, ...next.rows].map((r: { id: string }) => r.id)).toEqual([second, first]);
  });
  test('the longest-waiting order needs the cut-off, so its count always matches', () => {
    expect(listTicketsInput.safeParse({ sort: 'readyAt.asc' }).success).toBe(false);
    expect(
      listTicketsInput.safeParse({ sort: 'readyAt.asc', filter: { readyBefore: 1 } }).success,
    ).toBe(true);
  });
});

describe('flagging one phone', () => {
  const now = 1_800_000_000_000;
  const row = (readyAt: number | null, location: 'in_store' | 'returned' = 'in_store') => ({
    readyAt,
    location,
  });

  test('a phone past the limit shows the whole days it waited; others are not flagged', () => {
    expect(uncollectedDays(row(now - 63 * DAY - 5), 60, now)).toBe(63);
    expect(uncollectedDays(row(now - 60 * DAY - 1), 60, now)).toBe(60);
    expect(uncollectedDays(row(now - 60 * DAY), 60, now)).toBeNull();
    expect(uncollectedDays(row(null), 60, now)).toBeNull();
    expect(uncollectedDays(row(now - 90 * DAY, 'returned'), 60, now)).toBeNull();
    expect(uncollectedBefore(60, now)).toBe(now - 60 * DAY);
  });
});

describe('the store’s limit', () => {
  test('is two months until a store owner sets another; staff cannot change it', async () => {
    const h = await harness(5304);
    expect((await h.query('uncollectedDays', {}, h.cashierId)).rows[0]).toStrictEqual({
      days: DEFAULT_UNCOLLECTED_DAYS,
    });
    expect(DEFAULT_UNCOLLECTED_DAYS).toBe(60);
    for (const userId of [h.cashierId, h.technicianId, h.zeroUserId]) {
      await expectCode(h.run('setUncollectedDays', { days: 30 }, userId), 'PERMISSION_DENIED');
    }
    await h.run('setUncollectedDays', { days: 30 }, h.storeOwnerId);
    expect((await h.query('uncollectedDays', {}, h.technicianId)).rows[0]).toStrictEqual({
      days: 30,
    });
    await expectCode(h.run('setUncollectedDays', { days: 30 }, h.ownerId), 'VALIDATION_FAILED');
    await h.run('setUncollectedDays', { days: 45 }, h.ownerId);
    expect((await h.query('uncollectedDays', {}, h.cashierId)).rows[0].days).toBe(45);
  });

  test('is whole days from 1 to 365, in the command and in the signed payload', async () => {
    const h = await harness(5305);
    for (const days of [0, -5, 366, 1.5]) {
      await expectCode(h.run('setUncollectedDays', { days }, h.storeOwnerId), 'VALIDATION_FAILED');
    }
    const payload = storeUncollectedDaysChangedPayload;
    expect(repairOperations[REPAIR_OP.storeUncollectedDaysChanged]!.payload).toBe(payload);
    expect(payload.safeParse({ days: 1 }).success).toBe(true);
    expect(payload.safeParse({ days: 365 }).success).toBe(true);
    expect(payload.safeParse({ days: 0 }).success).toBe(false);
    expect(payload.safeParse({ days: 400 }).success).toBe(false);
    expect(payload.safeParse({ days: 30, extra: 1 }).success).toBe(false);
  });
});
