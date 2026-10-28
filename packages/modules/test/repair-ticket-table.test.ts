// The counter table's reads: filters, column sorts, page numbers and a total that agrees with them.
import { afterEach, describe, expect, test } from 'vitest';

import { DomainError } from '@bolusi/core';

import { openRepairHarness, intake, type RepairHarness } from './support/repair-harness.js';

let h: RepairHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

interface Row {
  id: string;
  ticketNumber: string;
  customerName: string;
  quoteTotal: number;
  createdAt: number;
  technicianId: string | null;
}

async function open(
  harness: RepairHarness,
  name: string,
  brand: string,
  amount: number,
): Promise<string> {
  const opened = (await harness.run(
    'openTicket',
    intake(harness, {
      customer: { name, phone: `0812${String(amount).padStart(8, '0')}` },
      device: { brand, model: 'X' },
      quoteLines: [{ kind: 'part', description: 'Part', amount }],
    }),
    harness.cashierId,
  )) as { ticketId: string };
  return opened.ticketId;
}

async function list(harness: RepairHarness, input: Record<string, unknown>): Promise<Row[]> {
  return (await harness.query('listTickets', input, harness.cashierId)).rows as Row[];
}

async function count(harness: RepairHarness, input: Record<string, unknown>): Promise<number> {
  const result = await harness.query('countTickets', input, harness.cashierId);
  return (result.rows[0] as { count: number }).count;
}

describe('ticket table reads', () => {
  test('sorts by a column and pages by offset, with a count that matches the filter', async () => {
    h = await openRepairHarness(301);
    await open(h, 'Benny', 'Samsung', 300_000);
    await open(h, 'Agustina', 'oppo', 100_000);
    await open(h, 'Corneles', 'OPPO', 200_000);

    const byTotal = await list(h, { sort: 'total.desc' });
    expect(byTotal.map((row) => row.customerName)).toEqual(['Benny', 'Corneles', 'Agustina']);

    // Ticket numbers count up as tickets open: Benny, Agustina, Corneles.
    const byNumber = await list(h, { sort: 'number.asc', limit: 2 });
    expect(byNumber.map((row) => row.customerName)).toEqual(['Benny', 'Agustina']);
    const secondPage = await list(h, { sort: 'number.asc', limit: 2, offset: 2 });
    expect(secondPage.map((row) => row.customerName)).toEqual(['Corneles']);

    // Brand case folds: "oppo" and "OPPO" are one brand, in the filter and in its options.
    const oppo = { filter: { brands: ['Oppo'] } };
    expect(await list(h, oppo)).toHaveLength(2);
    expect(await count(h, oppo)).toBe(2);
    expect(await count(h, {})).toBe(3);
    const brands = (await h.query('ticketBrands', {}, h.cashierId)).rows;
    expect(brands).toEqual([
      { brand: expect.stringMatching(/^oppo$/i) as unknown, count: 2 },
      { brand: 'Samsung', count: 1 },
    ]);
  });

  test('filters by received time and by technicians, unassigned included on request', async () => {
    h = await openRepairHarness(302);
    const first = await open(h, 'Benny', 'Samsung', 300_000);
    const second = await open(h, 'Agustina', 'Oppo', 100_000);
    const third = await open(h, 'Corneles', 'Vivo', 200_000);
    await h.run('assignTechnician', { ticketId: first, technicianId: h.technicianId }, h.cashierId);

    const all = await list(h, { sort: 'createdAt.asc' });
    const secondAt = all.find((row) => row.id === second)!.createdAt;
    const from = await list(h, { filter: { receivedFrom: secondAt } });
    expect(from.map((row) => row.id).sort()).toEqual([second, third].sort());
    const before = await list(h, { filter: { receivedBefore: secondAt } });
    expect(before.map((row) => row.id)).toEqual([first]);

    const held = await list(h, { filter: { technicianIds: [h.technicianId] } });
    expect(held.map((row) => row.id)).toEqual([first]);
    const heldOrFree = { filter: { technicianIds: [h.technicianId], unassigned: true } };
    expect(await list(h, heldOrFree)).toHaveLength(3);
    expect(await count(h, { filter: { unassigned: true } })).toBe(2);
  });

  test('a column sort cannot page by cursor, and a cursor cannot be combined with an offset', async () => {
    h = await openRepairHarness(303);
    await open(h, 'Benny', 'Samsung', 300_000);
    for (const input of [
      { sort: 'total.desc', cursor: 'abc' },
      // Names are encrypted at rest, so SQL cannot sort by them.
      { sort: 'customer.asc' },
      { cursor: 'abc', offset: 10 },
    ]) {
      const err = await h.query('listTickets', input, h.cashierId).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DomainError);
    }
  });
});
