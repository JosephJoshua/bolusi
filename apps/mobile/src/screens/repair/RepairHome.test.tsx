// The repair phone flows, mounted over a real runtime: a counter intake from the board to a new
// ticket, a technician's required before and after photos, assignment, a proposed price change the
// cashier decides, the handover, live updates from a colleague, and the intake kept across a lock.
import { markSyncResult, OP_SYNC_STATUS_TABLE } from '@bolusi/core';
import { DEFAULT_LOCALE, setLocale } from '@bolusi/i18n';
import { emptyIntakeDraft, INTAKE_PHOTO_SLOTS, type IntakeDraft } from '@bolusi/modules/repair';
import { tn } from '@bolusi/modules/repair/screens';
import { color } from '@bolusi/ui';
import { StyleSheet } from 'react-native';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { __windowMetrics } from '../../../test/doubles/react-native.js';

import {
  ensureRepairCatalog,
  intake,
  openRepairScreenHarness,
  press,
  pull,
  render,
  repairRuntimeFor,
  settle,
  settleTyping,
  text,
  type,
  USER_NAMES,
  type RepairHarness,
  type RenderResult,
  waitUntil,
} from '../../../test/repair-support.js';

import type { SurfaceNav } from '../../navigation/surface.js';

import { RepairHome, listPaneWidth } from './RepairHome.js';

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
  // On the first Android run "Tidak dicek" showed as "Tidak": squeezed beside the check's name.
  // Where the states fit they sit on the name's line; on a narrow phone or a large system font they
  // go under the name. Either way each pill keeps its text's width.
  test('condition checks stack under the name on a narrow phone or a large font', async () => {
    h = await openRepairScreenHarness(5150);
    const screen = await mount(h, h.cashierId);
    await press(screen, 'repair.board.newIntake');
    type(screen, 'repair.intake.customer.name', 'Yohanis Wenda');
    await press(screen, 'repair.intake.primary');
    type(screen, 'repair.intake.device.brand', 'Samsung');
    type(screen, 'repair.intake.device.model', 'Galaxy A14');
    await press(screen, 'repair.intake.primary');
    const original = { ...__windowMetrics };
    try {
      for (const [width, fontScale, stacked] of [
        [411, 1, false],
        [360, 1, true],
        [411, 1.3, true],
      ] as const) {
        Object.assign(__windowMetrics, { width, fontScale });
        // Any edit re-renders the step, which reads the window again.
        type(
          screen,
          'repair.intake.condition.complaint',
          `Layar retak ${String(width * fontScale)}`,
        );
        await settle();
        const row = StyleSheet.flatten(
          screen.get('repair.intake.condition.checkRow.screen').props['style'],
        );
        expect(row['flexDirection']).toBe(stacked ? 'column' : 'row');
        const pill = StyleSheet.flatten(
          screen.get('repair.intake.condition.check.screen.not_checked').props['style'],
        );
        expect(pill['flexShrink']).toBe(0);
      }
    } finally {
      Object.assign(__windowMetrics, original);
    }
  });

  // The keyboard opened by itself on intake steps and covered "Lanjut" (Android QA): no step
  // focuses a field on its own; the person taps the field they want to fill.
  test('no intake step opens the keyboard by itself', async () => {
    h = await openRepairScreenHarness(5151);
    const screen = await mount(h, h.cashierId);
    const focused = (): number =>
      screen.container.queryAll((n) => n.props['autoFocus'] === true).length;
    await press(screen, 'repair.board.newIntake');
    expect(focused()).toBe(0);
    type(screen, 'repair.intake.customer.name', 'Yohanis Wenda');
    await press(screen, 'repair.intake.primary');
    type(screen, 'repair.intake.device.brand', 'Samsung');
    type(screen, 'repair.intake.device.model', 'Galaxy A14');
    await press(screen, 'repair.intake.primary');
    expect(screen.query('repair.intake.condition.complaint')).not.toBeNull();
    expect(focused()).toBe(0);
  });

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
    await settleTyping();
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
      repairTypes: [],
      claimOf: null,
      intakeNotes: '',
      checks: {},
      peripherals: [],
      photos: {},
      ownershipVideo: null,
      lines: [],
      downPayment: '',
      downPaymentAccount: 'cash',
      downPaymentReference: '',
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
    // Not until the counter went through the checks and the accessories with the customer.
    expect(screen.all('repair.handover.primary')[0]!.props['disabled']).toBe(true);
    for (const line of [
      'check.customerTried',
      'check.repairWorks',
      'accessory.charger',
      'accessory.case',
    ]) {
      await press(screen, `repair.handover.check.${line}`);
    }
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

describe('Bayar nanti (owners; the counter asks)', () => {
  test('the counter asks at handover, and once an owner approves, hands the phone over unpaid', async () => {
    h = await openRepairScreenHarness(5521);
    const ticketId = await openTicket(h);
    await h.run('startWork', { ticketId, beforePhotos: [h.photo(70)] }, h.technicianId);
    await h.run('markRepaired', { ticketId, afterPhotos: [h.photo(71)] }, h.technicianId);
    const checks = [
      'check.customerTried',
      'check.repairWorks',
      'accessory.charger',
      'accessory.case',
    ];

    const counter = await mount(h, h.cashierId);
    await press(counter, 'repair.board.views.pickup');
    await press(counter, `repair.board.row.${ticketId}`);
    await press(counter, 'repair.ticket.action.handover');
    await press(counter, 'repair.handover.payLater');
    expect(text(counter, 'repair.handover.asks')).toBe(tn('repair.approval.needsApproval'));
    // Not theirs at all, so no limit to show.
    expect(counter.query('repair.handover.limit')).toBeNull();
    // Asking needs the reason, which the owner reads.
    expect(counter.all('repair.handover.askPayLater')[0]!.props['disabled']).toBe(true);
    type(counter, 'repair.handover.unpaidReason', 'Gajian Jumat');
    await settle();
    await press(counter, 'repair.handover.askPayLater');
    // Read live: the request shows as it lands.
    expect(await waitUntil(() => counter.query('repair.handover.waiting') !== null)).toBe(true);
    expect(text(counter, 'repair.handover.primaryHint')).toBe(tn('repair.hint.payLaterWaiting'));
    counter.unmount();

    const owner = await mount(h, h.storeOwnerId);
    await press(owner, 'repair.board.views.approvals');
    await press(owner, `repair.board.row.${ticketId}`);
    const [request] = (
      await h.approvalsQuery('approvalRequests', { targetId: ticketId }, h.storeOwnerId)
    ).rows;
    expect(request).toMatchObject({ status: 'waiting', amount: 750_000, reason: 'Gajian Jumat' });
    await press(owner, `repair.ticket.approvals.${request!.id}`);
    await press(owner, 'repair.ticket.approval.primary');
    // Approving lets the counter do it; the phone is still in the store.
    expect((await ticketRow(h, ticketId)).location).toBe('in_store');
    owner.unmount();

    const back = await mount(h, h.cashierId);
    await press(back, 'repair.board.views.pickup');
    await press(back, `repair.board.row.${ticketId}`);
    await press(back, 'repair.ticket.action.handover');
    await press(back, 'repair.handover.payLater');
    expect(await waitUntil(() => back.query('repair.handover.permitted') !== null)).toBe(true);
    type(back, 'repair.handover.unpaidReason', 'Gajian Jumat');
    await press(back, 'repair.handover.photo.press');
    await press(back, 'repair.handover.signature.press');
    for (const line of checks) await press(back, `repair.handover.check.${line}`);
    await settle();
    await press(back, 'repair.handover.primary');
    expect((await ticketRow(h, ticketId)).location).toBe('returned');
  });
});

describe('a down payment fix (owners; the counter asks)', () => {
  test('the counter asks to fix a DP, and the owner’s yes fixes it', async () => {
    h = await openRepairScreenHarness(5531);
    const ticketId = await openTicket(h);
    await h.run('recordDownPayment', { ticketId, amount: 100_000 }, h.cashierId);

    const counter = await mount(h, h.cashierId);
    await press(counter, `repair.board.row.${ticketId}`);
    await press(counter, 'repair.ticket.downPayment.correct');
    type(counter, 'repair.downPayment.amount', '80.000');
    type(counter, 'repair.downPayment.reason', 'Salah ketik');
    await settle();
    expect(text(counter, 'repair.downPayment.asks')).toBe(tn('repair.approval.needsApproval'));
    await press(counter, 'repair.downPayment.primary');
    expect((await ticketRow(h, ticketId)).downPayment).toBe(100_000);
    const [request] = (
      await h.approvalsQuery('approvalRequests', { targetId: ticketId }, h.cashierId)
    ).rows;
    expect(request).toMatchObject({ kind: 'repair.downPayment', amount: 20_000 });
    counter.unmount();

    const owner = await mount(h, h.storeOwnerId);
    await press(owner, 'repair.board.views.approvals');
    await press(owner, `repair.board.row.${ticketId}`);
    await press(owner, `repair.ticket.approvals.${request!.id}`);
    await press(owner, 'repair.ticket.approval.primary');
    expect((await ticketRow(h, ticketId)).downPayment).toBe(80_000);
  });
});

describe('cancelling (owners; the counter asks)', () => {
  test('the counter asks an owner to cancel, and the owner’s yes cancels it at the asked fee', async () => {
    h = await openRepairScreenHarness(5501);
    await h.run('setCancelFees', { beforeWork: 10_000, afterWork: 50_000 }, h.storeOwnerId);
    const ticketId = await openTicket(h);
    await h.run('startWork', { ticketId, beforePhotos: [h.photo(60)] }, h.technicianId);
    await h.run('markRepaired', { ticketId, afterPhotos: [h.photo(61)] }, h.technicianId);

    const counter = await mount(h, h.cashierId);
    await press(counter, `repair.board.views.pickup`);
    await press(counter, `repair.board.row.${ticketId}`);
    expect(counter.query('repair.ticket.action.handover')).not.toBeNull();
    expect(counter.query('repair.board.views.cancelled')).toBeNull();
    await press(counter, 'repair.ticket.action.cancel');
    expect(text(counter, 'repair.cancel.asks')).toBe(tn('repair.approval.needsApproval'));
    await press(counter, 'repair.cancel.changeFee');
    type(counter, 'repair.cancel.feeInput', '20.000');
    type(counter, 'repair.cancel.reason', 'Pelanggan tidak jadi');
    await settle();
    await press(counter, 'repair.cancel.primary');
    // Asked, not cancelled: the request shows on the servisan, waiting.
    expect((await ticketRow(h, ticketId)).outcome).toBe('repaired');
    const [request] = (
      await h.approvalsQuery('approvalRequests', { targetId: ticketId }, h.cashierId)
    ).rows;
    expect(request).toMatchObject({ status: 'waiting', amount: 30_000 });
    expect(counter.query(`repair.ticket.approvals.${request!.id}`)).not.toBeNull();
    counter.unmount();

    // The owner finds it under its own view, and approves it from the servisan.
    const owner = await mount(h, h.storeOwnerId);
    await press(owner, 'repair.board.views.approvals');
    expect(owner.query(`repair.board.row.${ticketId}.approvalWaiting`)).not.toBeNull();
    await press(owner, `repair.board.row.${ticketId}`);
    await press(owner, `repair.ticket.approvals.${request!.id}`);
    await press(owner, 'repair.ticket.approval.primary');
    expect(await ticketRow(h, ticketId)).toMatchObject({
      outcome: 'cancelled',
      cancelFee: 20_000,
      cancelledBy: h.storeOwnerId,
    });
    // Nothing waits any more, so the view goes and the board returns to its usual queue.
    expect(owner.query('repair.board.views.approvals')).toBeNull();
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

    // The ticket leads with what is owed, not the repair total it no longer charges.
    await press(screen, `repair.board.row.${changed}`);
    expect(text(screen, 'repair.ticket.cancelFee')).toBe('Rp 0');
    expect(
      StyleSheet.flatten(screen.get('repair.ticket.total').props['style']).textDecorationLine,
    ).toBe('line-through');
    // At a large font the label wraps; the amount never splits into "Rp" and "0" on two lines.
    const fee = screen.get('repair.ticket.cancelFee');
    const label = fee.parent?.children[0];
    expect(typeof label === 'object' && label.type).toBe('Text');
    expect(
      StyleSheet.flatten(typeof label === 'object' ? label.props['style'] : null).flexShrink,
    ).toBe(1);
    expect(StyleSheet.flatten(fee.props['style']).flexShrink).toBe(0);
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

describe('discounts (owners; the counter asks)', () => {
  test('the counter asks for a discount, which an owner approves for the customer to confirm', async () => {
    h = await openRepairScreenHarness(5601);
    const ticketId = await openTicket(h);

    const counter = await mount(h, h.cashierId);
    await press(counter, `repair.board.row.${ticketId}`);
    await press(counter, 'repair.ticket.action.changePrice');
    await press(counter, 'repair.price.change.kind.discount');
    // Asking skips the customer's answer, which comes once an owner approves.
    expect(text(counter, 'repair.price.change.asks')).toBe(tn('repair.approval.needsApproval'));
    expect(counter.query('repair.price.change.question')).toBeNull();
    expect(counter.query('repair.price.change.unconfirmed')).toBeNull();
    type(counter, 'repair.price.change.description', 'Pelanggan langganan');
    type(counter, 'repair.price.change.amount', '30000');
    type(counter, 'repair.price.change.reason', 'Langganan');
    await press(counter, 'repair.price.change.primary');
    expect((await ticketRow(h, ticketId)).quoteTotal).toBe(750_000);
    const [request] = (
      await h.approvalsQuery('approvalRequests', { targetId: ticketId }, h.cashierId)
    ).rows;
    expect(request).toMatchObject({ status: 'waiting', amount: 30_000, mine: true });
    counter.unmount();

    const approver = await mount(h, h.storeOwnerId);
    await press(approver, 'repair.board.views.approvals');
    await press(approver, `repair.board.row.${ticketId}`);
    await press(approver, `repair.ticket.approvals.${request!.id}`);
    await press(approver, 'repair.ticket.approval.primary');
    const approved = await ticketRow(h, ticketId);
    expect(approved.quoteTotal).toBe(750_000);
    expect(approved.pendingProposals).toBe(1);
    approver.unmount();
  });

  test('an owner gives a discount directly', async () => {
    h = await openRepairScreenHarness(5603);
    const ticketId = await openTicket(h);

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
    // Nothing is searched until the typing pauses.
    await settle();
    expect(screen.query('repair.board.views')).not.toBeNull();
    await settleTyping();
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
      {
        ticketId,
        handoverPhoto: b.photo(62),
        signature: b.photo(63),
        checklist: ['charger', 'case'].map((item) => ({
          kind: 'accessory',
          item,
          label: null,
          done: true,
        })),
      },
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
      repairTypes: [],
      claimOf: null,
      intakeNotes: '',
      checks: {},
      peripherals: [],
      photos: {},
      ownershipVideo: null,
      lines: [],
      downPayment: '',
      downPaymentAccount: 'cash',
      downPaymentReference: '',
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
      repairTypes: [],
      claimOf: null,
      intakeNotes: '',
      checks: {},
      peripherals: [],
      photos: { front: kept, back: gone },
      ownershipVideo: null,
      lines: [],
      downPayment: '',
      downPaymentAccount: 'cash',
      downPaymentReference: '',
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

  test('a restored intake drops an ownership video deleted while it waited', async () => {
    const harness = await openRepairScreenHarness(5604);
    h = harness;
    const photos = Object.fromEntries(
      ['front', 'back', 'left', 'right', 'top', 'bottom'].map((slot, i) => [
        slot,
        harness.photo(80 + i),
      ]),
    );
    const clip = { ...harness.photo(90), mime: 'video/mp4' as const, type: 'video' as const };
    const draft: IntakeDraft = {
      kind: 'intake',
      step: 3,
      customer: { kind: 'new', name: 'Ester', phone: '' },
      device: { brand: 'Oppo', model: 'A57', color: '', imei: '', lockKind: 'none', passcode: '' },
      complaint: 'Lupa pola',
      repairTypes: ['unlock'],
      claimOf: null,
      intakeNotes: '',
      checks: {},
      peripherals: [],
      photos,
      ownershipVideo: clip,
      lines: [],
      downPayment: '',
      downPaymentAccount: 'cash',
      downPaymentReference: '',
      ready: 'tomorrow',
    };
    const runtime = repairRuntimeFor(h, h.cashierId);
    const asked: string[] = [];
    const screen = await mount(h, h.cashierId, {
      restoredDraft: draft,
      runtime: {
        ...runtime,
        loadThumbnail: () => Promise.resolve({ kind: 'ready', uri: 'file:///kept.jpg' }),
        recordVideo: () => Promise.resolve(null),
        videoKept: (ref) => {
          asked.push(ref.mediaId);
          return Promise.resolve(false);
        },
      },
    });
    await settle();
    expect(asked).toEqual([clip.mediaId]);
    expect(screen.query('repair.intake.videoExpired')).not.toBeNull();
    expect(text(screen, 'repair.intake.primary')).toContain('Rekam video kepemilikan');
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

describe('on a tablet', () => {
  /** Runs `body` with the window at a tablet's size, then puts the phone back. */
  async function asTablet(
    size: { readonly width: number; readonly height: number },
    body: () => Promise<void>,
  ): Promise<void> {
    const original = { ...__windowMetrics };
    Object.assign(__windowMetrics, size);
    try {
      await body();
    } finally {
      Object.assign(__windowMetrics, original);
    }
  }

  /** White on the filled primary button, blue on the outlined secondary one. */
  function intakeLabelColor(screen: RenderResult): unknown {
    return StyleSheet.flatten(screen.get('repair.board.newIntake.label').props['style'])['color'];
  }

  test('in landscape the board stays beside the open ticket', async () => {
    h = await openRepairScreenHarness(5801);
    const ticketId = await openTicket(h);
    await asTablet({ width: 1280, height: 800 }, async () => {
      const screen = await mount(h!, h!.cashierId);
      expect(screen.query('repair.split')).not.toBeNull();
      expect(screen.query('repair.board.noTicketOpen')).not.toBeNull();
      expect(intakeLabelColor(screen)).toBe(color.onPrimary);

      await press(screen, `repair.board.row.${ticketId}`);
      expect(screen.query('repair.board')).not.toBeNull();
      expect(screen.query('repair.ticket.content')).not.toBeNull();
      expect(screen.query('repair.board.noTicketOpen')).toBeNull();
      // The board is in view, so the ticket has no back arrow; the open row is marked, and the
      // ticket's next step is the one primary action on screen.
      expect(screen.query('repair.ticket.back')).toBeNull();
      expect(
        screen.all(`repair.board.row.${ticketId}`)[0]!.props['accessibilityState'],
      ).toMatchObject({ selected: true });
      expect(intakeLabelColor(screen)).toBe(color.primary);
    });
  });

  test('a step holding photos beside the board asks before another ticket replaces it', async () => {
    h = await openRepairScreenHarness(5802);
    const first = await openTicket(h);
    const second = await openTicket(h);
    await asTablet({ width: 1280, height: 800 }, async () => {
      const screen = await mount(h!, h!.technicianId);
      await press(screen, 'repair.board.views.unassigned');
      await press(screen, `repair.board.row.${first}`);
      await press(screen, 'repair.ticket.action.start');
      await press(screen, 'repair.work.before.take.press');
      // Its own row again is no change, so nothing is asked and the step stays.
      await press(screen, `repair.board.row.${first}`);
      expect(screen.query('repair.work.before.discard')).toBeNull();
      expect(screen.query('repair.work.before')).not.toBeNull();
      await press(screen, `repair.board.row.${second}`);
      expect(screen.query('repair.work.before.discard')).not.toBeNull();
      expect(screen.query('repair.work.before')).not.toBeNull();
    });
  });

  test('upright, a tablet shows one screen at a time like a phone', async () => {
    h = await openRepairScreenHarness(5803);
    const ticketId = await openTicket(h);
    await asTablet({ width: 800, height: 1280 }, async () => {
      const screen = await mount(h!, h!.cashierId);
      expect(screen.query('repair.split')).toBeNull();
      expect(screen.query('repair.board.noTicketOpen')).toBeNull();
      await press(screen, `repair.board.row.${ticketId}`);
      expect(screen.query('repair.board')).toBeNull();
      expect(screen.query('repair.ticket.back')).not.toBeNull();
    });
  });

  test('the intake keeps the whole screen', async () => {
    h = await openRepairScreenHarness(5804);
    await asTablet({ width: 1280, height: 800 }, async () => {
      const screen = await mount(h!, h!.cashierId);
      await press(screen, 'repair.board.newIntake');
      expect(screen.query('repair.split')).toBeNull();
      expect(screen.query('repair.board')).toBeNull();
      expect(screen.query('repair.intake.step.customer')).not.toBeNull();
    });
  });
});

describe('listPaneWidth', () => {
  test('gives the board a phone width and the ticket the rest', () => {
    expect(listPaneWidth(840)).toBe(340);
    expect(listPaneWidth(960)).toBe(384);
    expect(listPaneWidth(1280)).toBe(420);
  });
});
