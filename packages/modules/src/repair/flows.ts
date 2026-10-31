// Pure decisions behind the repair screens on every client (phone today, desktop next): which
// tickets a board view shows, what a user may do next on a ticket, and how an intake draft becomes
// an `openTicket` input. Platform-free so each client reuses them and each rule is tested directly.
import type { MediaRef, MediaRefMime, ThumbnailRef, VideoMime } from '@bolusi/schemas';
import { zMediaRef, zVideoRef } from '@bolusi/schemas';
import { z } from 'zod';

import { INVENTORY_PERMISSION } from '../inventory/constants.js';
import type { PartUse } from '../inventory/part-use.js';
import { CASH_ACCOUNT, MONEY_PERMISSION } from '../money/constants.js';
import { chosenMethod, referenceMissing } from '../money/payment-entry.js';
import type { PaymentAccountRow } from '../money/queries.js';
import type { ApprovalRow } from '../approvals/queries.js';
import type { MoneyTarget } from '../money/refund.js';
import type { VideoMediaRef } from '../screen-kit/media.js';
import type { CorrectTicketDetailsInput, OpenTicketInput } from './commands.js';
import { imeiInvalid, phoneInvalid } from './contact.js';
import { REPAIR_DOCUMENT_KIND } from './money-document.js';
import type { RepairKey } from './i18n.js';
import {
  CHECKLIST_STATES,
  IN_PROGRESS_OUTCOMES,
  MAX_LINE_AMOUNT,
  QUOTE_LINE_KINDS,
  REPAIR_PERMISSION,
  isOwnershipVideoSlot,
  workPhotoStage,
  type ChecklistState,
  type QuoteLineKind,
  type RepairOutcome,
  type SlipKind,
  type WorkPhotoStage,
  HANDOVER_UNDO_WINDOW_MS,
} from './constants.js';
import {
  readyDays,
  warrantyUntil,
  type IntakeOption,
  type IntakeOptionLists,
} from './intake-options.js';
import { SCREEN_LOCK_KINDS, decodeScreenLock, encodeScreenLock } from './screen-lock.js';
import type {
  ListTicketsInput,
  QuoteLineRow,
  TicketDetailRow,
  TicketPhotoRow,
  TicketSummaryRow,
} from './queries.js';

// ── board ─────────────────────────────────────────────────────────────────────────────────────

export const BOARD_VIEWS = [
  'approvals',
  'active',
  'mine',
  'unassigned',
  'pickup',
  'uncollected',
  'returned',
  'cancelled',
] as const;
export type BoardView = (typeof BOARD_VIEWS)[number];

/** What an empty view says: what is not there, never a generic "no data". */
export const BOARD_EMPTY_KEY = {
  approvals: 'repair.board.empty.approvals',
  active: 'repair.board.empty.active',
  mine: 'repair.board.empty.mine',
  unassigned: 'repair.board.empty.unassigned',
  pickup: 'repair.board.empty.pickup',
  uncollected: 'repair.board.empty.uncollected',
  returned: 'repair.board.empty.returned',
  cancelled: 'repair.board.empty.cancelled',
} as const satisfies Record<BoardView, RepairKey>;

/**
 * The views this user gets: every cancel, with who and what it charged, is for owners only; phones
 * nobody collected are for the counter and owners, who call the customer. Servisan with requests
 * this user can approve lead while there are any (`waitingApprovals`).
 */
export function boardViews(can: RepairAbilities, waitingApprovals = 0): readonly BoardView[] {
  return BOARD_VIEWS.filter((view) => {
    if (view === 'approvals') return waitingApprovals > 0;
    if (view === 'cancelled') return can.cancel;
    if (view === 'uncollected') return flagsUncollected(can);
    return true;
  });
}

/**
 * The cancelled view lists the latest cancel first, phones not collected the longest waiting
 * first; every queue lists the newest ticket first.
 */
export function boardSort(view: BoardView): ListTicketsInput['sort'] {
  if (view === 'cancelled') return 'cancelledAt.desc';
  if (view === 'uncollected') return 'readyAt.asc';
  return 'createdAt.desc';
}

const IN_PROGRESS = IN_PROGRESS_OUTCOMES;
const DAY_MS = 86_400_000;
/** How often an open screen re-reads which phones are not collected, as days pass with no change. */
export const UNCOLLECTED_REFRESH_MS = 3_600_000;

/** Phones nobody collected are flagged to the counter and owners, who call the customer. */
export function flagsUncollected(can: Pick<RepairAbilities, 'intake' | 'cancel'>): boolean {
  return can.intake || can.cancel;
}

/** Phones ready to collect before this time are not collected: `days` (the store's) before `now`. */
export function uncollectedBefore(days: number, now: number): number {
  return now - days * DAY_MS;
}

/**
 * Whole days a finished phone has waited in the store, when it has waited at least the store's
 * `days`; null when it is not flagged (still worked on, back with its owner, or not long enough).
 */
export function uncollectedDays(
  ticket: Pick<TicketSummaryRow, 'location' | 'readyAt'>,
  days: number,
  now: number,
): number | null {
  if (ticket.location !== 'in_store' || ticket.readyAt === null) return null;
  if (ticket.readyAt >= uncollectedBefore(days, now)) return null;
  return Math.floor((now - ticket.readyAt) / DAY_MS);
}

/** The most servisan the approvals view lists at once (`listTickets` takes up to 100 ids). */
export const APPROVALS_VIEW_MAX = 100;

/**
 * The `listTickets` filter behind each board view. `readyBefore` is the not-collected cut-off
 * (`uncollectedBefore`), and `approvalIds` the servisan waiting on this user's approval; each is
 * read by its own view only. The approvals view is offered only while it has some.
 */
export function boardFilter(
  view: BoardView,
  userId: string,
  readyBefore: number,
  approvalIds: readonly string[] = [],
): ListTicketsInput['filter'] {
  switch (view) {
    case 'approvals':
      return { ids: approvalIds.slice(0, APPROVALS_VIEW_MAX) };
    case 'active':
      return { outcomes: [...IN_PROGRESS], location: 'in_store' };
    case 'mine':
      return { outcomes: [...IN_PROGRESS], location: 'in_store', technicianId: userId };
    case 'unassigned':
      return { outcomes: [...IN_PROGRESS], location: 'in_store', unassigned: true };
    case 'pickup':
      return { outcomes: ['repaired', 'cancelled'], location: 'in_store' };
    case 'uncollected':
      return { outcomes: ['repaired', 'cancelled'], location: 'in_store', readyBefore };
    case 'returned':
      return { location: 'returned' };
    case 'cancelled':
      return { outcomes: ['cancelled'] };
  }
}

/** Technicians start on their own queue; everyone else on all active repairs. */
export function defaultBoardView(can: RepairAbilities): BoardView {
  return can.work && !can.intake ? 'mine' : 'active';
}

// ── status ────────────────────────────────────────────────────────────────────────────────────

/** One label for where a ticket stands: the outcome, or "returned" once the device is back. */
export type TicketStatus = RepairOutcome | 'returned';

export function ticketStatus(ticket: Pick<TicketSummaryRow, 'outcome' | 'location'>): TicketStatus {
  return ticket.location === 'returned' ? 'returned' : ticket.outcome;
}

export function statusTone(status: TicketStatus): 'neutral' | 'warning' | 'danger' | 'success' {
  switch (status) {
    case 'waiting_for_parts':
      return 'warning';
    case 'cancelled':
      return 'danger';
    case 'repaired':
    case 'returned':
      return 'success';
    case 'received':
    case 'in_repair':
      return 'neutral';
  }
}

// ── what a user may do next ─────────────────────────────────────────────────────────────────

/** The repair permissions a screen shows actions for. Commands still enforce them. */
export interface RepairAbilities {
  readonly read: boolean;
  readonly intake: boolean;
  readonly work: boolean;
  readonly assign: boolean;
  readonly quoteChange: boolean;
  readonly cancel: boolean;
  /** Lower a price (owners). */
  readonly discount: boolean;
  readonly handover: boolean;
  /** Edit the franchise's intake lists (tenant-wide). */
  readonly manageIntakeOptions: boolean;
  /** Hide intake list items at this store. */
  readonly hideIntakeOptions: boolean;
  /** Set this store's cancellation fees. */
  readonly setCancelFees: boolean;
  /** Change or remove a down payment already recorded (owners). */
  readonly correctDownPayment: boolean;
  /** Edit what this store's slips print. */
  readonly setPrintSettings: boolean;
  /** Set after how many days a phone nobody collected is flagged here. */
  readonly setUncollectedDays: boolean;
  /** Open a warranty claim after the warranty ended, or charge for one (owners). */
  readonly warrantyException: boolean;
}

export function repairAbilities(hasPermission: (id: string) => boolean): RepairAbilities {
  const P = REPAIR_PERMISSION;
  return {
    read: hasPermission(P.read),
    intake: hasPermission(P.intake),
    work: hasPermission(P.work),
    assign: hasPermission(P.assign),
    quoteChange: hasPermission(P.quoteChange),
    cancel: hasPermission(P.cancel),
    discount: hasPermission(P.discount),
    handover: hasPermission(P.handover),
    manageIntakeOptions: hasPermission(P.manageIntakeOptions),
    hideIntakeOptions: hasPermission(P.hideIntakeOptions),
    setCancelFees: hasPermission(P.setCancelFees),
    correctDownPayment: hasPermission(P.correctDownPayment),
    setPrintSettings: hasPermission(P.setPrintSettings),
    setUncollectedDays: hasPermission(P.setUncollectedDays),
    warrantyException: hasPermission(P.warrantyException),
  };
}

/** A servisan parts are drawn for: being worked on or waiting for a part, and still in the store. */
export function partsInWork(ticket: {
  readonly outcome: string;
  readonly location: string;
}): boolean {
  return (
    (ticket.outcome === 'in_repair' || ticket.outcome === 'waiting_for_parts') &&
    ticket.location === 'in_store'
  );
}

/**
 * Whether this user may take or put back parts on the ticket now: the client side of repair's
 * part-use rule (part-use.ts), for showing the actions. The rule decides again on save. Owners may
 * correct any ticket past intake, so they see the actions on finished and cancelled ones too.
 */
export function canUseParts(
  ticket: Pick<TicketSummaryRow, 'outcome' | 'location' | 'technicianId'>,
  userId: string,
  hasPermission: (id: string) => boolean,
): boolean {
  if (!hasPermission(INVENTORY_PERMISSION.useParts) || ticket.outcome === 'received') return false;
  if (hasPermission(INVENTORY_PERMISSION.correctUse)) return true;
  if (!partsInWork(ticket)) return false;
  return ticket.technicianId === userId || hasPermission(REPAIR_PERMISSION.assign);
}

/** The servisan as stock records it: parts taken for it carry its number. */
export function partUse(ticket: Pick<TicketSummaryRow, 'id' | 'ticketNumber'>): PartUse {
  return { kind: 'repair_ticket', id: ticket.id, label: ticket.ticketNumber };
}

export type TicketAction =
  | 'decidePrice'
  | 'claim'
  | 'start'
  | 'resume'
  | 'reopen'
  | 'waitForParts'
  | 'markRepaired'
  | 'assign'
  | 'changePrice'
  | 'proposePrice'
  | 'handover'
  | 'correctDetails'
  | 'undoHandover'
  | 'cancel';

/**
 * The actions to offer, most likely next step first. Mirrors the command guards (commands.ts) so a
 * button never leads to a refusal the user could have been spared; the command stays the authority.
 */
export function ticketActions(
  ticket: Pick<
    TicketDetailRow,
    'outcome' | 'location' | 'technicianId' | 'pendingProposals' | 'returnedAt'
  >,
  can: RepairAbilities,
  userId: string,
  now: number = Date.now(),
): TicketAction[] {
  const actions: TicketAction[] = [];
  const open = ticket.location === 'in_store' && ticket.outcome !== 'cancelled';
  const finished = ticket.outcome === 'repaired' || ticket.outcome === 'cancelled';

  // Mirrors returnDevice: undecided proposals hold back a repaired phone, not a cancelled one.
  // A technician's proposal waits on the counter, and on a repaired phone it holds up the handover.
  if (open && can.quoteChange && ticket.pendingProposals > 0) actions.push('decidePrice');
  const priceSettled = ticket.outcome === 'cancelled' || ticket.pendingProposals === 0;
  if (can.handover && ticket.location === 'in_store' && finished && priceSettled) {
    actions.push('handover');
  }
  if (open && can.work) {
    if (ticket.outcome === 'in_repair') actions.push('markRepaired');
    if (ticket.outcome === 'received') actions.push('start');
    if (ticket.outcome === 'waiting_for_parts') actions.push('resume');
    if (ticket.outcome === 'received' || ticket.outcome === 'in_repair') {
      actions.push('waitForParts');
    }
    // claimTicket would also take a repaired phone, but there is no work left to take over; only a
    // reopen brings it back to a technician, so the board does not offer it.
    if (ticket.technicianId !== userId && ticket.outcome !== 'repaired') actions.push('claim');
  }
  // An unassigned repair waits on the counter to pick a technician, so that comes before pricing.
  const assignFirst = ticket.technicianId === null;
  if (open && can.assign && assignFirst) actions.push('assign');
  if (open && can.quoteChange) actions.push('changePrice');
  else if (open && can.work) actions.push('proposePrice');
  if (open && can.assign && !assignFirst) actions.push('assign');
  if (open && can.work && ticket.outcome === 'repaired') actions.push('reopen');
  // What intake wrote down is put right while the phone is here; after pickup the signed slip is
  // the record. Taking a handover back is an owner's call, like cancelling.
  if (ticket.location === 'in_store' && can.intake) actions.push('correctDetails');
  // A handover taken back was charged: it goes home again, never cancelled. Taking one back is for
  // a day after the first handover only. The counter, who cannot cancel, asks an owner to (an
  // approval request).
  if (open && (can.cancel || can.intake) && ticket.returnedAt === null) actions.push('cancel');
  if (ticket.location === 'returned' && can.cancel && undoableHandover(ticket, now)) {
    actions.push('undoHandover');
  }
  return actions;
}

/** The actions kept apart at the end of a servisan, below everything: final, or taking one back. */
/** Mirrors the handover-undo rule's window, counted from the first handover. */
export function undoableHandover(
  ticket: Pick<TicketDetailRow, 'returnedAt'>,
  now: number,
): boolean {
  return ticket.returnedAt !== null && now - ticket.returnedAt <= HANDOVER_UNDO_WINDOW_MS;
}

export const FINAL_ACTIONS: ReadonlySet<TicketAction> = new Set(['cancel', 'undoHandover']);

/** Actions that change one fact, offered beside it (the technician, the price), never in a row. */
export const CONTEXTUAL_ACTIONS: ReadonlySet<TicketAction> = new Set([
  'assign',
  'changePrice',
  'proposePrice',
  'correctDetails',
]);

/**
 * The offered actions laid out by what this user does next, not as a row of every status change:
 * one next step, at most one real alternative to it, and the rarer moves kept under "Lainnya".
 * Cancelling is not here: it is final, so screens keep it apart at the end.
 */
export interface TicketActionLayout {
  readonly next: TicketAction | null;
  readonly alternative: TicketAction | null;
  readonly more: readonly TicketAction[];
}

/** The steps that move a repair forward, likeliest first. */
const FORWARD: readonly TicketAction[] = [
  'decidePrice',
  'handover',
  'markRepaired',
  'start',
  'resume',
];
/** Bench work: offered only on a repair that is this user's or nobody's yet. */
const BENCH_WORK: ReadonlySet<TicketAction> = new Set([
  'start',
  'resume',
  'markRepaired',
  'waitForParts',
]);

export function arrangeTicketActions(
  actions: readonly TicketAction[],
  ticket: Pick<TicketSummaryRow, 'outcome' | 'technicianId'>,
  userId: string,
): TicketActionLayout {
  // Someone else's repair is theirs to work on; this user first takes it over ("Ambil alih").
  const mine = ticket.technicianId === null || ticket.technicianId === userId;
  const offered = actions.filter(
    (action) =>
      !FINAL_ACTIONS.has(action) &&
      !CONTEXTUAL_ACTIONS.has(action) &&
      (mine || !BENCH_WORK.has(action)),
  );
  const forward = FORWARD.filter((action) => offered.includes(action));
  // With nothing to push forward, picking a technician is what an unassigned repair waits on.
  const assignNext = ticket.technicianId === null && actions.includes('assign');
  const next = forward[0] ?? (assignNext ? 'assign' : null);
  // Parts running out is the one real fork while working; before work starts it is rare.
  const alternative =
    forward[1] ??
    (ticket.outcome === 'in_repair' && offered.includes('waitForParts') ? 'waitForParts' : null);
  return {
    next,
    alternative,
    more: offered.filter((action) => action !== next && action !== alternative),
  };
}

/**
 * What this user may do about the down payment, shown beside it. Mirrors the commands: anyone at
 * the counter records one while the servisan is open and none is recorded; only an owner
 * changes one already recorded, since a lower figure is how cash would go missing, and the counter
 * asks one to.
 */
export function downPaymentAction(
  ticket: Pick<TicketSummaryRow, 'location' | 'outcome' | 'downPayment'>,
  can: RepairAbilities,
): 'record' | 'correct' | null {
  // Once the phone is back with its owner the DP is part of the bill it paid, not a figure to edit.
  if (ticket.location === 'returned') return null;
  // The counter asks an owner to fix it (repair approval-kinds.ts).
  if (ticket.downPayment !== null) return can.correctDownPayment || can.intake ? 'correct' : null;
  const open = ticket.outcome !== 'cancelled';
  return can.intake && open ? 'record' : null;
}

/** The servisan as the money ledger names it, and whose money goes back. */
export function ticketMoneyTarget(
  ticket: Pick<TicketSummaryRow, 'id' | 'ticketNumber' | 'customerName'>,
): MoneyTarget {
  return {
    document: { kind: REPAIR_DOCUMENT_KIND, id: ticket.id, label: ticket.ticketNumber },
    customer: ticket.customerName,
  };
}

/**
 * What may be done with a servisan's money once the phone went home (refund.ts has the details):
 * give back an overpayment (the counter) or any of what was paid (an owner), and an owner lowers
 * what is still owed.
 */
export function ticketMoneyActions(
  ticket: Pick<
    TicketSummaryRow,
    'location' | 'outcome' | 'cancelFee' | 'quoteTotal' | 'reduced' | 'downPayment'
  >,
  hasPermission: (permission: string) => boolean,
): { readonly refund: boolean; readonly reduce: boolean } {
  if (ticket.location !== 'returned') return { refund: false, reduce: false };
  const owner = hasPermission(MONEY_PERMISSION.refund);
  const paid = ticket.downPayment ?? 0;
  const owed = amountOwed(ticket) - paid;
  // Money going back is the counter's command, so even an owner needs `receive` (manifest.ts).
  return {
    refund: hasPermission(MONEY_PERMISSION.receive) && ((owner && paid > 0) || owed < 0),
    reduce: owner && owed > 0,
  };
}

/**
 * Whether this user may change what is being repaired now. Mirrors the op's rule: the counter or a
 * technician, while the servisan is open (the warranty taken home must not change).
 */
export function canSetRepairTypes(
  ticket: Pick<TicketDetailRow, 'location' | 'outcome' | 'claimOfTicketId'>,
  can: Pick<RepairAbilities, 'intake' | 'work'>,
): boolean {
  return (
    ticket.location === 'in_store' &&
    ticket.outcome !== 'cancelled' &&
    ticket.claimOfTicketId === null &&
    (can.intake || can.work)
  );
}

/**
 * Whether the counter can open a warranty claim on this servisan now: `free` while its warranty
 * runs, `owner` once it ended (only an owner may still open one), null when it cannot be claimed
 * (still in the store, cancelled, itself a claim) or not by this user. Mirrors the claim rule.
 */
export function warrantyClaimAction(
  ticket: Pick<
    TicketDetailRow,
    'outcome' | 'location' | 'claimOfTicketId' | 'repairTypes' | 'returnedAt'
  >,
  can: Pick<RepairAbilities, 'intake' | 'warrantyException'>,
  now: number,
): 'free' | 'owner' | null {
  if (!can.intake || ticket.location !== 'returned' || ticket.outcome !== 'repaired') return null;
  if (ticket.claimOfTicketId !== null) return null;
  const until = warrantyUntil(ticket.repairTypes, ticket.returnedAt);
  if (until !== null && now <= until) return 'free';
  return can.warrantyException ? 'owner' : null;
}

/**
 * A warranty claim's intake, started from the servisan it claims on: the same customer and phone,
 * and a free line for the repair. The counter still records the complaint, checks and photos,
 * since the phone comes back in whatever state it is in now.
 */
export function claimIntakeDraft(ticket: TicketDetailRow, lineDescription: string): IntakeDraft {
  return {
    ...emptyIntakeDraft(),
    customer: {
      kind: 'existing',
      customerId: ticket.customerId,
      name: ticket.customerName,
      phone: ticket.customerPhone,
    },
    device: {
      brand: ticket.deviceBrand,
      model: ticket.deviceModel,
      color: ticket.deviceColor,
      imei: ticket.deviceImei ?? '',
      lockKind: 'none',
      passcode: '',
    },
    lines: [{ kind: 'labour', description: lineDescription, amount: 0 }],
    claimOf: {
      ticketId: ticket.id,
      ticketNumber: ticket.ticketNumber,
      warrantyUntil: warrantyUntil(ticket.repairTypes, ticket.returnedAt),
      imei: (ticket.deviceImei ?? '').trim(),
    },
  };
}

// ── correcting what intake wrote down ───────────────────────────────────────────────────────

/** The correction form, filled with the servisan as saved: intake's own fields, edited in place. */
export function correctionDraft(ticket: TicketDetailRow): IntakeDraft {
  const lock = ticket.devicePasscode === null ? null : decodeScreenLock(ticket.devicePasscode);
  return {
    ...emptyIntakeDraft(),
    customer: { kind: 'new', name: ticket.customerName, phone: ticket.customerPhone ?? '' },
    device: {
      brand: ticket.deviceBrand,
      model: ticket.deviceModel,
      color: ticket.deviceColor,
      imei: ticket.deviceImei ?? '',
      // A lock saved before lock kinds is plain text: shown as a password, so it stays readable.
      lockKind: lock === null ? 'none' : lock.kind === 'unknown' ? 'password' : lock.kind,
      passcode: lock?.value ?? '',
    },
    complaint: ticket.complaint,
    peripherals: ticket.peripherals.map((option) => option.item),
    claimOf:
      ticket.claimOfTicketId === null
        ? null
        : {
            ticketId: ticket.claimOfTicketId,
            ticketNumber: '',
            warrantyUntil: null,
            // A claim stays on the claimed phone: its IMEI is not one to correct here.
            imei: ticket.deviceImei ?? '',
          },
  };
}

/** What still blocks a correction: intake's own checks on the customer, the phone and the complaint. */
export function correctionProblems(
  draft: IntakeDraft,
  options: IntakeOptionLists,
): IntakeProblem[] {
  return (['customer', 'device', 'condition'] as const).flatMap((step) =>
    stepProblems(draft, step, options),
  );
}

/**
 * The store's lists for a correction: an accessory recorded on this servisan that the store no
 * longer offers stays on offer, with the label it was recorded with, so it can still be unticked.
 */
export function correctionOptions(
  options: IntakeOptionLists,
  ticket: Pick<TicketDetailRow, 'peripherals'>,
): IntakeOptionLists {
  const offered = new Set(options.accessories.map((option) => option.id));
  const gone = ticket.peripherals
    .filter((option) => !offered.has(option.item))
    .map((option) => ({ id: option.item, label: option.label }));
  return { ...options, accessories: [...options.accessories, ...gone] };
}

/**
 * The `correctTicketDetails` input for a correction with no problems, against the lists from
 * `correctionOptions`. The command sends on only what differs.
 */
export function toCorrectionInput(
  ticket: TicketDetailRow,
  draft: IntakeDraft,
  options: IntakeOptionLists,
  reason: string,
): CorrectTicketDetailsInput {
  const { lockKind, passcode: typed } = draft.device;
  const passcode =
    lockKind === 'none' || typed === '' ? null : encodeScreenLock({ kind: lockKind, value: typed });
  // A lock saved as plain text before lock kinds is unchanged when its text is.
  const sameLock =
    passcode === ticket.devicePasscode ||
    (ticket.devicePasscode !== null &&
      decodeScreenLock(ticket.devicePasscode).kind === 'unknown' &&
      typed === ticket.devicePasscode);
  return {
    ticketId: ticket.id,
    customer:
      draft.customer.kind === 'existing'
        ? { customerId: draft.customer.customerId }
        : { name: draft.customer.name.trim(), phone: draft.customer.phone.trim() || null },
    device: {
      brand: draft.device.brand.trim(),
      model: draft.device.model.trim(),
      color: draft.device.color.trim(),
      imei: draft.device.imei.trim() || null,
    },
    ...(sameLock ? {} : { passcode }),
    complaint: draft.complaint.trim(),
    // One already recorded keeps its recorded label, so a renamed list entry is not a change.
    peripherals: chosenAccessories(draft, options.accessories).map(({ id, label }) => ({
      item: id,
      label: ticket.peripherals.find((option) => option.item === id)?.label ?? label,
    })),
    reason: reason.trim(),
  };
}

/**
 * Whether a claim's warranty has ended by now, so only an owner can open it. Judged when shown, not
 * when the intake started: an intake kept overnight may have outlived the warranty.
 */
export function claimWarrantyEnded(
  claimOf: NonNullable<IntakeDraft['claimOf']>,
  now: number,
): boolean {
  return claimOf.warrantyUntil === null || now > claimOf.warrantyUntil;
}

/** Why an open repair type step can no longer finish. */
export function repairTypesStale(
  ticket: Pick<TicketDetailRow, 'location' | 'outcome' | 'claimOfTicketId'>,
  can: Pick<RepairAbilities, 'intake' | 'work'>,
): StaleStep | null {
  if (canSetRepairTypes(ticket, can)) return null;
  if (ticket.location === 'returned') return { kind: 'returned' };
  return { kind: ticket.outcome === 'cancelled' ? 'cancelled' : 'changed' };
}

/**
 * What the customer owes: the cancellation fee on a cancelled servisan, else the agreed total, less
 * what an owner took off it once charged.
 */
export function amountOwed(
  row: Pick<TicketSummaryRow, 'outcome' | 'cancelFee' | 'quoteTotal' | 'reduced'>,
): number {
  return (row.outcome === 'cancelled' ? (row.cancelFee ?? 0) : row.quoteTotal) - row.reduced;
}

/** What is left to pay on the bill, or what goes back, given what was paid so far. */
export function ticketBalance(
  ticket: Pick<
    TicketSummaryRow,
    'outcome' | 'cancelFee' | 'quoteTotal' | 'reduced' | 'downPayment'
  >,
): { readonly kind: 'due' | 'refund'; readonly amount: number } {
  return balanceAfterDownPayment(amountOwed(ticket), ticket.downPayment ?? 0);
}

/**
 * What the last money row under a total is called: what is left to pay, or what goes back. Before
 * pickup an overpaid DP goes back at the handover ("Kembalikan"); refunds a handover paid out are
 * already off what was paid, so money left to give back on a phone that went home is still owed
 * ("Lebih bayar"), never done.
 */
export function balanceLabelKey(kind: 'due' | 'refund', returned: boolean): RepairKey {
  if (kind === 'due') return 'repair.price.balance';
  return returned ? 'repair.price.owedBack' : 'repair.price.refundDue';
}

/**
 * What the money already paid on a servisan is called: its DP while the phone is in the store,
 * what was paid in all (DP and the rest) once it went home.
 */
/**
 * What marking a servisan repaired says: ready for the customer, or, while a price change still
 * waits for them, that it needs their answer first.
 */
export function repairedDoneKey(
  ticket: Pick<TicketSummaryRow, 'pendingProposals'> | undefined,
): RepairKey {
  return ticket !== undefined && ticket.pendingProposals > 0
    ? 'repair.done.repairedPriceWaiting'
    : 'repair.done.repaired';
}

export function paidLabelKey(ticket: Pick<TicketSummaryRow, 'location'>): RepairKey {
  return ticket.location === 'returned' ? 'repair.price.paid' : 'repair.price.downPayment';
}

/** Why an open down payment step can no longer finish: what it would do is no longer offered. */
export function downPaymentStale(
  ticket: Pick<TicketSummaryRow, 'location' | 'outcome' | 'downPayment'>,
  can: RepairAbilities,
  mode: 'record' | 'correct',
): StaleStep | null {
  if (downPaymentAction(ticket, can) === mode) return null;
  return { kind: ticket.location === 'returned' ? 'returned' : 'changed' };
}

/** What still stands between a typed down payment and saving it; null when it can be saved. */
export type DownPaymentGap =
  'aboveTotal' | 'amount' | 'reference' | 'correctAmount' | 'same' | 'reason';

/**
 * A down payment being recorded or corrected, as typed. A new one is at least Rp 1; a correction
 * may bring it to nothing (removing it) but must change it and say why. Never above the total.
 */
export function downPaymentEntry(input: {
  readonly mode: 'record' | 'correct';
  /** The typed amount; null when nothing is typed. */
  readonly typed: number | null;
  readonly reason: string;
  readonly current: number | null;
  readonly total: number;
  /** A new DP's method still lacks the reference it takes (an EDC's approval code). */
  readonly referenceMissing?: boolean;
}): {
  readonly amount: number | null;
  readonly aboveTotal: boolean;
  readonly gap: DownPaymentGap | null;
} {
  const correcting = input.mode === 'correct';
  const amount = input.typed ?? (correcting ? null : 0);
  const aboveTotal = amount !== null && input.total > 0 && amount > input.total;
  const gap: DownPaymentGap | null = aboveTotal
    ? 'aboveTotal'
    : !correcting
      ? amount === null || amount <= 0
        ? 'amount'
        : input.referenceMissing === true
          ? 'reference'
          : null
      : amount === null
        ? 'correctAmount'
        : amount === input.current
          ? 'same'
          : input.reason.trim() === ''
            ? 'reason'
            : amount > 0 && input.referenceMissing === true
              ? 'reference'
              : null;
  return { amount, aboveTotal, gap };
}

/** The slips a ticket can print: the intake receipt always, the handover slip once it is ready. */
export function printableSlips(
  ticket: Pick<TicketSummaryRow, 'outcome' | 'location'>,
): readonly SlipKind[] {
  const ready =
    ticket.location === 'returned' ||
    ticket.outcome === 'repaired' ||
    ticket.outcome === 'cancelled';
  return ready ? ['intake', 'handover'] : ['intake'];
}

/**
 * What the customer still owes once a down payment is taken off the total, or what the store gives
 * back when the down payment was more (a cancelled servisan whose fee is below it).
 */
export function balanceAfterDownPayment(
  total: number,
  downPayment: number,
): { readonly kind: 'due' | 'refund'; readonly amount: number } {
  return downPayment > total
    ? { kind: 'refund', amount: downPayment - total }
    : { kind: 'due', amount: total - downPayment };
}

/** What a cancelled servisan's customer gets back at pickup: the DP above the fee, if any. */
export function cancelRefund(downPayment: number, fee: number | null): number {
  return fee === null ? 0 : Math.max(0, downPayment - fee);
}

// ── an open step after the ticket changed ────────────────────────────────────────────────────

/**
 * A step the ticket opens full screen, named by what it finishes. `before` starts (or resumes,
 * or reopens) the work; `after` marks it repaired; `proposal` decides one proposed line.
 */
export type TicketStep =
  | {
      readonly kind:
        | 'before'
        | 'after'
        | 'waitForParts'
        | 'cancel'
        | 'assign'
        | 'changePrice'
        | 'proposePrice'
        | 'handover'
        | 'correctDetails'
        | 'undoHandover';
    }
  | { readonly kind: 'proposal'; readonly lineId: string };

/** Why an open step can no longer finish, said in terms of what happened to the ticket. */
export type StaleStep =
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'returned' }
  | { readonly kind: 'proposalDecided'; readonly decision: 'applied' | 'declined' }
  | { readonly kind: 'proposalPending' }
  /** Anything else, such as another technician starting first or the ticket reopened. */
  | { readonly kind: 'changed' };

const STEP_ACTIONS: Readonly<Record<TicketStep['kind'], readonly TicketAction[]>> = {
  before: ['start', 'resume', 'reopen'],
  after: ['markRepaired'],
  waitForParts: ['waitForParts'],
  cancel: ['cancel'],
  assign: ['assign'],
  changePrice: ['changePrice'],
  proposePrice: ['proposePrice'],
  handover: ['handover'],
  correctDetails: ['correctDetails'],
  undoHandover: ['undoHandover'],
  proposal: ['decidePrice'],
};

/**
 * Whether an open step still leads somewhere, given the ticket as it reads now. A step stays open
 * while a colleague's change syncs in, so it is checked against the same rule that offered it
 * (`ticketActions`): `null` while it can still finish, otherwise what changed, so the step can say
 * so instead of letting the user fill it in for a refusal.
 */
export function staleStep(
  step: TicketStep,
  ticket: Pick<
    TicketDetailRow,
    'outcome' | 'location' | 'technicianId' | 'pendingProposals' | 'quoteLines' | 'returnedAt'
  >,
  can: RepairAbilities,
  userId: string,
  now: number = Date.now(),
): StaleStep | null {
  const actions = ticketActions(ticket, can, userId, now);
  const line =
    step.kind === 'proposal' ? ticket.quoteLines.find((row) => row.id === step.lineId) : undefined;
  const lineOpen = step.kind !== 'proposal' || line?.status === 'proposed';
  if (lineOpen && STEP_ACTIONS[step.kind].some((action) => actions.includes(action))) return null;

  if (ticket.location === 'returned' && step.kind !== 'undoHandover') return { kind: 'returned' };
  if (line !== undefined && (line.status === 'applied' || line.status === 'declined')) {
    return { kind: 'proposalDecided', decision: line.status };
  }
  if (ticket.outcome === 'cancelled') return { kind: 'cancelled' };
  if (step.kind === 'handover' && ticket.pendingProposals > 0) return { kind: 'proposalPending' };
  return { kind: 'changed' };
}

// ── photos ──────────────────────────────────────────────────────────────────────────────────

/** A stored photo as a verifiable thumbnail ref: its hash rode in the signed op (06 §6). */
export function photoThumbnailRef(photo: TicketPhotoRow): ThumbnailRef {
  return {
    kind: 'signed',
    mediaId: photo.mediaId,
    sha256: photo.mediaSha256,
    mime: photo.mediaMime as MediaRefMime,
  };
}

export function workPhotos(
  ticket: Pick<TicketDetailRow, 'photos'>,
  stage: WorkPhotoStage,
): TicketPhotoRow[] {
  return ticket.photos
    .filter((photo) => workPhotoStage(photo.slot) === stage)
    .sort((a, b) => a.capturedAt - b.capturedAt);
}

/** The ticket's ownership video: the latest clip taken, or null when there is none. */
export function ownershipVideoOf(ticket: Pick<TicketDetailRow, 'photos'>): TicketPhotoRow | null {
  return (
    ticket.photos
      .filter((photo) => isOwnershipVideoSlot(photo.slot))
      .sort((a, b) => b.capturedAt - a.capturedAt)[0] ?? null
  );
}

export function videoRefOf(photo: TicketPhotoRow): VideoMediaRef {
  return { mediaId: photo.mediaId, sha256: photo.mediaSha256, mime: photo.mediaMime as VideoMime };
}

export function photoInSlot(
  ticket: Pick<TicketDetailRow, 'photos'>,
  slot: string,
): TicketPhotoRow | null {
  return ticket.photos.find((photo) => photo.slot === slot) ?? null;
}

/** A just-captured photo shown before its command runs; the ref carries the signed hash already. */
export function capturedThumbnailRef(ref: MediaRef): ThumbnailRef {
  return { kind: 'signed', mediaId: ref.mediaId, sha256: ref.sha256, mime: ref.mime };
}

// ── money ───────────────────────────────────────────────────────────────────────────────────

/**
 * Whole rupiah from what was typed ("650.000", "Rp 650000"); null when there are no digits or the
 * amount is more than a line may carry.
 */
export function parseRupiah(text: string): number | null {
  const digits = text.replace(/\D/g, '');
  if (digits === '') return null;
  const value = Number(digits);
  return value <= MAX_LINE_AMOUNT ? value : null;
}

/** Whether a keystroke in an amount field should be kept: a too-long amount is not typed at all. */
export function acceptsRupiahText(text: string): boolean {
  return text.replace(/\D/g, '') === '' || parseRupiah(text) !== null;
}

/** Kinds offered when adding a price line. Adjustments (either sign) stay a back-office tool. */
export const PRICE_KINDS = [
  'part',
  'labour',
  'discount',
] as const satisfies readonly QuoteLineKind[];
export type PriceKind = (typeof PRICE_KINDS)[number];

/** The kinds a user may add: a discount lowers the price, so only those who may discount see it. */
export function priceKinds(discount: boolean): readonly PriceKind[] {
  return PRICE_KINDS.filter((kind) => kind !== 'discount' || discount);
}

/**
 * Whether a discount or a cancel goes to an owner instead: this user may not do it at all, or it
 * is beyond their limit (`limit` as `ModulePort.limitOf` gives it, null when not limited).
 */
export function asksApproval(holds: boolean, limit: number | null, amount: number): boolean {
  return !holds || (limit !== null && amount > limit);
}

/**
 * What the discounts still standing on a servisan take off (all but declined ones): a discount
 * limit is per servisan, so they count with the next one (repair rules, `discountsStanding`).
 */
export function discountsStanding(
  lines: readonly Pick<QuoteLineRow, 'amount' | 'status'>[],
): number {
  return lines.reduce(
    (sum, line) => (line.amount < 0 && line.status !== 'declined' ? sum - line.amount : sum),
    0,
  );
}

/** Why it is asked: the user may not do it, or it is beyond their limit. */
export function askedBecauseKey(holds: boolean): RepairKey {
  return holds ? 'repair.approval.overLimit' : 'repair.approval.needsApproval';
}

/**
 * Whether the counter may let the phone go unpaid now ("Bayar nanti"), and if not, where asking
 * stands. `requests` are the servisan's Bayar nanti requests, newest first.
 * - `own`: they may, within their limit;
 * - `permitted`: an owner approved it for at least what is due (`by` names them);
 * - `waiting`: they asked, and the answer has not come;
 * - `ask`: they may ask (`rejected` is the last answer when it was no);
 * - `none`: they can neither do it nor ask.
 */
export type PayLaterAccess =
  | { readonly kind: 'own' }
  | { readonly kind: 'permitted'; readonly by: string | null }
  | { readonly kind: 'waiting' }
  | { readonly kind: 'ask'; readonly because: RepairKey; readonly rejected: ApprovalRow | null }
  | { readonly kind: 'none' };

export function payLaterAccess(args: {
  readonly holds: boolean;
  readonly limit: number | null;
  readonly canAsk: boolean;
  readonly due: number;
  readonly requests: readonly ApprovalRow[];
}): PayLaterAccess {
  const { holds, limit, canAsk, due, requests } = args;
  const permit = requests.find((row) => row.status === 'approved' && row.amount >= due);
  if (permit !== undefined) return { kind: 'permitted', by: permit.decidedByName };
  if (!asksApproval(holds, limit, due)) return { kind: 'own' };
  if (!canAsk) return { kind: 'none' };
  if (requests.some((row) => row.status === 'waiting')) return { kind: 'waiting' };
  const last = requests[0];
  return {
    kind: 'ask',
    because: askedBecauseKey(holds),
    rejected: last?.status === 'rejected' ? last : null,
  };
}

/**
 * What a phone field keeps of what was typed or pasted: digits, spaces and dashes, and a "+" only
 * at the start. Android's phone keypad also offers ". , ( ) * # N /", which no number here needs.
 */
export function phoneText(text: string): string {
  return text.replace(/[^\d\s+-]/g, '').replace(/(?!^)\+/g, '');
}

/** The signed amount a line contributes: discounts subtract. Adjustments are entered signed. */
export function signedAmount(kind: QuoteLineKind, amount: number): number {
  return kind === 'discount' ? -Math.abs(amount) : amount;
}

// ── intake ──────────────────────────────────────────────────────────────────────────────────
//
// Every list the counter picks from (checks, accessories, photo angles, brands, ready-by) is the
// store's current `IntakeOptionLists` (intake-options.ts), handed in by the screen. The draft keys
// its answers by option id, so a list that syncs in mid-intake keeps whatever still applies.

/**
 * End of the store day (17:00 device time) for a ready-by choice, or null when not known yet.
 * `ready` is a ready-by option id: its number of days.
 */
export function readyAtFor(ready: string, now: number): number | null {
  const days = readyDays(ready);
  if (days === null) return null;
  const date = new Date(now);
  date.setDate(date.getDate() + days);
  date.setHours(17, 0, 0, 0);
  // "Today" taken in after five still has to be later than now: a couple of hours, on the hour.
  if (date.getTime() <= now) {
    date.setTime(now);
    date.setHours(date.getHours() + 2, 0, 0, 0);
  }
  return date.getTime();
}

const zLineDraft = z.strictObject({
  kind: z.enum(QUOTE_LINE_KINDS),
  description: z.string(),
  amount: z.number().int(),
});

/** The ready-by answers drafts held before the choices were editable, as their option ids. */
const LEGACY_READY: Readonly<Record<string, string>> = {
  today: '0',
  tomorrow: '1',
  threeDays: '3',
};

/**
 * An intake in progress. Kept across an idle lock like a notes draft (SEC-AUTH-08), so the shape is
 * parsed on restore rather than trusted; a value that does not parse restores nothing.
 */
const zIntakeDraft = z.strictObject({
  kind: z.literal('intake'),
  step: z.number().int().min(0),
  customer: z.union([
    z.strictObject({
      kind: z.literal('existing'),
      customerId: z.string(),
      name: z.string(),
      phone: z.string().nullable(),
    }),
    z.strictObject({ kind: z.literal('new'), name: z.string(), phone: z.string() }),
  ]),
  device: z
    .strictObject({
      brand: z.string(),
      model: z.string(),
      color: z.string(),
      imei: z.string(),
      /** How the phone is locked; `passcode` holds the PIN, password or pattern (screen-lock.ts). */
      lockKind: z.enum(['none', ...SCREEN_LOCK_KINDS]).optional(),
      passcode: z.string(),
    })
    // A draft saved before lock kinds kept a typed passcode only.
    .transform(({ lockKind, ...device }) => ({
      ...device,
      lockKind: lockKind ?? (device.passcode === '' ? ('none' as const) : ('password' as const)),
    })),
  complaint: z.string(),
  /** The repair type ids picked; a draft saved before repair types has none. */
  repairTypes: z.array(z.string()).default([]),
  intakeNotes: z.string(),
  checks: z.record(z.string(), z.enum(CHECKLIST_STATES)),
  peripherals: z.array(z.string()),
  /** Photo per angle id. */
  photos: z.record(z.string(), zMediaRef),
  /** The customer's ownership video, when a picked repair type asks for one. */
  ownershipVideo: zVideoRef.nullable().default(null),
  lines: z.array(zLineDraft),
  /** Rupiah the customer paid up front, as typed; '' when nothing was paid. */
  downPayment: z.string().default(''),
  /** How the DP came in: `cash` or `account:<id>`. */
  downPaymentAccount: z.string().default(CASH_ACCOUNT),
  /** The DP's reference, as an EDC's approval code; '' when none. */
  downPaymentReference: z.string().default(''),
  /** The ready-by option id picked, or '' while the store's default stands. */
  ready: z.string().transform((ready) => LEGACY_READY[ready] ?? ready),
  /** The id the ticket will get, taken when the intake starts so it can only be opened once. */
  ticketId: z.string().optional(),
  /** The servisan this intake is a warranty claim on; null for an ordinary intake. */
  claimOf: z
    .strictObject({
      ticketId: z.string(),
      ticketNumber: z.string(),
      /** When that servisan's warranty ends; null when it had none. */
      warrantyUntil: z.number().int().nullable(),
      /** The IMEI that servisan wrote down, fixed on the claim; '' when it had none. */
      imei: z.string().default(''),
    })
    .nullable()
    .default(null),
});

export type IntakeDraft = z.infer<typeof zIntakeDraft>;
export type QuoteLineDraft = z.infer<typeof zLineDraft>;

export function parseIntakeDraft(value: unknown): IntakeDraft | null {
  const parsed = zIntakeDraft.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * A handover in progress: what was ticked, paid, photographed and signed. Kept like an intake, so
 * a lock, a system font change (the screens remount) or Android recreating the app does not make
 * the counter take the customer's signature again.
 */
const zHandoverDraft = z.strictObject({
  kind: z.literal('handover'),
  ticketId: z.string(),
  photo: zMediaRef.nullable(),
  signature: zMediaRef.nullable(),
  note: z.string(),
  /** The checklist lines ticked, as `kind:item`. */
  ticked: z.array(z.string()),
  payment: z.strictObject({
    /** The payment lines as typed; null while the counter has not touched them. */
    lines: z
      .array(
        z.strictObject({
          key: z.string(),
          account: z.string(),
          amount: z.string(),
          tendered: z.string(),
          reference: z.string(),
        }),
      )
      .nullable(),
    payLater: z.boolean(),
    unpaidReason: z.string(),
  }),
});

export type HandoverDraft = z.infer<typeof zHandoverDraft>;

/** The repair work a user has in progress: one intake or one handover at a time. */
export type RepairDraft = IntakeDraft | HandoverDraft;

export function parseRepairDraft(value: unknown): RepairDraft | null {
  const parsed = z.union([zIntakeDraft, zHandoverDraft]).safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function emptyIntakeDraft(): IntakeDraft {
  return {
    kind: 'intake',
    step: 0,
    customer: { kind: 'new', name: '', phone: '' },
    device: { brand: '', model: '', color: '', imei: '', lockKind: 'none', passcode: '' },
    complaint: '',
    repairTypes: [],
    intakeNotes: '',
    checks: {},
    peripherals: [],
    photos: {},
    ownershipVideo: null,
    lines: [],
    downPayment: '',
    downPaymentAccount: CASH_ACCOUNT,
    downPaymentReference: '',
    ready: '',
    claimOf: null,
  };
}

/** Whether the draft holds anything worth keeping or asking before discarding. */
export function intakeDirty(draft: IntakeDraft): boolean {
  const empty = emptyIntakeDraft();
  return JSON.stringify({ ...draft, step: 0, ticketId: undefined }) !== JSON.stringify(empty);
}

/**
 * The ready-by choice in force: the one picked if the store still offers it, otherwise the
 * store's default, "tomorrow" when offered (what the counter promised most before), else the first.
 */
export function chosenReady(
  draft: Pick<IntakeDraft, 'ready'>,
  readyBy: readonly IntakeOption[],
): string {
  if (readyBy.some((option) => option.id === draft.ready)) return draft.ready;
  return (readyBy.find((option) => option.id === '1') ?? readyBy[0])?.id ?? '';
}

export const INTAKE_STEPS = [
  'customer',
  'device',
  'condition',
  'photos',
  'price',
  'review',
] as const;
export type IntakeStep = (typeof INTAKE_STEPS)[number];

/** What still blocks a step, as the fields to point at. Empty means the step is complete. */
export type IntakeProblem =
  | 'customerName'
  | 'customerPhone'
  | 'deviceBrand'
  | 'deviceImei'
  | 'deviceModel'
  | 'screenLock'
  | 'complaint'
  | 'photos'
  | 'ownershipVideo'
  | 'quoteLines'
  | 'incompleteLine'
  | 'negativeTotal'
  | 'downPaymentAboveTotal'
  | 'downPaymentReference';

/** What each problem says, on the phone and on the PC. */
export const INTAKE_PROBLEM_KEY: Readonly<Record<IntakeProblem, RepairKey>> = {
  customerName: 'repair.problem.customerName',
  customerPhone: 'repair.problem.customerPhone',
  deviceBrand: 'repair.problem.deviceBrand',
  deviceModel: 'repair.problem.deviceModel',
  deviceImei: 'repair.problem.deviceImei',
  screenLock: 'repair.problem.screenLock',
  complaint: 'repair.problem.complaint',
  photos: 'repair.problem.photos',
  ownershipVideo: 'repair.problem.ownershipVideo',
  quoteLines: 'repair.problem.quoteLines',
  incompleteLine: 'repair.problem.incompleteLine',
  negativeTotal: 'repair.problem.negativeTotal',
  downPaymentAboveTotal: 'repair.problem.downPaymentAboveTotal',
  downPaymentReference: 'repair.problem.downPaymentReference',
};

export function stepProblems(
  draft: IntakeDraft,
  step: IntakeStep,
  options: IntakeOptionLists,
  /** The store's payment methods besides cash, for the DP's reference. */
  accounts: readonly PaymentAccountRow[] = [],
): IntakeProblem[] {
  const problems: IntakeProblem[] = [];
  switch (step) {
    case 'customer':
      if (draft.customer.kind === 'new' && draft.customer.name.trim() === '') {
        problems.push('customerName');
      }
      if (draft.customer.kind === 'new' && phoneInvalid(draft.customer.phone)) {
        problems.push('customerPhone');
      }
      break;
    case 'device':
      if (draft.device.brand.trim() === '') problems.push('deviceBrand');
      if (draft.device.model.trim() === '') problems.push('deviceModel');
      if (imeiInvalid(draft.device.imei)) problems.push('deviceImei');
      // A chosen lock with nothing entered (a pattern shorter than Android allows is kept as '')
      // would save as no lock; the counter picks "Tidak ada" for that.
      if (draft.device.lockKind !== 'none' && draft.device.passcode === '') {
        problems.push('screenLock');
      }
      break;
    case 'condition':
      if (draft.complaint.trim() === '') problems.push('complaint');
      break;
    case 'photos':
      if (nextMissingPhoto(draft, options.photoAngles) !== null) problems.push('photos');
      if (intakeNeedsVideo(draft, options) && draft.ownershipVideo === null) {
        problems.push('ownershipVideo');
      }
      break;
    case 'price':
      // An amount with no description would be dropped on save, so it is named, not lost.
      if (draft.lines.some((line) => line.description.trim() === '' && line.amount !== 0)) {
        problems.push('incompleteLine');
      }
      if (validLines(draft.lines).length === 0) problems.push('quoteLines');
      // Mirrors `openTicket`: discounts can bring the price to nothing, never below it.
      else if (intakeTotal(draft.lines) < 0) problems.push('negativeTotal');
      // Mirrors `openTicket`: more than a known price up front is change, not a payment. With no
      // price yet (to be checked first), any deposit stands.
      else if (
        intakeTotal(draft.lines) > 0 &&
        intakeDownPayment(draft) > intakeTotal(draft.lines)
      ) {
        problems.push('downPaymentAboveTotal');
      }
      if (
        intakeDownPayment(draft) > 0 &&
        referenceMissing(draft.downPaymentAccount, draft.downPaymentReference, accounts)
      ) {
        problems.push('downPaymentReference');
      }
      break;
    case 'review':
      for (const earlier of INTAKE_STEPS.slice(0, -1)) {
        problems.push(...stepProblems(draft, earlier, options, accounts));
      }
      break;
  }
  return problems;
}

function validLines(lines: readonly QuoteLineDraft[]): QuoteLineDraft[] {
  return lines.filter((line) => line.description.trim() !== '');
}

/** The first intake photo still missing, in the order the counter walks round the phone. */
export function nextMissingPhoto(
  draft: Pick<IntakeDraft, 'photos'>,
  angles: readonly IntakeOption[],
): IntakeOption | null {
  return angles.find((angle) => draft.photos[angle.id] === undefined) ?? null;
}

/** Whether a repair type picked for this intake asks for the customer's ownership video. */
export function intakeNeedsVideo(
  draft: Pick<IntakeDraft, 'repairTypes' | 'claimOf'>,
  options: Pick<IntakeOptionLists, 'repairTypes'>,
): boolean {
  return (
    draft.claimOf === null &&
    chosenRepairTypes(draft, options.repairTypes).some((type) => type.needsVideo === true)
  );
}

/** Every check not yet answered marked OK, after the counter has called out the ones with issues. */
export function restOfChecksOk(
  checks: IntakeDraft['checks'],
  offered: readonly IntakeOption[],
): IntakeDraft['checks'] {
  return {
    ...checks,
    ...Object.fromEntries(
      offered.map(({ id }) => [
        id,
        checks[id] === undefined || checks[id] === 'not_checked' ? 'ok' : checks[id],
      ]),
    ),
  };
}

/** The checks answered with an issue, in list order. */
export function checksWithIssue(
  draft: Pick<IntakeDraft, 'checks'>,
  offered: readonly IntakeOption[],
): IntakeOption[] {
  return offered.filter(({ id }) => draft.checks[id] === 'issue');
}

/** The accessories ticked, in list order (one the list no longer offers is left out). */
export function chosenAccessories(
  draft: Pick<IntakeDraft, 'peripherals'>,
  offered: readonly IntakeOption[],
): IntakeOption[] {
  return offered.filter(({ id }) => draft.peripherals.includes(id));
}

/** `items` with `item` added, or taken out when it is there: a chip toggled on or off. */
export function toggled(items: readonly string[], item: string): string[] {
  return items.includes(item) ? items.filter((i) => i !== item) : [...items, item];
}

/** The repair types picked, in list order (one the list no longer offers is left out). */
export function chosenRepairTypes(
  draft: Pick<IntakeDraft, 'repairTypes'>,
  offered: readonly IntakeOption[],
): IntakeOption[] {
  return offered.filter(({ id }) => draft.repairTypes.includes(id));
}

export function intakeTotal(lines: readonly QuoteLineDraft[]): number {
  return validLines(lines).reduce((sum, line) => sum + signedAmount(line.kind, line.amount), 0);
}

/**
 * The `openTicket` input for a complete draft, against the lists the counter was shown. Each
 * check, accessory and photo carries its label as shown, so the ticket keeps it. Call only when
 * `review` has no problems.
 */
/** The down payment typed at intake, 0 when none. */
export function intakeDownPayment(draft: Pick<IntakeDraft, 'downPayment'>): number {
  return parseRupiah(draft.downPayment) ?? 0;
}

export function toOpenTicketInput(
  draft: IntakeDraft,
  options: IntakeOptionLists,
  now: number,
  accounts: readonly PaymentAccountRow[] = [],
): OpenTicketInput {
  const downPayment = intakeDownPayment(draft);
  const method =
    downPayment > 0
      ? chosenMethod(draft.downPaymentAccount, draft.downPaymentReference, accounts)
      : { account: CASH_ACCOUNT, reference: null };
  const checklist = options.checks.flatMap(({ id, label }) => {
    const state: ChecklistState | undefined = draft.checks[id];
    return state === undefined ? [] : [{ item: id, label, state, note: '' }];
  });
  return {
    ...(draft.ticketId === undefined ? {} : { ticketId: draft.ticketId }),
    customer:
      draft.customer.kind === 'existing'
        ? { customerId: draft.customer.customerId }
        : { name: draft.customer.name.trim(), phone: draft.customer.phone.trim() || null },
    device: {
      brand: draft.device.brand.trim(),
      model: draft.device.model.trim(),
      color: draft.device.color.trim(),
      imei: (draft.claimOf?.imei || draft.device.imei).trim() || null,
      passcode:
        draft.device.lockKind === 'none' || draft.device.passcode === ''
          ? null
          : encodeScreenLock({ kind: draft.device.lockKind, value: draft.device.passcode }),
    },
    complaint: draft.complaint.trim(),
    // A claim repairs what its servisan did, so it carries that one's types, not its own.
    repairTypes:
      draft.claimOf === null
        ? chosenRepairTypes(draft, options.repairTypes).map(({ id }) => id)
        : [],
    claimOf: draft.claimOf?.ticketId ?? null,
    intakeNotes: draft.intakeNotes.trim(),
    checklist,
    peripherals: chosenAccessories(draft, options.accessories).map(({ id, label }) => ({
      item: id,
      label,
    })),
    estimatedReadyAt: readyAtFor(chosenReady(draft, options.readyBy), now),
    quoteLines: validLines(draft.lines).map((line) => ({
      kind: line.kind,
      description: line.description.trim(),
      amount: signedAmount(line.kind, line.amount),
    })),
    photos: options.photoAngles.map(({ id, label }) => ({
      slot: id,
      label,
      ref: draft.photos[id]!,
    })),
    // A clip taken for a type the counter then unpicked is not this servisan's.
    ownershipVideo: intakeNeedsVideo(draft, options) ? draft.ownershipVideo : null,
    downPayment,
    downPaymentAccount: method.account,
    downPaymentReference: method.reference,
  };
}
