// The decisions behind the repair phone screens: which actions a ticket offers, and how an intake
// draft becomes an `openTicket` input. Both are checked against the real runtime, so a button the
// screens show never leads to a refusal the commands would give.
import { afterEach, describe, expect, test } from 'vitest';

import {
  arrangeTicketActions,
  balanceAfterDownPayment,
  downPaymentAction,
  downPaymentEntry,
  printableSlips,
  boardFilter,
  boardSort,
  boardViews,
  emptyIntakeDraft,
  intakeDirty,
  intakeTotal,
  nextMissingPhoto,
  parseIntakeDraft,
  acceptsRupiahText,
  parseRupiah,
  phoneText,
  readyAtFor,
  repairAbilities,
  restOfChecksOk,
  staleStep,
  stepProblems,
  ticketActions,
  toOpenTicketInput,
  type IntakeDraft,
  type RepairAbilities,
  type TicketAction,
} from '../src/repair/flows.js';
import { INTAKE_PHOTO_SLOTS } from '../src/repair/constants.js';
import { DEFAULT_INTAKE_OPTIONS } from '../src/repair/intake-options.js';
import { decodeScreenLock } from '../src/repair/screen-lock.js';

const OPTIONS = DEFAULT_INTAKE_OPTIONS;
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
      { ticketId, reason: 'customer changed mind', fee: 0 },
      harness.storeOwnerId,
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
      return harness.run('cancelTicket', { ticketId, reason: 'no parts', fee: 10_000 }, userId);
  }
}

describe('ticket actions', () => {
  test('every action offered to the cashier, a technician or a store owner is accepted by its command', async () => {
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
      for (const userId of [h.cashierId, h.technicianId, h.storeOwnerId]) {
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
      for (const userId of [h.cashierId, h.technicianId, h.storeOwnerId]) {
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
            const who = new Map([
              [h.cashierId, 'cashier'],
              [h.technicianId, 'technician'],
              [h.storeOwnerId, 'store owner'],
            ]);
            gaps.push(`${state}/${who.get(userId) ?? userId}/${action}`);
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
    expect(ticketActions(row(), cashier, h.cashierId)).toEqual(['assign', 'changePrice']);
    expect(ticketActions(row({ technicianId: h.technicianId }), cashier, h.cashierId)).toEqual([
      'changePrice',
      'assign',
    ]);
    // Only owners cancel: counter staff kept customers' cash by cancelling. A repaired phone the
    // customer won't pay for or collect can still be cancelled until it is handed back.
    const storeOwner = abilitiesOf(h, h.storeOwnerId);
    for (const outcome of ['received', 'in_repair', 'waiting_for_parts', 'repaired'] as const) {
      expect(ticketActions(row({ outcome }), cashier, h.cashierId)).not.toContain('cancel');
      expect(ticketActions(row({ outcome }), storeOwner, h.storeOwnerId)).toContain('cancel');
    }
    expect(
      ticketActions(row({ outcome: 'repaired', location: 'returned' }), storeOwner, h.storeOwnerId),
    ).not.toContain('cancel');
    expect(ticketActions(row({ outcome: 'repaired' }), cashier, h.cashierId)[0]).toBe('handover');
    // An undecided price change blocks handover until the cashier decides it.
    expect(
      ticketActions(row({ outcome: 'repaired', pendingProposals: 1 }), cashier, h.cashierId),
    ).not.toContain('handover');
    expect(
      ticketActions(row({ location: 'returned', outcome: 'repaired' }), cashier, h.cashierId),
    ).toEqual([]);
  });

  test('each person gets one next step for where the repair stands, not every status change', async () => {
    h = await openRepairHarness(4103);
    const tech = abilitiesOf(h, h.technicianId);
    const cashier = abilitiesOf(h, h.cashierId);
    const layout = (
      ticket: Partial<Parameters<typeof ticketActions>[0]>,
      can: RepairAbilities,
      userId: string,
    ) => {
      const row = {
        outcome: 'received' as const,
        location: 'in_store' as const,
        technicianId: null,
        pendingProposals: 0,
        ...ticket,
      };
      return arrangeTicketActions(ticketActions(row, can, userId), row, userId);
    };
    const mine = h.technicianId;

    // Off the shelf: start it (which also takes it); parts before starting and taking it for later
    // are rare, so they wait under "Lainnya".
    expect(layout({}, tech, mine)).toEqual({
      next: 'start',
      alternative: null,
      more: ['waitForParts', 'claim'],
    });
    // At the bench the one real fork is running out of parts.
    expect(layout({ outcome: 'in_repair', technicianId: mine }, tech, mine)).toEqual({
      next: 'markRepaired',
      alternative: 'waitForParts',
      more: [],
    });
    expect(layout({ outcome: 'waiting_for_parts', technicianId: mine }, tech, mine)).toEqual({
      next: 'resume',
      alternative: null,
      more: [],
    });
    // Someone else's repair is theirs to work on: this person can only take it over.
    expect(layout({ outcome: 'in_repair', technicianId: h.storeOwnerId }, tech, mine)).toEqual({
      next: null,
      alternative: null,
      more: ['claim'],
    });
    // The counter: pick a technician, settle a price change, hand the phone back.
    expect(layout({}, cashier, h.cashierId)).toEqual({
      next: 'assign',
      alternative: null,
      more: [],
    });
    expect(layout({ technicianId: mine }, cashier, h.cashierId)).toEqual({
      next: null,
      alternative: null,
      more: [],
    });
    expect(
      layout(
        { outcome: 'in_repair', technicianId: mine, pendingProposals: 1 },
        cashier,
        h.cashierId,
      ),
    ).toEqual({ next: 'decidePrice', alternative: null, more: [] });
    expect(layout({ outcome: 'repaired', technicianId: mine }, cashier, h.cashierId)).toEqual({
      next: 'handover',
      alternative: null,
      more: [],
    });
    // A repaired phone back on the bench is the rare case: the technician finds it under "Lainnya".
    expect(layout({ outcome: 'repaired', technicianId: mine }, tech, mine)).toEqual({
      next: null,
      alternative: null,
      more: ['reopen'],
    });
  });
});

describe('down payment and slips', () => {
  test('recording a down payment is offered exactly where the command accepts it', async () => {
    h = await openRepairHarness(4109);
    for (const state of ['received', 'repaired', 'returned', 'cancelled'] as const) {
      const ticketId = await ticketIn(h, state);
      const ticket = (await h.query('getTicket', { ticketId }, h.cashierId)).rows[0];
      const offered = downPaymentAction(ticket, abilitiesOf(h, h.cashierId)) === 'record';
      const run = h.run('recordDownPayment', { ticketId, amount: 20_000 }, h.cashierId);
      if (offered) await expect(run).resolves.toBeDefined();
      else await expect(run).rejects.toThrow();
      expect(offered).toBe(state !== 'returned' && state !== 'cancelled');
    }
  });

  test('the handover slip prints once the phone is ready or gone, and a large deposit is a refund', () => {
    expect(printableSlips({ outcome: 'in_repair', location: 'in_store' })).toEqual(['intake']);
    expect(printableSlips({ outcome: 'repaired', location: 'in_store' })).toEqual([
      'intake',
      'handover',
    ]);
    expect(printableSlips({ outcome: 'cancelled', location: 'in_store' })).toEqual([
      'intake',
      'handover',
    ]);
    expect(balanceAfterDownPayment(50_000, 100_000)).toEqual({ kind: 'refund', amount: 50_000 });
    expect(balanceAfterDownPayment(50_000, 50_000)).toEqual({ kind: 'due', amount: 0 });
  });
});

describe('an open step after the ticket changed elsewhere', () => {
  type StepTicket = Parameters<typeof staleStep>[1];
  const line = (status: 'proposed' | 'applied' | 'declined') => ({
    id: 'line-1',
    status,
    kind: 'part' as const,
    description: 'Baterai',
    amount: 150_000,
    reason: 'Kembung',
    customerAgreed: status === 'applied' ? true : null,
    createdBy: 'tech',
    createdAt: 1,
    decidedBy: status === 'proposed' ? null : 'cashier',
    decidedAt: status === 'proposed' ? null : 2,
    decisionNote: null,
  });
  const row = (ticket: Partial<StepTicket> = {}): StepTicket => ({
    outcome: 'received',
    location: 'in_store',
    technicianId: null,
    pendingProposals: 0,
    quoteLines: [],
    ...ticket,
  });

  test('a step the ticket still allows stays open', async () => {
    h = await openRepairHarness(4201);
    const cashier = abilitiesOf(h, h.cashierId);
    const tech = abilitiesOf(h, h.technicianId);
    expect(staleStep({ kind: 'before' }, row(), tech, h.technicianId)).toBeNull();
    // Only owners cancel.
    const owner = abilitiesOf(h, h.storeOwnerId);
    expect(staleStep({ kind: 'cancel' }, row(), owner, h.storeOwnerId)).toBeNull();
    // Reassigned meanwhile, a technician can still start: the start claims it.
    expect(
      staleStep({ kind: 'before' }, row({ technicianId: h.technician2Id }), tech, h.technicianId),
    ).toBeNull();
    expect(
      staleStep(
        { kind: 'proposal', lineId: 'line-1' },
        row({ outcome: 'in_repair', pendingProposals: 1, quoteLines: [line('proposed')] }),
        cashier,
        h.cashierId,
      ),
    ).toBeNull();
    expect(
      staleStep({ kind: 'handover' }, row({ outcome: 'repaired' }), cashier, h.cashierId),
    ).toBeNull();
  });

  test('each change says what happened, most specific first', async () => {
    h = await openRepairHarness(4202);
    const cashier = abilitiesOf(h, h.cashierId);
    const tech = abilitiesOf(h, h.technicianId);
    expect(
      staleStep({ kind: 'after' }, row({ outcome: 'cancelled' }), tech, h.technicianId),
    ).toEqual({ kind: 'cancelled' });
    // A cancelled phone already handed back reads as handed back, the later and final fact.
    expect(
      staleStep(
        { kind: 'cancel' },
        row({ outcome: 'cancelled', location: 'returned' }),
        cashier,
        h.cashierId,
      ),
    ).toEqual({ kind: 'returned' });
    expect(
      staleStep(
        { kind: 'handover' },
        row({ outcome: 'repaired', location: 'returned' }),
        cashier,
        h.cashierId,
      ),
    ).toEqual({ kind: 'returned' });
    // Another technician started first.
    expect(
      staleStep(
        { kind: 'before' },
        row({ outcome: 'in_repair', technicianId: h.technician2Id }),
        tech,
        h.technicianId,
      ),
    ).toEqual({ kind: 'changed' });
    for (const decided of ['applied', 'declined'] as const) {
      expect(
        staleStep(
          { kind: 'proposal', lineId: 'line-1' },
          row({ outcome: 'in_repair', quoteLines: [line(decided)] }),
          cashier,
          h.cashierId,
        ),
      ).toEqual({ kind: 'proposalDecided', decision: decided });
    }
    // An undecided proposal on a ticket cancelled meanwhile can no longer be decided.
    expect(
      staleStep(
        { kind: 'proposal', lineId: 'line-1' },
        row({ outcome: 'cancelled', pendingProposals: 1, quoteLines: [line('proposed')] }),
        cashier,
        h.cashierId,
      ),
    ).toEqual({ kind: 'cancelled' });
    // A technician's new proposal holds the handover until the counter checks it.
    expect(
      staleStep(
        { kind: 'handover' },
        row({ outcome: 'repaired', pendingProposals: 1 }),
        cashier,
        h.cashierId,
      ),
    ).toEqual({ kind: 'proposalPending' });
    // Reopened on another device: the phone is back on the bench.
    expect(
      staleStep({ kind: 'handover' }, row({ outcome: 'in_repair' }), cashier, h.cashierId),
    ).toEqual({ kind: 'changed' });
  });
});

describe('board views', () => {
  test('mine filters to the user; pickup is finished work still in the store', () => {
    expect(boardFilter('mine', 'u1', 0)).toMatchObject({
      technicianId: 'u1',
      location: 'in_store',
    });
    expect(boardFilter('pickup', 'u1', 0)).toEqual({
      outcomes: ['repaired', 'cancelled'],
      location: 'in_store',
    });
    expect(boardFilter('returned', 'u1', 0)).toEqual({ location: 'returned' });
  });

  test('phones not collected are finished, still in the store, ready before the cut-off', async () => {
    expect(boardFilter('uncollected', 'u1', 1_000)).toEqual({
      outcomes: ['repaired', 'cancelled'],
      location: 'in_store',
      readyBefore: 1_000,
    });
    // Only that view reads the cut-off.
    expect(boardFilter('pickup', 'u1', 1_000)).not.toHaveProperty('readyBefore');
    expect(boardSort('uncollected')).toBe('readyAt.asc');
    h = await openRepairHarness(4105);
    // The counter and owners call the customer; technicians have no use for the list.
    expect(boardViews(abilitiesOf(h, h.cashierId))).toContain('uncollected');
    expect(boardViews(abilitiesOf(h, h.storeOwnerId))).toContain('uncollected');
    expect(boardViews(abilitiesOf(h, h.technicianId))).not.toContain('uncollected');
  });

  test('the cancelled view is for owners only and lists the latest cancel first', async () => {
    h = await openRepairHarness(4104);
    expect(boardViews(abilitiesOf(h, h.cashierId))).not.toContain('cancelled');
    expect(boardViews(abilitiesOf(h, h.technicianId))).not.toContain('cancelled');
    expect(boardViews(abilitiesOf(h, h.storeOwnerId))).toContain('cancelled');
    expect(boardViews(abilitiesOf(h, h.ownerId))).toContain('cancelled');
    expect(boardFilter('cancelled', 'u1', 0)).toEqual({ outcomes: ['cancelled'] });
    expect(boardSort('cancelled')).toBe('cancelledAt.desc');
    expect(boardSort('active')).toBe('createdAt.desc');
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

  test('a phone field keeps digits, spaces, dashes and a leading plus only', () => {
    expect(phoneText('081234567890.')).toBe('081234567890');
    expect(phoneText('+62 812-3456-7890')).toBe('+62 812-3456-7890');
    expect(phoneText('0812,34*56#78(90)N/')).toBe('081234567890');
    expect(phoneText('08+12')).toBe('0812');
  });

  test('ready dates land at the end of the store day', () => {
    const now = new Date(2026, 9, 25, 9, 30).getTime();
    expect(readyAtFor('0', now)).toBe(new Date(2026, 9, 25, 17, 0).getTime());
    expect(readyAtFor('3', now)).toBe(new Date(2026, 9, 28, 17, 0).getTime());
    // An owner-added choice is just more days.
    expect(readyAtFor('14', now)).toBe(new Date(2026, 10, 8, 17, 0).getTime());
    // Taken in after five, "today" is still later than now.
    const evening = new Date(2026, 9, 25, 18, 10).getTime();
    expect(readyAtFor('0', evening)).toBe(new Date(2026, 9, 25, 20, 0).getTime());
    expect(readyAtFor('unknown', now)).toBeNull();
  });
});

describe('intake draft', () => {
  function complete(harness: RepairHarness): IntakeDraft {
    return {
      ...emptyIntakeDraft(),
      step: 5,
      customer: { kind: 'new', name: ' Yohanis Wenda ', phone: '0812 4455 6677' },
      device: {
        brand: 'Samsung',
        model: 'Galaxy A14',
        color: '',
        imei: '',
        lockKind: 'none',
        passcode: '',
      },
      complaint: 'Layar retak',
      checks: { screen: 'issue', speaker: 'ok' },
      peripherals: ['charger'],
      photos: Object.fromEntries(INTAKE_PHOTO_SLOTS.map((slot, i) => [slot, harness.photo(i + 1)])),
      lines: [
        { kind: 'part', description: 'LCD', amount: 650_000 },
        { kind: 'discount', description: 'Pelanggan lama', amount: 50_000 },
      ],
      ready: '1',
    };
  }

  test('each step names what is missing, and review collects them all', async () => {
    h = await openRepairHarness(4103);
    const draft = emptyIntakeDraft();
    expect(stepProblems(draft, 'customer', OPTIONS)).toEqual(['customerName']);
    expect(stepProblems(draft, 'photos', OPTIONS)).toEqual(['photos']);
    expect(stepProblems(draft, 'review', OPTIONS)).toEqual([
      'customerName',
      'deviceBrand',
      'deviceModel',
      'complaint',
      'photos',
      'quoteLines',
    ]);
    expect(stepProblems(complete(h), 'review', OPTIONS)).toEqual([]);
    // A lock kind chosen with nothing entered (or a too-short pattern, kept as '') blocks the step,
    // where saving would have quietly recorded no lock.
    const done = complete(h);
    const lock = (lockKind: IntakeDraft['device']['lockKind'], passcode: string) =>
      stepProblems({ ...done, device: { ...done.device, lockKind, passcode } }, 'device', OPTIONS);
    expect(lock('pattern', '')).toEqual(['screenLock']);
    expect(lock('pin', '')).toEqual(['screenLock']);
    expect(lock('password', '')).toEqual(['screenLock']);
    expect(lock('pattern', '1478')).toEqual([]);
    expect(lock('none', '')).toEqual([]);
    // A store that asks for fewer photo angles has no problem with the ones it does not ask for.
    const twoAngles = { ...OPTIONS, photoAngles: OPTIONS.photoAngles.slice(0, 2) };
    expect(
      stepProblems(
        { ...draft, photos: { front: h.photo(1), back: h.photo(2) } },
        'photos',
        twoAngles,
      ),
    ).toEqual([]);
    expect(intakeDirty(draft)).toBe(false);
    expect(intakeDirty({ ...draft, step: 3 })).toBe(false);
    // The id an intake takes up front is not an answer: an untouched intake is still clean.
    expect(intakeDirty({ ...draft, ticketId: '01920000-0000-7000-8000-00000000a161' })).toBe(false);
    expect(intakeDirty({ ...draft, complaint: 'x' })).toBe(true);
  });

  test('an amount with no description is a problem, not a line quietly dropped on save', () => {
    const draft = {
      ...emptyIntakeDraft(),
      lines: [{ kind: 'part' as const, description: ' ', amount: 90_000 }],
    };
    expect(stepProblems(draft, 'price', OPTIONS)).toEqual(['incompleteLine', 'quoteLines']);
    // An untouched empty line is ignored rather than flagged.
    const untouched = {
      ...emptyIntakeDraft(),
      lines: [{ kind: 'part' as const, description: '', amount: 0 }],
    };
    expect(stepProblems(untouched, 'price', OPTIONS)).toEqual(['quoteLines']);
    // Discounts may bring the price to nothing, never below it (openTicket refuses that).
    const discounted = (discount: number) => ({
      ...emptyIntakeDraft(),
      lines: [
        { kind: 'labour' as const, description: 'Servis', amount: 50_000 },
        { kind: 'discount' as const, description: 'Diskon', amount: discount },
      ],
    });
    expect(stepProblems(discounted(60_000), 'price', OPTIONS)).toEqual(['negativeTotal']);
    expect(stepProblems(discounted(50_000), 'price', OPTIONS)).toEqual([]);
  });

  test('photos are walked in slot order, and "the rest OK" keeps the issues called out', async () => {
    h = await openRepairHarness(4105);
    const angles = OPTIONS.photoAngles;
    expect(nextMissingPhoto(emptyIntakeDraft(), angles)?.id).toBe('front');
    expect(nextMissingPhoto({ photos: { front: h.photo(1), back: h.photo(2) } }, angles)?.id).toBe(
      'left',
    );
    expect(nextMissingPhoto(complete(h), angles)).toBeNull();

    const checks = restOfChecksOk({ screen: 'issue', camera: 'not_checked' }, OPTIONS.checks);
    expect(checks['screen']).toBe('issue');
    expect(checks['camera']).toBe('ok');
    expect(Object.values(checks).filter((state) => state === 'issue')).toHaveLength(1);
  });

  test('a complete draft opens a ticket with the discount subtracted', async () => {
    h = await openRepairHarness(4104);
    const draft = complete(h);
    expect(intakeTotal(draft.lines)).toBe(600_000);
    // A discount at intake is an owner's to give.
    const { ticketId } = (await h.run(
      'openTicket',
      toOpenTicketInput(draft, OPTIONS, Date.now()),
      h.storeOwnerId,
    )) as { ticketId: string };
    const ticket = (await h.query('getTicket', { ticketId }, h.cashierId)).rows[0];
    expect(ticket.customerName).toBe('Yohanis Wenda');
    expect(ticket.quoteTotal).toBe(600_000);
    expect(ticket.peripherals).toEqual([{ item: 'charger', label: null }]);
    expect(ticket.checklist).toEqual([
      { item: 'screen', label: null, state: 'issue', note: '' },
      { item: 'speaker', label: null, state: 'ok', note: '' },
    ]);
    expect(ticket.intakePhotos.map((p: { slot: string }) => p.slot)).toEqual([
      ...INTAKE_PHOTO_SLOTS,
    ]);
  });

  test('a down payment at intake is checked like the command checks it, and opens with the ticket', async () => {
    h = await openRepairHarness(4108);
    const draft = { ...complete(h), downPayment: '700.000' };
    // More than a known price is change, not a payment.
    expect(stepProblems(draft, 'price', OPTIONS)).toEqual(['downPaymentAboveTotal']);
    // With no price yet, any deposit stands.
    const unpriced = {
      ...draft,
      lines: [{ kind: 'labour' as const, description: 'Cek dulu', amount: 0 }],
    };
    expect(stepProblems(unpriced, 'price', OPTIONS)).toEqual([]);
    const paid = { ...draft, downPayment: '100.000' };
    expect(stepProblems(paid, 'review', OPTIONS)).toEqual([]);
    const { ticketId } = (await h.run(
      'openTicket',
      toOpenTicketInput(paid, OPTIONS, Date.now()),
      h.storeOwnerId,
    )) as { ticketId: string };
    const ticket = (await h.query('getTicket', { ticketId }, h.cashierId)).rows[0];
    expect(ticket.downPayment).toBe(100_000);
    expect(balanceAfterDownPayment(ticket.quoteTotal, ticket.downPayment!)).toEqual({
      kind: 'due',
      amount: 500_000,
    });
    // Recorded once: after that only an owner may change it, and the counter sees no action.
    expect(downPaymentAction(ticket, abilitiesOf(h, h.cashierId))).toBeNull();
    expect(downPaymentAction(ticket, abilitiesOf(h, h.ownerId))).toBe('correct');
  });

  test('a draft opens against the lists the store offers, and records their names', async () => {
    h = await openRepairHarness(4106);
    const options = {
      ...OPTIONS,
      checks: [
        { id: 'screen', label: 'LCD' },
        { id: 'c-face', label: 'Face ID' },
      ],
      accessories: [{ id: 'a-pen', label: 'Stylus' }],
      photoAngles: [
        { id: 'front', label: null },
        { id: 'p-imei', label: 'Stiker IMEI' },
      ],
      readyBy: [{ id: '7', label: null }],
    };
    const draft: IntakeDraft = {
      ...complete(h),
      // `speaker` is no longer offered and `charger` no longer listed: neither reaches the ticket.
      checks: { screen: 'ok', speaker: 'issue', 'c-face': 'issue' },
      peripherals: ['charger', 'a-pen'],
      photos: { front: h.photo(1), 'p-imei': h.photo(2), back: h.photo(3) },
      ready: '1',
    };
    expect(stepProblems(draft, 'review', options)).toEqual([]);
    const now = new Date(2026, 9, 25, 9, 30).getTime();
    const input = toOpenTicketInput(draft, options, now);
    expect(input.checklist).toEqual([
      { item: 'screen', label: 'LCD', state: 'ok', note: '' },
      { item: 'c-face', label: 'Face ID', state: 'issue', note: '' },
    ]);
    expect(input.peripherals).toEqual([{ item: 'a-pen', label: 'Stylus' }]);
    expect(input.photos.map((p) => [p.slot, p.label])).toEqual([
      ['front', null],
      ['p-imei', 'Stiker IMEI'],
    ]);
    // "Tomorrow" is not offered any more, so the store's only choice stands.
    expect(input.estimatedReadyAt).toBe(new Date(2026, 10, 1, 17, 0).getTime());
  });

  test('a retained draft round-trips, and a malformed one restores nothing', async () => {
    h = await openRepairHarness(4105);
    const draft = complete(h);
    expect(parseIntakeDraft(JSON.parse(JSON.stringify(draft)))).toEqual(draft);
    expect(parseIntakeDraft({ ...draft, step: 'x' })).toBeNull();
    // A draft kept from before the ready-by choices were editable still restores, as days.
    expect(parseIntakeDraft({ ...draft, ready: 'threeDays' })?.ready).toBe('3');
    expect(parseIntakeDraft({ ...draft, ready: 'unknown' })?.ready).toBe('unknown');
    expect(parseIntakeDraft(null)).toBeNull();
    // A draft from before lock kinds: a typed passcode is kept as a password.
    const { brand, model, color, imei } = draft.device;
    const oldDevice = { brand, model, color, imei, passcode: '1234' };
    expect(parseIntakeDraft({ ...draft, device: oldDevice })?.device.lockKind).toBe('password');
    expect(
      parseIntakeDraft({ ...draft, device: { ...oldDevice, passcode: '' } })?.device.lockKind,
    ).toBe('none');
  });

  test('the screen lock reaches the ticket with its kind, and none means no passcode', async () => {
    h = await openRepairHarness(4107);
    const draft = complete(h);
    const withLock = (lockKind: IntakeDraft['device']['lockKind'], passcode: string) =>
      toOpenTicketInput({ ...draft, device: { ...draft.device, lockKind, passcode } }, OPTIONS, 0)
        .device.passcode;
    expect(withLock('pattern', '14753')).toBe('pattern:14753');
    expect(withLock('pin', '0000')).toBe('pin:0000');
    expect(withLock('password', 'a:b')).toBe('password:a:b');
    expect(withLock('pin', '')).toBeNull();
    // A value left over from another kind is dropped with "no lock".
    expect(withLock('none', '1234')).toBeNull();

    const { ticketId } = (await h.run(
      'openTicket',
      toOpenTicketInput(
        { ...draft, device: { ...draft.device, lockKind: 'pattern', passcode: '14753' } },
        OPTIONS,
        Date.now(),
      ),
      // The draft carries a discount, which only an owner may give.
      h.storeOwnerId,
    )) as { ticketId: string };
    const ticket = (await h.query('getTicket', { ticketId }, h.cashierId)).rows[0];
    expect(decodeScreenLock(ticket.devicePasscode)).toEqual({ kind: 'pattern', value: '14753' });
  });
});

describe('downPaymentEntry', () => {
  const entry = (
    mode: 'record' | 'correct',
    typed: number | null,
    reason = '',
    current: number | null = null,
  ) => downPaymentEntry({ mode, typed, reason, current, total: 100_000 });

  test('a new down payment is at least Rp 1 and never above the total', () => {
    expect(entry('record', null).gap).toBe('amount');
    expect(entry('record', 0).gap).toBe('amount');
    expect(entry('record', 150_000)).toEqual({
      amount: 150_000,
      aboveTotal: true,
      gap: 'aboveTotal',
    });
    expect(entry('record', 100_000).gap).toBeNull();
  });

  test('a correction must change the amount and say why, and may bring it to nothing', () => {
    expect(entry('correct', null, '', 50_000).gap).toBe('correctAmount');
    expect(entry('correct', 50_000, 'salah', 50_000).gap).toBe('same');
    expect(entry('correct', 20_000, ' ', 50_000).gap).toBe('reason');
    expect(entry('correct', 0, 'batal', 50_000)).toEqual({
      amount: 0,
      aboveTotal: false,
      gap: null,
    });
  });
});
