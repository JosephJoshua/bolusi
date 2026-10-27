// The repair phone flows, mounted over a real runtime: a counter intake from the board to a new
// ticket, a technician's required before and after photos, assignment, a proposed price change the
// cashier decides, the handover, live updates from a colleague, and the intake kept across a lock.
import { markSyncResult, OP_SYNC_STATUS_TABLE } from '@bolusi/core';
import { DEFAULT_LOCALE, setLocale } from '@bolusi/i18n';
import { emptyIntakeDraft, INTAKE_PHOTO_SLOTS, type IntakeDraft } from '@bolusi/modules/repair';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  ensureRepairCatalog,
  intake,
  openRepairScreenHarness,
  press,
  pull,
  render,
  repairRuntimeFor,
  settle,
  text,
  type,
  USER_NAMES,
  type RepairHarness,
  type RenderResult,
} from '../../../test/repair-support.js';

import type { SurfaceNav } from '../../navigation/surface.js';

import { RepairHome } from './RepairHome.js';

let h: RepairHarness | null = null;
/** A second device in the same store, when a test needs changes that arrive by sync. */
let peer: RepairHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
  await peer?.close();
  peer = null;
  setLocale(DEFAULT_LOCALE);
});

const NOW = new Date(2026, 9, 25, 10, 0).getTime();

async function mount(
  harness: RepairHarness,
  userId: string,
  props: Partial<Parameters<typeof RepairHome>[0]> = {},
): Promise<RenderResult> {
  ensureRepairCatalog();
  const screen = render(
    <RepairHome
      runtime={repairRuntimeFor(harness, userId)}
      now={() => NOW}
      syncChip={null}
      avatar={null}
      onOpenSyncStatus={vi.fn()}
      {...props}
    />,
  );
  await settle();
  return screen;
}

async function openTicket(harness: RepairHarness): Promise<string> {
  const opened = (await harness.run('openTicket', intake(harness), harness.cashierId)) as {
    ticketId: string;
  };
  return opened.ticketId;
}

async function ticketRow(harness: RepairHarness, ticketId: string) {
  return (await harness.query('getTicket', { ticketId }, harness.cashierId)).rows[0];
}

describe('counter intake', () => {
  test('the cashier takes a repair in from the board and lands on the new ticket', async () => {
    h = await openRepairScreenHarness(5101);
    const screen = await mount(h, h.cashierId);
    await press(screen, 'repair.board.newIntake');

    // Next on an empty step names what is missing instead of moving on.
    await press(screen, 'repair.intake.primary');
    expect(screen.query('repair.intake.step.customer')).not.toBeNull();
    expect(screen.query('repair.intake.customer.name.error')).not.toBeNull();

    type(screen, 'repair.intake.customer.name', 'Yohanis Wenda');
    type(screen, 'repair.intake.customer.phone', '0812-4455-6677');
    await press(screen, 'repair.intake.primary');
    type(screen, 'repair.intake.device.brand', 'Samsung');
    type(screen, 'repair.intake.device.model', 'Galaxy A14');
    await press(screen, 'repair.intake.primary');
    type(screen, 'repair.intake.condition.complaint', 'Layar retak');
    await press(screen, 'repair.intake.condition.check.screen.issue');
    await press(screen, 'repair.intake.condition.peripheral.charger');
    await press(screen, 'repair.intake.primary');

    // All six photos are required: tapping a slot takes that one, and the primary action walks
    // round the phone taking whichever shot is still missing until there are six.
    await press(screen, 'repair.intake.photos.slot.back.press');
    expect(screen.query('repair.intake.photos.slot.back.done')).not.toBeNull();
    for (let shot = 0; shot < INTAKE_PHOTO_SLOTS.length - 1; shot += 1) {
      expect(screen.query('repair.intake.step.photos')).not.toBeNull();
      await press(screen, 'repair.intake.primary');
    }
    for (const slot of INTAKE_PHOTO_SLOTS) {
      expect(screen.query(`repair.intake.photos.slot.${slot}.done`)).not.toBeNull();
    }
    await press(screen, 'repair.intake.primary');

    // A price typed into the line counts without a separate "add" press.
    type(screen, 'repair.intake.price.description.0', 'LCD A14');
    type(screen, 'repair.intake.price.amount.0', '650.000');
    await press(screen, 'repair.intake.primary');
    expect(screen.query('repair.intake.step.review')).not.toBeNull();
    await press(screen, 'repair.intake.primary');

    expect(screen.query('repair.ticket.content')).not.toBeNull();
    expect(text(screen, 'repair.ticket.customer')).toBe('Yohanis Wenda');
    const page = await h.query('listTickets', {}, h.cashierId);
    expect(page.rows).toHaveLength(1);
    const ticket = await ticketRow(h, page.rows[0].id);
    expect(ticket.quoteTotal).toBe(650_000);
    expect(ticket.peripherals).toEqual([{ item: 'charger', label: null }]);
    expect(ticket.photos).toHaveLength(6);
  });

  test('a returning customer is picked from fuzzy matches instead of entered twice', async () => {
    h = await openRepairScreenHarness(5102);
    await openTicket(h); // registers Yohanis Wenda
    const screen = await mount(h, h.cashierId);
    await press(screen, 'repair.board.newIntake');
    type(screen, 'repair.intake.customer.name', 'yohanes');
    await settle();
    const customerId = (await h.query('searchCustomers', { text: 'Yohanis' }, h.cashierId)).rows[0]
      .id as string;
    await press(screen, `repair.intake.customer.match.${customerId}`);
    expect(screen.query('repair.intake.customer.picked')).not.toBeNull();
  });

  test('an intake kept across a lock reopens at the step the user was on', async () => {
    h = await openRepairScreenHarness(5103);
    const draft: IntakeDraft = {
      kind: 'intake',
      step: 1,
      customer: { kind: 'new', name: 'Ester', phone: '' },
      device: { brand: 'Oppo', model: '', color: '', imei: '', lockKind: 'none', passcode: '' },
      complaint: '',
      intakeNotes: '',
      checks: {},
      peripherals: [],
      photos: {},
      lines: [],
      downPayment: '',
      ready: 'tomorrow',
    };
    const onDraftChange = vi.fn();
    const screen = await mount(h, h.cashierId, { restoredDraft: draft, onDraftChange });
    expect(screen.query('repair.intake.step.device')).not.toBeNull();
    type(screen, 'repair.intake.device.model', 'A57');
    await settle();
    expect(onDraftChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ device: expect.objectContaining({ brand: 'Oppo', model: 'A57' }) }),
    );
  });
});

describe('an intake restored after the app died mid-submit', () => {
  const restored = (ticketId: string): IntakeDraft => {
    const base = emptyIntakeDraft();
    return {
      ...base,
      step: 5,
      customer: { kind: 'new', name: 'Yohanis Wenda', phone: '0812-4455-6677' },
      device: { ...base.device, brand: 'Samsung', model: 'Galaxy A14' },
      complaint: 'Layar retak',
      ticketId,
    };
  };

  test('whose ticket was already opened shows that ticket and clears the draft', async () => {
    h = await openRepairScreenHarness(5104);
    const ticketId = '01920000-0000-7000-8000-00000000a151';
    await h.run('openTicket', { ...intake(h), ticketId }, h.cashierId);
    const onDraftChange = vi.fn();
    const screen = await mount(h, h.cashierId, {
      restoredDraft: restored(ticketId),
      onDraftChange,
    });
    await settle();

    expect(screen.query('repair.ticket.content')).not.toBeNull();
    expect(screen.query('repair.intake.step.review')).toBeNull();
    expect(onDraftChange).toHaveBeenLastCalledWith(null);
  });

  test('whose ticket was never opened stays on the intake with its id kept', async () => {
    h = await openRepairScreenHarness(5105);
    const ticketId = '01920000-0000-7000-8000-00000000a152';
    const onDraftChange = vi.fn();
    const screen = await mount(h, h.cashierId, {
      restoredDraft: restored(ticketId),
      onDraftChange,
    });
    await settle();

    expect(screen.query('repair.intake.step.review')).not.toBeNull();
    expect(onDraftChange).toHaveBeenLastCalledWith(expect.objectContaining({ ticketId }));
  });

  test('a new intake takes its ticket id up front, so the saved draft carries it', async () => {
    h = await openRepairScreenHarness(5106);
    const onDraftChange = vi.fn();
    const screen = await mount(h, h.cashierId, { onDraftChange });
    await press(screen, 'repair.board.newIntake');
    type(screen, 'repair.intake.customer.name', 'Ester');
    await settle();
    const saved = onDraftChange.mock.lastCall?.[0] as IntakeDraft;
    expect(saved.ticketId).toEqual(expect.any(String));
  });
});

describe('technician work', () => {
  test('starting needs a before photo and marking repaired needs an after photo', async () => {
    h = await openRepairScreenHarness(5201);
    const ticketId = await openTicket(h);
    const screen = await mount(h, h.technicianId);

    // A technician opens on their own queue; the unassigned ticket is under Unassigned.
    await press(screen, 'repair.board.views.unassigned');
    await press(screen, `repair.board.row.${ticketId}`);
    await press(screen, 'repair.ticket.action.start');
    expect(screen.query('repair.work.before')).not.toBeNull();
    expect(screen.all('repair.work.before.primary')[0]!.props['disabled']).toBe(true);
    await press(screen, 'repair.work.before.take.press');
    await press(screen, 'repair.work.before.primary');
    // Back on the ticket, the fixed banner says what just happened.
    expect(screen.query('repair.ticket.done')).not.toBeNull();

    let ticket = await ticketRow(h, ticketId);
    expect(ticket.outcome).toBe('in_repair');
    expect(ticket.technicianId).toBe(h.technicianId);
    expect(text(screen, 'repair.ticket.technician')).toContain(USER_NAMES.technician);

    await press(screen, 'repair.ticket.action.markRepaired');
    await press(screen, 'repair.work.after.take.press');
    type(screen, 'repair.work.after.note', 'Ganti LCD');
    await press(screen, 'repair.work.after.primary');
    ticket = await ticketRow(h, ticketId);
    expect(ticket.outcome).toBe('repaired');
    expect(ticket.photos.filter((p: { slot: string }) => p.slot.startsWith('after:'))).toHaveLength(
      1,
    );
  });

  test('the cashier assigns from the technicians who can work repairs', async () => {
    h = await openRepairScreenHarness(5202);
    const ticketId = await openTicket(h);
    const screen = await mount(h, h.cashierId);
    await press(screen, `repair.board.row.${ticketId}`);
    await press(screen, 'repair.ticket.action.assign');

    expect(screen.query(`repair.assign.row.${h.technicianId}`)).not.toBeNull();
    expect(screen.query(`repair.assign.row.${h.technician2Id}`)).not.toBeNull();
    // The cashier and the user with no grants cannot work repairs, so they are not offered.
    expect(screen.query(`repair.assign.row.${h.cashierId}`)).toBeNull();
    expect(screen.query(`repair.assign.row.${h.zeroUserId}`)).toBeNull();

    await press(screen, `repair.assign.row.${h.technician2Id}`);
    expect((await ticketRow(h, ticketId)).technicianId).toBe(h.technician2Id);
    expect(text(screen, 'repair.ticket.technician')).toContain(USER_NAMES.technician2);
  });
});

describe('price changes and handover', () => {
  test('a technician proposes, the cashier applies it with the customer agreeing', async () => {
    h = await openRepairScreenHarness(5301);
    const ticketId = await openTicket(h);
    const tech = await mount(h, h.technicianId);
    await press(tech, 'repair.board.views.unassigned');
    await press(tech, `repair.board.row.${ticketId}`);
    await press(tech, 'repair.ticket.action.proposePrice');
    type(tech, 'repair.price.propose.description', 'Baterai');
    type(tech, 'repair.price.propose.amount', '150000');
    type(tech, 'repair.price.propose.reason', 'Baterai kembung');
    await press(tech, 'repair.price.propose.primary');
    tech.unmount();

    const proposal = (await ticketRow(h, ticketId)).quoteLines.find(
      (line: { status: string }) => line.status === 'proposed',
    );
    expect(proposal).toBeDefined();

    const cashier = await mount(h, h.cashierId);
    await press(cashier, `repair.board.row.${ticketId}`);
    // One proposal: the bottom action opens it, so there is no second "decide" in the price list.
    expect(cashier.query(`repair.ticket.decide.${proposal.id}`)).toBeNull();
    await press(cashier, 'repair.ticket.action.decidePrice');
    await press(cashier, 'repair.proposal.primary');
    const ticket = await ticketRow(h, ticketId);
    expect(ticket.quoteTotal).toBe(750_000 + 150_000);
    expect(ticket.pendingProposals).toBe(0);
    expect(
      ticket.quoteLines.find((line: { id: string }) => line.id === proposal.id).customerAgreed,
    ).toBe(true);
  });

  test('on a cancelled ticket a leftover proposal is history, and handover charges only the fee', async () => {
    h = await openRepairScreenHarness(5305);
    const ticketId = await openTicket(h);
    await h.run(
      'proposeQuoteChange',
      { ticketId, kind: 'part', description: 'Baterai', amount: 150_000, reason: 'Kembung' },
      h.technicianId,
    );
    await h.run(
      'cancelTicket',
      { ticketId, reason: 'Pelanggan batal', fee: 25_000 },
      h.storeOwnerId,
    );

    const screen = await mount(h, h.cashierId);
    await press(screen, 'repair.board.views.pickup');
    await press(screen, `repair.board.row.${ticketId}`);
    expect(screen.query('repair.ticket.action.decidePrice')).toBeNull();
    expect(screen.query('repair.ticket.pendingTotal')).toBeNull();
    await press(screen, 'repair.ticket.action.handover');
    expect(screen.query('repair.handover.cancelled')).not.toBeNull();
    // What the customer signs for is the cancellation fee, never the repair price.
    expect(text(screen, 'repair.handover.total')).toContain('25.000');
    expect(text(screen, 'repair.handover.total')).not.toContain('750.000');
  });

  test('leaving the handover after taking a photo asks first', async () => {
    h = await openRepairScreenHarness(5306);
    const ticketId = await openTicket(h);
    await h.run('cancelTicket', { ticketId, reason: 'Pelanggan batal', fee: 0 }, h.storeOwnerId);
    const screen = await mount(h, h.cashierId);
    await press(screen, 'repair.board.views.pickup');
    await press(screen, `repair.board.row.${ticketId}`);
    await press(screen, 'repair.ticket.action.handover');
    expect(screen.query('repair.handover.primaryHint')).not.toBeNull();
    await press(screen, 'repair.handover.photo.press');
    await press(screen, 'repair.handover.back');
    expect(screen.query('repair.handover.discard')).not.toBeNull();
    expect(screen.query('repair.handover')).not.toBeNull();
  });

  test('handover takes a photo and the customer signature, then the ticket is returned', async () => {
    h = await openRepairScreenHarness(5302);
    const ticketId = await openTicket(h);
    await h.run('startWork', { ticketId, beforePhotos: [h.photo(40)] }, h.technicianId);
    await h.run('markRepaired', { ticketId, afterPhotos: [h.photo(41)] }, h.technicianId);

    const screen = await mount(h, h.cashierId);
    await press(screen, 'repair.board.views.pickup');
    await press(screen, `repair.board.row.${ticketId}`);
    await press(screen, 'repair.ticket.action.handover');
    expect(screen.all('repair.handover.primary')[0]!.props['disabled']).toBe(true);
    await press(screen, 'repair.handover.photo.press');
    await press(screen, 'repair.handover.signature.press');
    await press(screen, 'repair.handover.primary');

    const ticket = await ticketRow(h, ticketId);
    expect(ticket.location).toBe('returned');
    expect(ticket.photos.map((p: { slot: string }) => p.slot)).toEqual(
      expect.arrayContaining(['handover', 'signature']),
    );
    // The ticket now shows the handover photo and signature with the rest of its photos.
    expect(screen.query('repair.ticket.photos.strip.handover')).not.toBeNull();
    expect(screen.query('repair.ticket.photos.strip.signature')).not.toBeNull();
  });
});

describe('cancelling (owners only)', () => {
  test('the counter is never offered a cancel; a store owner is, also on a repaired phone', async () => {
    h = await openRepairScreenHarness(5501);
    const ticketId = await openTicket(h);
    await h.run('startWork', { ticketId, beforePhotos: [h.photo(60)] }, h.technicianId);
    await h.run('markRepaired', { ticketId, afterPhotos: [h.photo(61)] }, h.technicianId);

    const counter = await mount(h, h.cashierId);
    await press(counter, `repair.board.views.pickup`);
    await press(counter, `repair.board.row.${ticketId}`);
    expect(counter.query('repair.ticket.action.handover')).not.toBeNull();
    expect(counter.query('repair.ticket.action.cancel')).toBeNull();
    expect(counter.query('repair.board.views.cancelled')).toBeNull();

    const owner = await mount(h, h.storeOwnerId);
    await press(owner, `repair.board.views.pickup`);
    await press(owner, `repair.board.row.${ticketId}`);
    expect(owner.query('repair.ticket.action.cancel')).not.toBeNull();
  });

  test('the store’s after-work fee is filled in; a changed fee asks why and both are recorded', async () => {
    h = await openRepairScreenHarness(5502);
    await h.run('setCancelFees', { beforeWork: 10_000, afterWork: 50_000 }, h.storeOwnerId);
    const ticketId = await openTicket(h);
    await h.run('startWork', { ticketId, beforePhotos: [h.photo(62)] }, h.technicianId);

    const screen = await mount(h, h.storeOwnerId);
    await press(screen, `repair.board.row.${ticketId}`);
    await press(screen, 'repair.ticket.action.cancel');
    expect(text(screen, 'repair.cancel.feeAmount')).toContain('50.000');
    expect(screen.query('repair.cancel.feeChangedHint')).toBeNull();
    // Nothing is cancelled without a reason.
    expect(screen.all('repair.cancel.primary')[0]!.props['disabled']).toBe(true);

    await press(screen, 'repair.cancel.changeFee');
    type(screen, 'repair.cancel.feeInput', '20.000');
    await settle();
    expect(text(screen, 'repair.cancel.feeAmount')).toContain('20.000');
    expect(text(screen, 'repair.cancel.feeBasis')).toContain('50.000');
    expect(screen.query('repair.cancel.feeChangedHint')).not.toBeNull();
    type(screen, 'repair.cancel.reason', 'Pelanggan langganan, biaya dikurangi');
    await settle();
    await press(screen, 'repair.cancel.primary');

    expect(await ticketRow(h, ticketId)).toMatchObject({
      outcome: 'cancelled',
      cancelFee: 20_000,
      cancelStandardFee: 50_000,
      cancelledBy: h.storeOwnerId,
    });
    expect(text(screen, 'repair.ticket.cancelFee')).toContain('20.000');
  });

  test('the owners’ cancelled view shows who cancelled, why, the fee, and a changed fee', async () => {
    h = await openRepairScreenHarness(5503);
    await h.run('setCancelFees', { beforeWork: 10_000, afterWork: 50_000 }, h.storeOwnerId);
    const kept = await openTicket(h);
    const changed = await openTicket(h);
    await h.run(
      'cancelTicket',
      { ticketId: kept, reason: 'Tidak jadi', fee: 10_000 },
      h.storeOwnerId,
    );
    await h.run('cancelTicket', { ticketId: changed, reason: 'Gratis', fee: 0 }, h.storeOwnerId);

    const screen = await mount(h, h.storeOwnerId);
    await press(screen, 'repair.board.views.cancelled');
    expect(text(screen, `repair.board.row.${kept}.amount`)).toContain('10.000');
    expect(text(screen, `repair.board.row.${kept}.reason`)).toBe('Tidak jadi');
    expect(text(screen, `repair.board.row.${kept}`)).toContain(USER_NAMES.storeOwner);
    expect(screen.query(`repair.board.row.${kept}.feeChanged`)).toBeNull();
    expect(screen.query(`repair.board.row.${changed}.feeChanged`)).not.toBeNull();
  });
});

describe('changing the price', () => {
  test('a change the customer agreed to counts; one not agreed yet waits until they agree', async () => {
    h = await openRepairScreenHarness(5701);
    const ticketId = await openTicket(h);
    const counter = await mount(h, h.cashierId);
    const change = async (description: string, answer: 'primary' | 'unconfirmed') => {
      await press(counter, 'repair.ticket.action.changePrice');
      // Both answers wait on a complete line, and the screen says what "not yet" does.
      expect(counter.all('repair.price.change.unconfirmed')[0]!.props['disabled']).toBe(true);
      expect(counter.query('repair.price.change.waitsHint')).not.toBeNull();
      type(counter, 'repair.price.change.description', description);
      type(counter, 'repair.price.change.amount', '20000');
      type(counter, 'repair.price.change.reason', 'Tambahan');
      expect(counter.query('repair.price.change.question')).not.toBeNull();
      await press(counter, `repair.price.change.${answer}`);
    };
    await press(counter, `repair.board.row.${ticketId}`);
    await change('Lem', 'primary');
    await change('Kabel', 'unconfirmed');
    const waiting = await ticketRow(h, ticketId);
    expect(waiting.quoteTotal).toBe(750_000 + 20_000);
    expect(waiting.pendingProposals).toBe(1);

    // The customer agrees later: the waiting change is decided like a proposal.
    await press(counter, 'repair.ticket.action.decidePrice');
    await press(counter, 'repair.proposal.primary');
    const agreed = await ticketRow(h, ticketId);
    expect(agreed.quoteTotal).toBe(750_000 + 40_000);
    expect(agreed.pendingProposals).toBe(0);
    expect(
      agreed.quoteLines.every(
        (l: { status: string; customerAgreed: boolean | null }) =>
          l.status === 'intake' || l.customerAgreed === true,
      ),
    ).toBe(true);
  });
});

describe('discounts (owners only)', () => {
  test('only an owner is offered a discount when changing the price', async () => {
    h = await openRepairScreenHarness(5601);
    const ticketId = await openTicket(h);

    const counter = await mount(h, h.cashierId);
    await press(counter, `repair.board.row.${ticketId}`);
    await press(counter, 'repair.ticket.action.changePrice');
    expect(counter.query('repair.price.change.kind.part')).not.toBeNull();
    expect(counter.query('repair.price.change.kind.discount')).toBeNull();
    counter.unmount();

    const owner = await mount(h, h.storeOwnerId);
    await press(owner, `repair.board.row.${ticketId}`);
    await press(owner, 'repair.ticket.action.changePrice');
    await press(owner, 'repair.price.change.kind.discount');
    type(owner, 'repair.price.change.description', 'Pelanggan langganan');
    type(owner, 'repair.price.change.amount', '50000');
    type(owner, 'repair.price.change.reason', 'Langganan');
    await press(owner, 'repair.price.change.primary');
    expect((await ticketRow(h, ticketId)).quoteTotal).toBe(750_000 - 50_000);
  });

  test('the counter can decline an owner’s proposed discount but not apply it', async () => {
    h = await openRepairScreenHarness(5602);
    const ticketId = await openTicket(h);
    await h.run(
      'proposeQuoteChange',
      { ticketId, kind: 'discount', description: 'Diskon', amount: -20_000, reason: 'Langganan' },
      h.ownerId,
    );

    const counter = await mount(h, h.cashierId);
    await press(counter, `repair.board.row.${ticketId}`);
    await press(counter, 'repair.ticket.action.decidePrice');
    expect(counter.query('repair.proposal.primaryHint')).not.toBeNull();
    expect(counter.all('repair.proposal.primary')[0]!.props['disabled']).toBe(true);
    await press(counter, 'repair.proposal.decline');
    const ticket = await ticketRow(h, ticketId);
    expect(ticket.pendingProposals).toBe(0);
    expect(ticket.quoteTotal).toBe(750_000);
  });
});

describe('the board', () => {
  test("a colleague's change re-renders the open ticket in place", async () => {
    h = await openRepairScreenHarness(5401);
    const ticketId = await openTicket(h);
    const screen = await mount(h, h.cashierId);
    await press(screen, `repair.board.row.${ticketId}`);
    expect(screen.query('repair.ticket.action.handover')).toBeNull();

    await h.run('startWork', { ticketId, beforePhotos: [h.photo(50)] }, h.technicianId);
    await settle();
    expect(text(screen, 'repair.ticket.technician')).toContain(USER_NAMES.technician);
  });

  test('leaving the handover after typing only a note asks first', async () => {
    h = await openRepairScreenHarness(5307);
    const ticketId = await openTicket(h);
    await h.run('cancelTicket', { ticketId, reason: 'Pelanggan batal', fee: 0 }, h.storeOwnerId);
    const screen = await mount(h, h.cashierId);
    await press(screen, 'repair.board.views.pickup');
    await press(screen, `repair.board.row.${ticketId}`);
    await press(screen, 'repair.ticket.action.handover');
    type(screen, 'repair.handover.note', 'Ada goresan di belakang');
    await press(screen, 'repair.handover.back');
    expect(screen.query('repair.handover.discard')).not.toBeNull();
  });

  test('a user without repair access sees the unauthorized state, not an empty board', async () => {
    h = await openRepairScreenHarness(5402);
    await openTicket(h);
    const onOpenSyncStatus = vi.fn();
    const screen = await mount(h, h.zeroUserId, { onOpenSyncStatus });
    expect(screen.query('repair.board.items.unauthorized')).not.toBeNull();
    expect(screen.query('repair.board.newIntake')).toBeNull();
    // A grant arrives by sync, so the one button says it opens the sync status, and does.
    expect(text(screen, 'ui.unauthorizedState.back')).toContain('Cek status sinkron');
    await press(screen, 'ui.unauthorizedState.back');
    expect(onOpenSyncStatus).toHaveBeenCalledTimes(1);
  });

  test('search finds a ticket by a misspelled name', async () => {
    h = await openRepairScreenHarness(5403);
    const ticketId = await openTicket(h);
    const screen = await mount(h, h.cashierId);
    type(screen, 'repair.board.search', 'yohanes wenda');
    await settle();
    expect(screen.query(`repair.board.row.${ticketId}`)).not.toBeNull();
    expect(screen.query('repair.board.views')).toBeNull();
  });
});

describe('changes synced from another device', () => {
  /** This device's ticket, also on a peer device that has pulled it. */
  async function sharedTicket(
    seed: number,
  ): Promise<{ a: RepairHarness; b: RepairHarness; ticketId: string }> {
    h = await openRepairScreenHarness(seed);
    peer = await openRepairScreenHarness(seed + 50, h);
    const ticketId = await openTicket(h);
    await pull(peer, h);
    return { a: h, b: peer, ticketId };
  }

  test('a pulled change re-renders the open ticket', async () => {
    const { a, b, ticketId } = await sharedTicket(5601);
    const screen = await mount(a, a.cashierId);
    await press(screen, `repair.board.row.${ticketId}`);
    expect(text(screen, 'repair.ticket.technician')).not.toContain(USER_NAMES.technician);

    await b.run('startWork', { ticketId, beforePhotos: [b.photo(60)] }, b.technicianId);
    await pull(a, b);
    await settle();
    expect(text(screen, 'repair.ticket.technician')).toContain(USER_NAMES.technician);
    expect(screen.query('repair.ticket.action.markRepaired')).toBeNull(); // cashier view
  });

  test('a repair cancelled elsewhere stops the open step and leads back without asking', async () => {
    const { a, b, ticketId } = await sharedTicket(5602);
    await a.run('startWork', { ticketId, beforePhotos: [a.photo(61)] }, a.technicianId);
    await pull(b, a);
    const screen = await mount(a, a.technicianId);
    await press(screen, `repair.board.row.${ticketId}`);
    await press(screen, 'repair.ticket.action.markRepaired');
    await press(screen, 'repair.work.after.take.press');
    expect(screen.query('repair.work.after.stale')).toBeNull();
    expect(screen.get('repair.work.after.body').props['pointerEvents']).toBe('auto');

    await b.run('cancelTicket', { ticketId, reason: 'Pelanggan batal' }, b.storeOwnerId);
    await pull(a, b);
    await settle();
    // The step says what happened, and its only way on is back to the ticket.
    expect(screen.query('repair.work.after.stale')).not.toBeNull();
    expect(screen.query('repair.work.after.primary')).toBeNull();
    // What they had filled in stays in view, but cannot be worked any more.
    expect(screen.get('repair.work.after.body').props['pointerEvents']).toBe('none');
    await press(screen, 'repair.work.after.staleBack');
    // The photo taken is of no use now, so leaving does not ask to discard it.
    expect(screen.query('repair.work.after.discard')).toBeNull();
    expect(screen.query('repair.ticket.content')).not.toBeNull();
    expect(screen.query('repair.ticket.action.markRepaired')).toBeNull();
    expect((await ticketRow(a, ticketId)).outcome).toBe('cancelled');
  });

  test('a proposal answered on another device cannot be answered again', async () => {
    const { a, b, ticketId } = await sharedTicket(5603);
    const { lineId } = (await a.run(
      'proposeQuoteChange',
      { ticketId, kind: 'part', description: 'Baterai', amount: 150_000, reason: 'Kembung' },
      a.technicianId,
    )) as { lineId: string };
    await pull(b, a);
    const screen = await mount(a, a.cashierId);
    await press(screen, `repair.board.row.${ticketId}`);
    await press(screen, 'repair.ticket.action.decidePrice');
    expect(screen.query('repair.proposal.primary')).not.toBeNull();

    await b.run('declineProposal', { ticketId, lineId, note: 'Mahal' }, b.cashierId);
    await pull(a, b);
    await settle();
    expect(screen.query('repair.proposal.stale')).not.toBeNull();
    expect(screen.query('repair.proposal.primary')).toBeNull();
    await press(screen, 'repair.proposal.staleBack');
    expect(screen.query('repair.ticket.action.decidePrice')).toBeNull();
  });

  test('a phone handed back on another device stops the handover', async () => {
    const { a, b, ticketId } = await sharedTicket(5604);
    await a.run('cancelTicket', { ticketId, reason: 'Pelanggan batal' }, a.storeOwnerId);
    await pull(b, a);
    const screen = await mount(a, a.cashierId);
    await press(screen, 'repair.board.views.pickup');
    await press(screen, `repair.board.row.${ticketId}`);
    await press(screen, 'repair.ticket.action.handover');
    await press(screen, 'repair.handover.photo.press');

    await b.run(
      'returnDevice',
      { ticketId, handoverPhoto: b.photo(62), signature: b.photo(63) },
      b.cashierId,
    );
    await pull(a, b);
    await settle();
    expect(screen.query('repair.handover.stale')).not.toBeNull();
    expect(screen.query('repair.handover.primary')).toBeNull();
    await press(screen, 'repair.handover.staleBack');
    expect(screen.query('repair.handover.discard')).toBeNull();
    expect(screen.query('repair.ticket.content')).not.toBeNull();
    expect(screen.query('repair.ticket.action.handover')).toBeNull();
  });

  test('an op the server refuses shows on the open ticket as the push lands', async () => {
    h = await openRepairScreenHarness(5606);
    const ticketId = await openTicket(h);
    const screen = await mount(h, h.cashierId);
    await press(screen, `repair.board.row.${ticketId}`);
    expect(screen.query('repair.ticket.rejectedBanner')).toBeNull();

    // What a push marks, with no projection write of its own: only the op log changed.
    const [opened] = (await h.ownOps()).filter((op) => op.entityId === ticketId);
    await markSyncResult(h.db as never, {
      id: opened!.id,
      currentStatus: 'local',
      event: { kind: 'rejected', rejectionCode: 'SCOPE_VIOLATION', rejectionReason: 'nope' },
    });
    h.engine.invalidation.emit(new Set([OP_SYNC_STATUS_TABLE]));
    await settle();
    expect(screen.query('repair.ticket.rejectedBanner')).not.toBeNull();
  });

  test("the user's own change closes the step without a stale notice", async () => {
    const { a, ticketId } = await sharedTicket(5605);
    // Hold the command open after it commits, so the ticket's re-read lands while it still runs:
    // the moment the notice must not appear, since the change is the user's own.
    const base = repairRuntimeFor(a, a.storeOwnerId);
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = {
      ...base,
      run: ((command, input) =>
        base.run(command, input).then((result) => held.then(() => result))) as typeof base.run,
    };
    const screen = await mount(a, a.storeOwnerId, { runtime });
    await press(screen, `repair.board.row.${ticketId}`);
    await press(screen, 'repair.ticket.action.cancel');
    type(screen, 'repair.cancel.reason', 'Pelanggan batal');
    await press(screen, 'repair.cancel.primary');
    expect((await ticketRow(a, ticketId)).outcome).toBe('cancelled');
    expect(screen.query('repair.cancel')).not.toBeNull();
    expect(screen.query('repair.cancel.stale')).toBeNull();

    release();
    await settle();
    expect(screen.query('repair.cancel')).toBeNull();
    expect(screen.query('repair.ticket.content')).not.toBeNull();
  });
});

describe('hardware back', () => {
  /** Mount with the shell's surface-nav slot captured, and press back the way the shell does. */
  async function mountWithBack(harness: RepairHarness, userId: string) {
    let nav: SurfaceNav | null = null;
    const screen = await mount(harness, userId, {
      onRegisterSurfaceNav: (next) => {
        nav = next;
      },
    });
    const back = async (): Promise<boolean | undefined> => {
      const consumed = (nav as SurfaceNav | null)?.handleBack();
      await settle();
      return consumed;
    };
    return { screen, back };
  }

  test('leaving the surface from a step holding unsaved photos asks first', async () => {
    h = await openRepairScreenHarness(5409);
    const ticketId = await openTicket(h);
    let nav: SurfaceNav | null = null;
    const screen = await mount(h, h.technicianId, {
      onRegisterSurfaceNav: (next) => {
        nav = next;
      },
    });
    await press(screen, 'repair.board.views.unassigned');
    await press(screen, `repair.board.row.${ticketId}`);
    await press(screen, 'repair.ticket.action.start');
    await press(screen, 'repair.work.before.take.press');
    // The header sync chip leaves the whole surface, not just the step.
    const proceed = vi.fn();
    (nav as SurfaceNav | null)?.requestLeave(proceed);
    await settle();
    expect(proceed).not.toHaveBeenCalled();
    expect(screen.query('repair.work.before.discard')).not.toBeNull();
  });

  test('back inside a ticket step returns to the ticket, and only then to the board', async () => {
    h = await openRepairScreenHarness(5501);
    const ticketId = await openTicket(h);
    const { screen, back } = await mountWithBack(h, h.cashierId);
    await press(screen, `repair.board.row.${ticketId}`);
    await press(screen, 'repair.ticket.action.changePrice');
    expect(screen.query('repair.price.change')).not.toBeNull();

    expect(await back()).toBe(true);
    expect(screen.query('repair.price.change')).toBeNull();
    expect(screen.query('repair.ticket.content')).not.toBeNull();

    expect(await back()).toBe(true);
    expect(screen.query('repair.board')).not.toBeNull();
  });

  test('back closes an open photo, then the photo sheet, and only then leaves the ticket', async () => {
    h = await openRepairScreenHarness(5503);
    const ticketId = await openTicket(h);
    const { screen, back } = await mountWithBack(h, h.cashierId);
    await press(screen, `repair.board.row.${ticketId}`);
    // Six intake photos sit in one strip, not a grid; "see all" opens every one by group.
    expect(screen.query('repair.ticket.photos.strip.front')).not.toBeNull();
    await press(screen, 'repair.ticket.photos.seeAll');
    await press(screen, 'repair.ticket.photos.sheet.back');
    expect(text(screen, 'repair.ticket.photos.viewer.label')).toBe('Belakang');

    expect(await back()).toBe(true);
    expect(screen.query('repair.ticket.photos.viewer')).toBeNull();
    expect(screen.query('repair.ticket.photos.sheet')).not.toBeNull();

    expect(await back()).toBe(true);
    expect(screen.query('repair.ticket.photos.sheet')).toBeNull();
    expect(screen.query('repair.ticket.content')).not.toBeNull();

    expect(await back()).toBe(true);
    expect(screen.query('repair.board')).not.toBeNull();
  });

  test('back in the intake goes one step back, and asks before dropping a started intake', async () => {
    h = await openRepairScreenHarness(5502);
    const { screen, back } = await mountWithBack(h, h.cashierId);
    await press(screen, 'repair.board.newIntake');
    type(screen, 'repair.intake.customer.name', 'Ester');
    await press(screen, 'repair.intake.primary');
    expect(screen.query('repair.intake.step.device')).not.toBeNull();

    await back();
    expect(screen.query('repair.intake.step.customer')).not.toBeNull();
    expect(screen.query('repair.intake.discard')).toBeNull();

    await back();
    expect(screen.query('repair.intake.discard')).not.toBeNull();
    expect(screen.query('repair.intake')).not.toBeNull();
  });
});

describe('price and assignment details', () => {
  test('an amount typed without a description is named instead of silently dropped', async () => {
    h = await openRepairScreenHarness(5601);
    const draft: IntakeDraft = {
      kind: 'intake',
      step: 4,
      customer: { kind: 'new', name: 'Ester', phone: '' },
      device: { brand: 'Oppo', model: 'A57', color: '', imei: '', lockKind: 'none', passcode: '' },
      complaint: 'Mati',
      intakeNotes: '',
      checks: {},
      peripherals: [],
      photos: {},
      lines: [],
      downPayment: '',
      ready: 'tomorrow',
    };
    const screen = await mount(h, h.cashierId, { restoredDraft: draft });
    type(screen, 'repair.intake.price.amount.0', '150000');
    await press(screen, 'repair.intake.primary');
    expect(screen.query('repair.intake.step.price')).not.toBeNull();
    expect(screen.query('repair.intake.price.description.0.error')).not.toBeNull();
    expect(screen.query('repair.intake.problem.incompleteLine')).toBeNull();
    expect(text(screen, 'repair.intake.price.total')).toContain('0');
  });

  test('a restored intake drops photos that were deleted while it waited, and asks for them again', async () => {
    h = await openRepairScreenHarness(5603);
    const kept = h.photo(71);
    const gone = h.photo(72);
    const draft: IntakeDraft = {
      kind: 'intake',
      step: 3,
      customer: { kind: 'new', name: 'Ester', phone: '' },
      device: { brand: 'Oppo', model: 'A57', color: '', imei: '', lockKind: 'none', passcode: '' },
      complaint: 'Mati',
      intakeNotes: '',
      checks: {},
      peripherals: [],
      photos: { front: kept, back: gone },
      lines: [],
      downPayment: '',
      ready: 'tomorrow',
    };
    const runtime = repairRuntimeFor(h, h.cashierId);
    const screen = await mount(h, h.cashierId, {
      restoredDraft: draft,
      runtime: {
        ...runtime,
        loadThumbnail: (ref) =>
          Promise.resolve(
            ref.kind === 'signed' && ref.mediaId === kept.mediaId
              ? { kind: 'ready', uri: 'file:///kept.jpg' }
              : { kind: 'unavailable' },
          ),
      },
    });
    await settle();
    expect(screen.query('repair.intake.photosExpired')).not.toBeNull();
    expect(screen.query('repair.intake.photos.slot.front.done')).not.toBeNull();
    expect(screen.query('repair.intake.photos.slot.back.done')).toBeNull();
  });

  test('a proposal waiting on the counter is shown apart from the agreed total', async () => {
    h = await openRepairScreenHarness(5602);
    const ticketId = await openTicket(h);
    await h.run(
      'proposeQuoteChange',
      { ticketId, kind: 'part', description: 'Baterai', amount: 150_000, reason: 'Kembung' },
      h.technicianId,
    );
    const screen = await mount(h, h.cashierId);
    await press(screen, `repair.board.row.${ticketId}`);
    expect(text(screen, 'repair.ticket.total')).toContain('750.000');
    expect(text(screen, 'repair.ticket.pendingTotal')).toContain('150.000');
  });

  test('the counter sees how many repairs each technician already holds', async () => {
    h = await openRepairScreenHarness(5603);
    const first = await openTicket(h);
    const second = await openTicket(h);
    await h.run('assignTechnician', { ticketId: first, technicianId: h.technicianId }, h.cashierId);
    const screen = await mount(h, h.cashierId);
    await press(screen, `repair.board.row.${second}`);
    // Unassigned, picking a technician is the counter's next step, so it is the bottom action.
    await press(screen, 'repair.ticket.action.assign');
    expect(text(screen, `repair.assign.row.${h.technicianId}.secondary`)).toContain('1');
    expect(text(screen, `repair.assign.row.${h.technician2Id}.secondary`)).toContain('0');
  });
});
