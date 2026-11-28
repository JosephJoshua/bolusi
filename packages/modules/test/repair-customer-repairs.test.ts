// A customer's other servisan, as the servisan page lists them: the same customer's other phones
// in this store, newest first, never the servisan itself and never another customer's.
import { afterEach, beforeAll, describe, expect, test } from 'vitest';

import { initI18n, keepCodeWhole } from '@bolusi/i18n';

import enCatalog from '../repair/i18n/en.json' with { type: 'json' };
import idCatalog from '../repair/i18n/id.json' with { type: 'json' };
import { otherRepairs, pastRepairLine } from '../src/repair/customer-repairs.js';
import { registerRepairCatalog } from '../src/repair/i18n.js';
import type { TicketSummaryRow } from '../src/repair/queries.js';

import { intake, openRepairHarness, type RepairHarness } from './support/repair-harness.js';

beforeAll(() => {
  initI18n({ locale: 'id' });
  registerRepairCatalog({ id: idCatalog, en: enCatalog });
});

const open: RepairHarness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

async function openTicket(
  h: RepairHarness,
  overrides: Record<string, unknown> = {},
): Promise<{ ticketId: string; customerId: string }> {
  return (await h.run('openTicket', intake(h, overrides), h.cashierId)) as {
    ticketId: string;
    customerId: string;
  };
}

async function customerRepairs(
  h: RepairHarness,
  customerId: string,
  ticketId: string,
): Promise<TicketSummaryRow[]> {
  const page = await h.query('listTickets', { filter: { customerId }, limit: 100 }, h.cashierId);
  return otherRepairs(page.rows as TicketSummaryRow[], ticketId);
}

describe("a customer's other servisan", () => {
  test('lists the same customer’s other servisan, newest first, without this one', async () => {
    const h = await openRepairHarness(11);
    open.push(h);
    const first = await openTicket(h);
    h.advance(60_000);
    const second = await openTicket(h, {
      customer: { customerId: first.customerId },
      device: { brand: 'Oppo', model: 'A57', color: 'Biru', imei: null },
      complaint: 'Baterai cepat habis',
    });
    h.advance(60_000);
    const third = await openTicket(h, { customer: { customerId: first.customerId } });
    // Someone else's phone never shows under this customer.
    await openTicket(h, { customer: { name: 'Maria Kogoya', phone: '0813-1111-2222' } });

    const rows = await customerRepairs(h, first.customerId, second.ticketId);
    expect(rows.map((row) => row.id)).toEqual([third.ticketId, first.ticketId]);

    const fromFirst = await customerRepairs(h, first.customerId, first.ticketId);
    expect(fromFirst.map((row) => row.id)).toEqual([third.ticketId, second.ticketId]);
  });

  test('a row names the phone, then the day, number, status and complaint', async () => {
    const h = await openRepairHarness(12);
    open.push(h);
    const first = await openTicket(h);
    const second = await openTicket(h, { customer: { customerId: first.customerId } });
    const [row] = await customerRepairs(h, first.customerId, second.ticketId);

    const line = pastRepairLine(row!);
    expect(line.device).toBe('Samsung Galaxy A14');
    expect(line.detail).toContain(keepCodeWhole(row!.ticketNumber));
    expect(line.detail).toContain('Baru masuk');
    expect(line.detail).toContain('Layar retak, sentuhan tidak responsif');
    expect(line.amount).toBe(750_000);
  });

  test('a customer with one servisan has nothing else to list', async () => {
    const h = await openRepairHarness(13);
    open.push(h);
    const only = await openTicket(h);
    expect(await customerRepairs(h, only.customerId, only.ticketId)).toEqual([]);
  });
});
