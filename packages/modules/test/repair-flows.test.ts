// The decisions behind the repair phone screens: which actions a ticket offers, and how an intake
// draft becomes an `openTicket` input. Both are checked against the real runtime, so a button the
// screens show never leads to a refusal the commands would give.
import { afterEach, describe, expect, test } from 'vitest';

import {
  boardFilter,
  emptyIntakeDraft,
  intakeDirty,
  intakeTotal,
  parseIntakeDraft,
  parseRupiah,
  readyAtFor,
  repairAbilities,
  stepProblems,
  ticketActions,
  toOpenTicketInput,
  type IntakeDraft,
  type TicketAction,
} from '../src/repair/flows.js';
import { INTAKE_PHOTO_SLOTS } from '../src/repair/constants.js';
import { openRepairHarness, intake, type RepairHarness } from './support/repair-harness.js';

let h: RepairHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

function abilitiesOf(harness: RepairHarness, userId: string) {
  const identity = {
    tenantId: harness.tenantId,
    storeId: harness.storeId,
    deviceId: harness.deviceId,
    userId,
  };
  return repairAbilities((id) =>
    harness.runtime.commands.enforcementPoint.hasPermission(identity, id),
  );
}

type State = 'received' | 'in_repair' | 'waiting_for_parts' | 'repaired' | 'cancelled' | 'returned';

/** A fresh ticket walked into `state` through the real commands. */
async function ticketIn(harness: RepairHarness, state: State): Promise<string> {
  const { ticketId } = (await harness.run('openTicket', intake(harness), harness.cashierId)) as {
    ticketId: string;
  };
  const tech = harness.technicianId;
  const startWork = () =>
    harness.run('startWork', { ticketId, beforePhotos: [harness.photo(7)] }, tech);
  if (state === 'in_repair' || state === 'repaired' || state === 'returned') await startWork();
  if (state === 'waiting_for_parts') {
    await harness.run('markWaitingForParts', { ticketId, note: 'LCD' }, tech);
  }
  if (state === 'repaired' || state === 'returned') {
    await harness.run('markRepaired', { ticketId, afterPhotos: [harness.photo(8)] }, tech);
  }
  if (state === 'cancelled') {
    await harness.run(
      'cancelTicket',
      { ticketId, reason: 'customer changed mind' },
      harness.cashierId,
    );
  }
  if (state === 'returned') {
    await harness.run(
      'returnDevice',
      { ticketId, handoverPhoto: harness.photo(9), signature: harness.photo(10) },
      harness.cashierId,
    );
  }
  return ticketId;
}

/** Run the command behind an offered action, the way the screen would. */
function perform(harness: RepairHarness, action: TicketAction, ticketId: string, userId: string) {
  const price = { ticketId, kind: 'part', description: 'Baterai', amount: 150_000, reason: 'drop' };
  switch (action) {
    case 'claim':
      return harness.run('claimTicket', { ticketId }, userId);
    case 'start':
    case 'resume':
    case 'reopen':
      return harness.run('startWork', { ticketId, beforePhotos: [harness.photo(11)] }, userId);
    case 'waitForParts':
      return harness.run('markWaitingForParts', { ticketId, note: '' }, userId);
    case 'markRepaired':
      return harness.run('markRepaired', { ticketId, afterPhotos: [harness.photo(12)] }, userId);
    case 'assign':
      return harness.run(
        'assignTechnician',
        { ticketId, technicianId: harness.technician2Id },
        userId,
      );
    case 'changePrice':
      return harness.run('changeQuote', { ...price, customerAgreed: true }, userId);
    case 'proposePrice':
      return harness.run('proposeQuoteChange', price, userId);
    case 'handover':
      return harness.run(
        'returnDevice',
        { ticketId, handoverPhoto: harness.photo(13), signature: harness.photo(14) },
        userId,
      );
    case 'cancel':
      return harness.run('cancelTicket', { ticketId, reason: 'no parts' }, userId);
  }
}

describe('ticket actions', () => {
  test('every action offered to the cashier or a technician is accepted by its command', async () => {
    h = await openRepairHarness(4101);
    const states: State[] = [
      'received',
      'in_repair',
      'waiting_for_parts',
      'repaired',
      'cancelled',
      'returned',
    ];
    let checked = 0;
    for (const state of states) {
      for (const userId of [h.cashierId, h.technicianId]) {
        const probe = await ticketIn(h, state);
        const row = (await h.query('getTicket', { ticketId: probe }, userId)).rows[0];
        for (const action of ticketActions(row, abilitiesOf(h, userId), userId)) {
          const ticketId = await ticketIn(h, state);
          await expect(
            perform(h, action, ticketId, userId),
            `${state}/${action}`,
          ).resolves.toBeDefined();
          checked += 1;
        }
      }
    }
    // The denominator: the matrix really exercised actions in most states.
    expect(checked).toBeGreaterThanOrEqual(15);
  });

  test('roles see their own work: the counter hands over and changes price, technicians repair', async () => {
    h = await openRepairHarness(4102);
    const cashier = abilitiesOf(h, h.cashierId);
    const tech = abilitiesOf(h, h.technicianId);
    const row = (ticket: Partial<Parameters<typeof ticketActions>[0]> = {}) => ({
      outcome: 'received' as const,
      location: 'in_store' as const,
      technicianId: null,
      pendingProposals: 0,
      ...ticket,
    });

    expect(ticketActions(row(), tech, h.technicianId)).toEqual([
      'start',
      'waitForParts',
      'claim',
      'proposePrice',
    ]);
    expect(ticketActions(row(), cashier, h.cashierId)).toEqual(['changePrice', 'assign', 'cancel']);
    expect(ticketActions(row({ outcome: 'repaired' }), cashier, h.cashierId)[0]).toBe('handover');
    // An undecided price change blocks handover until the cashier decides it.
    expect(
      ticketActions(row({ outcome: 'repaired', pendingProposals: 1 }), cashier, h.cashierId),
    ).not.toContain('handover');
    expect(
      ticketActions(row({ location: 'returned', outcome: 'repaired' }), cashier, h.cashierId),
    ).toEqual([]);
  });
});

describe('board views', () => {
  test('mine filters to the user; pickup is finished work still in the store', () => {
    expect(boardFilter('mine', 'u1')).toMatchObject({ technicianId: 'u1', location: 'in_store' });
    expect(boardFilter('pickup', 'u1')).toEqual({
      outcomes: ['repaired', 'cancelled'],
      location: 'in_store',
    });
    expect(boardFilter('returned', 'u1')).toEqual({ location: 'returned' });
  });
});

describe('money and dates', () => {
  test('parseRupiah reads what people type', () => {
    expect(parseRupiah('650.000')).toBe(650_000);
    expect(parseRupiah('Rp 1.250.000')).toBe(1_250_000);
    expect(parseRupiah('')).toBeNull();
    expect(parseRupiah('abc')).toBeNull();
  });

  test('ready dates land at the end of the store day', () => {
    const now = new Date(2026, 9, 25, 9, 30).getTime();
    expect(readyAtFor('today', now)).toBe(new Date(2026, 9, 25, 17, 0).getTime());
    expect(readyAtFor('threeDays', now)).toBe(new Date(2026, 9, 28, 17, 0).getTime());
    expect(readyAtFor('unknown', now)).toBeNull();
  });
});

describe('intake draft', () => {
  function complete(harness: RepairHarness): IntakeDraft {
    return {
      ...emptyIntakeDraft(),
      step: 5,
      customer: { kind: 'new', name: ' Yohanis Wenda ', phone: '0812 4455 6677' },
      device: { brand: 'Samsung', model: 'Galaxy A14', color: '', imei: '', passcode: '' },
      complaint: 'Layar retak',
      checks: { screen: 'issue', speaker: 'ok' },
      peripherals: ['charger'],
      photos: Object.fromEntries(INTAKE_PHOTO_SLOTS.map((slot, i) => [slot, harness.photo(i + 1)])),
      lines: [
        { kind: 'part', description: 'LCD', amount: 650_000 },
        { kind: 'discount', description: 'Pelanggan lama', amount: 50_000 },
      ],
      ready: 'tomorrow',
    };
  }

  test('each step names what is missing, and review collects them all', async () => {
    h = await openRepairHarness(4103);
    const draft = emptyIntakeDraft();
    expect(stepProblems(draft, 'customer')).toEqual(['customerName']);
    expect(stepProblems(draft, 'photos')).toEqual(['photos']);
    expect(stepProblems(draft, 'review')).toEqual([
      'customerName',
      'deviceBrand',
      'deviceModel',
      'complaint',
      'photos',
      'quoteLines',
    ]);
    expect(stepProblems(complete(h), 'review')).toEqual([]);
    expect(intakeDirty(draft)).toBe(false);
    expect(intakeDirty({ ...draft, step: 3 })).toBe(false);
    expect(intakeDirty({ ...draft, complaint: 'x' })).toBe(true);
  });

  test('a complete draft opens a ticket with the discount subtracted', async () => {
    h = await openRepairHarness(4104);
    const draft = complete(h);
    expect(intakeTotal(draft.lines)).toBe(600_000);
    const { ticketId } = (await h.run(
      'openTicket',
      toOpenTicketInput(draft, Date.now()),
      h.cashierId,
    )) as { ticketId: string };
    const ticket = (await h.query('getTicket', { ticketId }, h.cashierId)).rows[0];
    expect(ticket.customerName).toBe('Yohanis Wenda');
    expect(ticket.quoteTotal).toBe(600_000);
    expect(ticket.peripherals).toEqual(['charger']);
    expect(ticket.checklist).toEqual([
      { item: 'screen', state: 'issue', note: '' },
      { item: 'speaker', state: 'ok', note: '' },
    ]);
  });

  test('a retained draft round-trips, and a malformed one restores nothing', async () => {
    h = await openRepairHarness(4105);
    const draft = complete(h);
    expect(parseIntakeDraft(JSON.parse(JSON.stringify(draft)))).toEqual(draft);
    expect(parseIntakeDraft({ ...draft, step: 'x' })).toBeNull();
    expect(parseIntakeDraft(null)).toBeNull();
  });
});
