// The repair phone flows, mounted over a real runtime: a counter intake from the board to a new
// ticket, a technician's required before and after photos, assignment, a proposed price change the
// cashier decides, the handover, live updates from a colleague, and the intake kept across a lock.
import { DEFAULT_LOCALE, setLocale } from '@bolusi/i18n';
import { INTAKE_PHOTO_SLOTS, type IntakeDraft } from '@bolusi/modules/repair';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  ensureRepairCatalog,
  intake,
  openRepairScreenHarness,
  press,
  render,
  repairRuntimeFor,
  settle,
  text,
  type,
  USER_NAMES,
  type RepairHarness,
  type RenderResult,
} from '../../../test/repair-support.js';

import { RepairHome } from './RepairHome.js';

let h: RepairHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
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
      now={NOW}
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

    // All six photos are required.
    await press(screen, 'repair.intake.photos.slot.front.press');
    await press(screen, 'repair.intake.primary');
    expect(screen.query('repair.intake.problem.photos')).not.toBeNull();
    for (const slot of INTAKE_PHOTO_SLOTS.slice(1)) {
      await press(screen, `repair.intake.photos.slot.${slot}.press`);
    }
    await press(screen, 'repair.intake.primary');

    type(screen, 'repair.intake.price.description', 'LCD A14');
    type(screen, 'repair.intake.price.amount', '650.000');
    await press(screen, 'repair.intake.price.addLine');
    await press(screen, 'repair.intake.primary');
    expect(screen.query('repair.intake.step.review')).not.toBeNull();
    await press(screen, 'repair.intake.primary');

    expect(screen.query('repair.ticket.content')).not.toBeNull();
    expect(text(screen, 'repair.ticket.customer')).toBe('Yohanis Wenda');
    const page = await h.query('listTickets', {}, h.cashierId);
    expect(page.rows).toHaveLength(1);
    const ticket = await ticketRow(h, page.rows[0].id);
    expect(ticket.quoteTotal).toBe(650_000);
    expect(ticket.peripherals).toEqual(['charger']);
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
      device: { brand: 'Oppo', model: '', color: '', imei: '', passcode: '' },
      complaint: '',
      intakeNotes: '',
      checks: {},
      peripherals: [],
      photos: {},
      lines: [],
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
    await press(cashier, `repair.ticket.decide.${proposal.id}`);
    await press(cashier, 'repair.proposal.agreed');
    await press(cashier, 'repair.proposal.primary');
    const ticket = await ticketRow(h, ticketId);
    expect(ticket.quoteTotal).toBe(750_000 + 150_000);
    expect(ticket.pendingProposals).toBe(0);
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
    expect(screen.query('repair.ticket.handoverPhotos')).not.toBeNull();
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

  test('a user without repair access sees the unauthorized state, not an empty board', async () => {
    h = await openRepairScreenHarness(5402);
    await openTicket(h);
    const screen = await mount(h, h.zeroUserId);
    expect(screen.query('repair.board.items.unauthorized')).not.toBeNull();
    expect(screen.query('repair.board.newIntake')).toBeNull();
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
