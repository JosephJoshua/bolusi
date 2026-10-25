// Repair search on a device: the live index sees local commands, pulled ops and rebuilds without
// being reloaded wholesale, and returns fresh rows.
import { afterEach, expect, test } from 'vitest';

import { intake, openRepairHarness, type RepairHarness } from './support/repair-harness.js';

const open: RepairHarness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

const ids = (page: { rows: readonly { id: string }[] }) => page.rows.map((row) => row.id);

test('a corrected name is found by the new name, not the old one, through the warm index', async () => {
  const h = await openRepairHarness(401);
  open.push(h);
  const opened = (await h.run('openTicket', intake(h), h.cashierId)) as {
    ticketId: string;
    customerId: string;
  };
  expect(ids(await h.query('searchTickets', { text: 'yohanis wenda' }, h.cashierId))).toEqual([
    opened.ticketId,
  ]);

  await h.run(
    'correctCustomerDetails',
    { customerId: opened.customerId, name: 'Petrus Mofu', phone: null },
    h.cashierId,
  );

  const byNewName = await h.query('searchTickets', { text: 'petrus mofu' }, h.cashierId);
  expect(byNewName.rows).toEqual([
    expect.objectContaining({
      id: opened.ticketId,
      customerName: 'Petrus Mofu',
      customerPhone: null,
    }),
  ]);
  expect((await h.query('searchTickets', { text: 'yohanis wenda' }, h.cashierId)).rows).toEqual([]);
  expect((await h.query('searchTickets', { text: '0812 4455 6677' }, h.cashierId)).rows).toEqual(
    [],
  );
  expect(ids(await h.query('searchCustomers', { text: 'petrus' }, h.cashierId))).toEqual([
    opened.customerId,
  ]);
});

test('tickets pulled from another device become searchable, and a rebuild keeps them', async () => {
  const a = await openRepairHarness(402);
  open.push(a);
  const opened = (await a.run('openTicket', intake(a), a.cashierId)) as { ticketId: string };
  const b = await openRepairHarness(403, {
    tenantId: a.tenantId,
    storeId: a.storeId,
    users: [a.cashierId, a.technicianId, a.technician2Id, a.zeroUserId],
  });
  open.push(b);

  // Warm b's index while it has nothing.
  expect((await b.query('searchTickets', { text: 'wenda' }, b.cashierId)).rows).toEqual([]);

  let arrival = 1;
  for (const op of await a.ownOps()) await b.deliverPulled(op, arrival++);
  expect(ids(await b.query('searchTickets', { text: 'wnda' }, b.cashierId))).toEqual([
    opened.ticketId,
  ]);

  await b.engine.rebuild('repair');
  expect(ids(await b.query('searchTickets', { text: 'wnda' }, b.cashierId))).toEqual([
    opened.ticketId,
  ]);
});
