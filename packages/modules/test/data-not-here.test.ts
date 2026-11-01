// Least-privilege sync: a device holds only what its people may read. No query declares what it
// reads: the query runtime checks each table a handler touches (core query/reads-here.ts), so a
// query reading data that is not here says "Perlu internet" instead of answering from the empty
// copy. These are the shop cases that went wrong before: Kas said "Seharusnya di laci Rp 0" on a
// store phone, and a servisan number could repeat one.
import { describe, expect, test } from 'vitest';

import { intake, openRepairHarness } from './support/repair-harness.js';

describe('a query touching data the device does not hold says so', () => {
  test('Kas on a store phone without the money records needs internet, never Rp 0', async () => {
    const h = await openRepairHarness(4501, undefined, {
      readHere: (read) => read !== 'money.read',
    });
    try {
      await expect(h.moneyQuery('cashDrawer', {}, h.cashierId)).rejects.toMatchObject({
        code: 'NOT_ON_DEVICE',
        details: { permission: 'money.read' },
      });
    } finally {
      await h.close();
    }
  });

  test('a new servisan number is not counted from servisan that are not here', async () => {
    const h = await openRepairHarness(4502, undefined, {
      readHere: (read) => read !== 'repair.read',
    });
    try {
      await expect(
        h.query('nextTicketCounter', { deviceId: 'device-1' }, h.cashierId),
      ).rejects.toMatchObject({ code: 'NOT_ON_DEVICE' });
    } finally {
      await h.close();
    }
  });

  test('a technician opens a servisan on a device holding no money records', async () => {
    let moneyHere = true;
    const h = await openRepairHarness(4503, undefined, {
      readHere: (read) => read !== 'money.read' || moneyHere,
    });
    try {
      const { ticketId } = (await h.run('openTicket', intake(h), h.cashierId)) as {
        ticketId: string;
      };
      moneyHere = false;
      const page = await h.query('getTicket', { ticketId }, h.technicianId);
      expect(page.rows[0]).toMatchObject({ id: ticketId, refunds: [], downPayment: null });
      // The board too, sorted by what the customer owes.
      const board = await h.query(
        'listTickets',
        { sort: 'total.desc', limit: 20, offset: 0 },
        h.technicianId,
      );
      expect(board.rows.map((row: { id: string }) => row.id)).toEqual([ticketId]);
      // Whoever may read the money records needs them here to see what goes back.
      await expect(h.query('getTicket', { ticketId }, h.cashierId)).rejects.toMatchObject({
        code: 'NOT_ON_DEVICE',
      });
    } finally {
      await h.close();
    }
  });
});
