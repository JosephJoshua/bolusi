// The decisions behind the repair phone screens: which actions a ticket offers, and how an intake
// draft becomes an `openTicket` input. Both are checked against the real runtime, so a button the
// screens show never leads to a refusal the commands would give.
import { afterEach, describe, expect, test } from 'vitest';

import {
  boardFilter,
  emptyIntakeDraft,
  intakeDirty,
  intakeTotal,
  nextMissingPhoto,
  parseIntakeDraft,
  acceptsRupiahText,
  parseRupiah,
  readyAtFor,
  repairAbilities,
  restOfChecksOk,
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

type State =
  | 'received'
  | 'in_repair'
  | 'proposed'
  | 'waiting_for_parts'
  | 'repaired'
  | 'cancelled'
  | 'returned';

/** A fresh ticket walked into `state` through the real commands. */
async function ticketIn(harness: RepairHarness, state: State): Promise<string> {
  const { ticketId } = (await harness.run('openTicket', intake(harness), harness.cashierId)) as {
    ticketId: string;
  };
  const tech = harness.technicianId;
  const startWork = () =>
    harness.run('startWork', { ticketId, beforePhotos: [harness.photo(7)] }, tech);
  if (
    state === 'in_repair' ||
    state === 'proposed' ||
    state === 'repaired' ||
    state === 'returned'
  ) {
    await startWork();
  }
  if (state === 'proposed') {
    await harness.run(
      'proposeQuoteChange',
      { ticketId, kind: 'part', description: 'Baterai', amount: 150_000, reason: 'Kembung' },
      tech,
    );
  }
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
async function perform(
  harness: RepairHarness,
  action: TicketAction,
  ticketId: string,
  userId: string,
) {
  const price = { ticketId, kind: 'part', description: 'Baterai', amount: 150_000, reason: 'drop' };
  switch (action) {
    case 'decidePrice': {
      const ticket = (await harness.query('getTicket', { ticketId }, userId)).rows[0];
      const line = ticket.quoteLines.find((l: { status: string }) => l.status === 'proposed');
      return harness.run(
        'applyProposal',
        { ticketId, lineId: line.id, customerAgreed: true },
        userId,
      );
    }
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
      'proposed',
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

  test('an action a command would accept is offered, so no valid step is hidden', async () => {
    h = await openRepairHarness(4103);
    const states: State[] = [
      'received',
      'in_repair',
      'proposed',
      'waiting_for_parts',
      'repaired',
      'cancelled',
      'returned',
    ];
    const all: TicketAction[] = [
      'decidePrice',
      'claim',
      'start',
      'resume',
      'reopen',
      'waitForParts',
      'markRepaired',
      'assign',
      'changePrice',
      'proposePrice',
      'handover',
      'cancel',
    ];
    // start, resume and reopen are one command under three names; one of them offered covers all.
    const sameCommand = (a: TicketAction, b: TicketAction): boolean =>
      a === b ||
      (['start', 'resume', 'reopen'].includes(a) && ['start', 'resume', 'reopen'].includes(b));
    const gaps: string[] = [];
    for (const state of states) {
      for (const userId of [h.cashierId, h.technicianId]) {
        const probe = await ticketIn(h, state);
        const row = (await h.query('getTicket', { ticketId: probe }, userId)).rows[0];
        const offered = ticketActions(row, abilitiesOf(h, userId), userId);
        for (const action of all) {
          if (offered.some((o) => sameCommand(o, action))) continue;
          const ticketId = await ticketIn(h, state);
          const accepted = await perform(h, action, ticketId, userId).then(
            () => true,
            () => false,
          );
          if (accepted) {
            gaps.push(`${state}/${userId === h.cashierId ? 'cashier' : 'technician'}/${action}`);
          }
        }
      }
    }
    expect(gaps).toEqual([]);
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
    // Unassigned, the counter's next step is picking a technician; once assigned, pricing leads.
    expect(ticketActions(row(), cashier, h.cashierId)).toEqual(['assign', 'changePrice', 'cancel']);
    expect(ticketActions(row({ technicianId: h.technicianId }), cashier, h.cashierId)).toEqual([
      'changePrice',
      'assign',
      'cancel',
    ]);
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
    // One past the most a line may carry is not an amount, so the field refuses the keystroke.
    expect(parseRupiah('1.000.000.000.000')).toBe(1_000_000_000_000);
    expect(parseRupiah('10000000000000')).toBeNull();
    expect(acceptsRupiahText('10000000000000')).toBe(false);
    expect(acceptsRupiahText('')).toBe(true);
    expect(acceptsRupiahText('Rp 5.000')).toBe(true);
  });

  test('ready dates land at the end of the store day', () => {
    const now = new Date(2026, 9, 25, 9, 30).getTime();
    expect(readyAtFor('today', now)).toBe(new Date(2026, 9, 25, 17, 0).getTime());
    expect(readyAtFor('threeDays', now)).toBe(new Date(2026, 9, 28, 17, 0).getTime());
    // Taken in after five, "today" is still later than now.
    const evening = new Date(2026, 9, 25, 18, 10).getTime();
    expect(readyAtFor('today', evening)).toBe(new Date(2026, 9, 25, 20, 0).getTime());
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

  test('an amount with no description is a problem, not a line quietly dropped on save', () => {
    const draft = {
      ...emptyIntakeDraft(),
      lines: [{ kind: 'part' as const, description: ' ', amount: 90_000 }],
    };
    expect(stepProblems(draft, 'price')).toEqual(['incompleteLine', 'quoteLines']);
    // An untouched empty line is ignored rather than flagged.
    const untouched = {
      ...emptyIntakeDraft(),
      lines: [{ kind: 'part' as const, description: '', amount: 0 }],
    };
    expect(stepProblems(untouched, 'price')).toEqual(['quoteLines']);
    // Discounts may bring the price to nothing, never below it (openTicket refuses that).
    const discounted = (discount: number) => ({
      ...emptyIntakeDraft(),
      lines: [
        { kind: 'labour' as const, description: 'Servis', amount: 50_000 },
        { kind: 'discount' as const, description: 'Diskon', amount: discount },
      ],
    });
    expect(stepProblems(discounted(60_000), 'price')).toEqual(['negativeTotal']);
    expect(stepProblems(discounted(50_000), 'price')).toEqual([]);
  });

  test('photos are walked in slot order, and "the rest OK" keeps the issues called out', async () => {
    h = await openRepairHarness(4105);
    expect(nextMissingPhoto(emptyIntakeDraft())).toBe('front');
    expect(nextMissingPhoto({ photos: { front: h.photo(1), back: h.photo(2) } })).toBe('left');
    expect(nextMissingPhoto(complete(h))).toBeNull();

    const checks = restOfChecksOk({ screen: 'issue', camera: 'not_checked' });
    expect(checks['screen']).toBe('issue');
    expect(checks['camera']).toBe('ok');
    expect(Object.values(checks).filter((state) => state === 'issue')).toHaveLength(1);
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
