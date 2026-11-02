// A servisan's history, as both apps show it: who was given the work, and what a price change was
// for and how much, read from what the real commands recorded.
import { afterEach, beforeAll, describe, expect, test } from 'vitest';

import { formatMoney, initI18n } from '@bolusi/i18n';

import idCatalog from '../repair/i18n/id.json' with { type: 'json' };
import enCatalog from '../repair/i18n/en.json' with { type: 'json' };
import { REPAIR_OP } from '../src/repair/constants.js';
import { BOARD_EMPTY_KEY, BOARD_VIEWS, repairedDoneKey } from '../src/repair/flows.js';
import { registerRepairCatalog, tn } from '../src/repair/i18n.js';
import { historyEntry } from '../src/repair/labels.js';
import type { TicketEventRow } from '../src/repair/queries.js';

import { intake, openRepairHarness, type RepairHarness } from './support/repair-harness.js';

beforeAll(() => {
  initI18n({ locale: 'id' });
  registerRepairCatalog({ id: idCatalog, en: enCatalog });
});

const open: RepairHarness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

async function events(h: RepairHarness, ticketId: string): Promise<readonly TicketEventRow[]> {
  return (await h.query('getTicket', { ticketId }, h.cashierId)).rows[0]!.events;
}

describe('the history', () => {
  test('an assignment says who got the work, beside who gave it', async () => {
    const h = await openRepairHarness(7401);
    open.push(h);
    const { ticketId } = (await h.run('openTicket', intake(h), h.cashierId)) as {
      ticketId: string;
    };
    await h.db
      .insertInto('usersDirectory')
      .values({ id: h.technicianId, name: 'Budi', status: 'active', photoMediaId: null })
      .execute();
    await h.run('assignTechnician', { ticketId, technicianId: h.technicianId }, h.cashierId);
    const assigned = (await events(h, ticketId)).find(
      (event) => event.kind === REPAIR_OP.technicianAssigned,
    )!;
    expect(assigned.technicianName).toBe('Budi');
    const entry = historyEntry(assigned);
    expect(entry.title).toBe('Teknisi ditunjuk');
    expect(entry.detail).toBe('Teknisi: Budi');
    // Only an assignment names a technician.
    const opened = (await events(h, ticketId)).find(
      (event) => event.kind === REPAIR_OP.ticketOpened,
    )!;
    expect(opened.technicianName).toBeNull();
  });

  test('a proposed price change says what it is for and how much', async () => {
    const h = await openRepairHarness(7402);
    open.push(h);
    const { ticketId } = (await h.run('openTicket', intake(h), h.cashierId)) as {
      ticketId: string;
    };
    await h.run('startWork', { ticketId, beforePhotos: [h.photo(1)] }, h.technicianId);
    await h.run(
      'proposeQuoteChange',
      {
        ticketId,
        kind: 'part',
        description: 'Ganti baterai',
        amount: 200_000,
        reason: 'Baterai kembung',
      },
      h.technicianId,
    );
    const proposed = (await events(h, ticketId)).find(
      (event) => event.kind === REPAIR_OP.quoteChangeProposed,
    )!;
    expect(historyEntry(proposed).detail).toBe(
      [`Ganti baterai · ${formatMoney(200_000)}`, 'Baterai kembung'].join('\n'),
    );
  });
});

describe('what the screens say', () => {
  test('marking it repaired says so plainly, unless a new price still waits on the customer', () => {
    expect(repairedDoneKey({ pendingProposals: 0 })).toBe('repair.done.repaired');
    expect(repairedDoneKey(undefined)).toBe('repair.done.repaired');
    expect(repairedDoneKey({ pendingProposals: 1 })).toBe('repair.done.repairedPriceWaiting');
  });

  test('each empty queue says what is missing from it, each in its own words', () => {
    const said = BOARD_VIEWS.map((view) => tn(BOARD_EMPTY_KEY[view]));
    expect(new Set(said).size).toBe(BOARD_VIEWS.length);
    expect(said).not.toContain('Belum ada data');
  });
});
