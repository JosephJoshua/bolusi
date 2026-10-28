// Pure decisions behind the repair screens on every client (phone today, desktop next): which
// tickets a board view shows, what a user may do next on a ticket, and how an intake draft becomes
// an `openTicket` input. Platform-free so each client reuses them and each rule is tested directly.
import type { MediaRef, MediaRefMime, ThumbnailRef } from '@bolusi/schemas';
import { zMediaRef } from '@bolusi/schemas';
import { z } from 'zod';

import type { OpenTicketInput } from './commands.js';
import {
  CHECKLIST_STATES,
  IN_PROGRESS_OUTCOMES,
  MAX_LINE_AMOUNT,
  QUOTE_LINE_KINDS,
  REPAIR_PERMISSION,
  workPhotoStage,
  type ChecklistState,
  type QuoteLineKind,
  type RepairOutcome,
  type SlipKind,
  type WorkPhotoStage,
} from './constants.js';
import {
  readyDays,
  warrantyUntil,
  type IntakeOption,
  type IntakeOptionLists,
} from './intake-options.js';
import { SCREEN_LOCK_KINDS, encodeScreenLock } from './screen-lock.js';
import type {
  ListTicketsInput,
  TicketDetailRow,
  TicketPhotoRow,
  TicketSummaryRow,
} from './queries.js';

// ── board ─────────────────────────────────────────────────────────────────────────────────────

export const BOARD_VIEWS = [
  'active',
  'mine',
  'unassigned',
  'pickup',
  'uncollected',
  'returned',
  'cancelled',
] as const;
export type BoardView = (typeof BOARD_VIEWS)[number];

/**
 * The views this user gets: every cancel, with who and what it charged, is for owners only; phones
 * nobody collected are for the counter and owners, who call the customer.
 */
export function boardViews(can: RepairAbilities): readonly BoardView[] {
  return BOARD_VIEWS.filter((view) => {
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

/**
 * The `listTickets` filter behind each board view. `readyBefore` is the not-collected cut-off
 * (`uncollectedBefore`), which only that view reads.
 */
export function boardFilter(
  view: BoardView,
  userId: string,
  readyBefore: number,
): ListTicketsInput['filter'] {
  switch (view) {
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
  | 'cancel';

/**
 * The actions to offer, most likely next step first. Mirrors the command guards (commands.ts) so a
 * button never leads to a refusal the user could have been spared; the command stays the authority.
 */
export function ticketActions(
  ticket: Pick<TicketSummaryRow, 'outcome' | 'location' | 'technicianId' | 'pendingProposals'>,
  can: RepairAbilities,
  userId: string,
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
  if (open && can.cancel) actions.push('cancel');
  return actions;
}

/**
 * What this user may do about the down payment, shown beside it. Mirrors the commands: anyone at
 * the counter records one while the servisan is open and none is recorded; only an owner
 * changes one already recorded, since a lower figure is how cash would go missing.
 */
export function downPaymentAction(
  ticket: Pick<TicketSummaryRow, 'location' | 'outcome' | 'downPayment'>,
  can: RepairAbilities,
): 'record' | 'correct' | null {
  if (ticket.downPayment !== null) return can.correctDownPayment ? 'correct' : null;
  const open = ticket.location === 'in_store' && ticket.outcome !== 'cancelled';
  return can.intake && open ? 'record' : null;
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
    },
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

/** What the customer owes: the cancellation fee on a cancelled servisan, else the agreed total. */
export function amountOwed(
  row: Pick<TicketSummaryRow, 'outcome' | 'cancelFee' | 'quoteTotal'>,
): number {
  return row.outcome === 'cancelled' ? (row.cancelFee ?? 0) : row.quoteTotal;
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
export type DownPaymentGap = 'aboveTotal' | 'amount' | 'correctAmount' | 'same' | 'reason';

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
        : null
      : amount === null
        ? 'correctAmount'
        : amount === input.current
          ? 'same'
          : input.reason.trim() === ''
            ? 'reason'
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
        | 'handover';
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
    'outcome' | 'location' | 'technicianId' | 'pendingProposals' | 'quoteLines'
  >,
  can: RepairAbilities,
  userId: string,
): StaleStep | null {
  const actions = ticketActions(ticket, can, userId);
  const line =
    step.kind === 'proposal' ? ticket.quoteLines.find((row) => row.id === step.lineId) : undefined;
  const lineOpen = step.kind !== 'proposal' || line?.status === 'proposed';
  if (lineOpen && STEP_ACTIONS[step.kind].some((action) => actions.includes(action))) return null;

  if (ticket.location === 'returned') return { kind: 'returned' };
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
  lines: z.array(zLineDraft),
  /** Rupiah the customer paid up front, as typed; '' when nothing was paid. */
  downPayment: z.string().default(''),
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
    lines: [],
    downPayment: '',
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
  | 'deviceBrand'
  | 'deviceModel'
  | 'screenLock'
  | 'complaint'
  | 'photos'
  | 'quoteLines'
  | 'incompleteLine'
  | 'negativeTotal'
  | 'downPaymentAboveTotal';

export function stepProblems(
  draft: IntakeDraft,
  step: IntakeStep,
  options: IntakeOptionLists,
): IntakeProblem[] {
  const problems: IntakeProblem[] = [];
  switch (step) {
    case 'customer':
      if (draft.customer.kind === 'new' && draft.customer.name.trim() === '') {
        problems.push('customerName');
      }
      break;
    case 'device':
      if (draft.device.brand.trim() === '') problems.push('deviceBrand');
      if (draft.device.model.trim() === '') problems.push('deviceModel');
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
      break;
    case 'review':
      for (const earlier of INTAKE_STEPS.slice(0, -1)) {
        problems.push(...stepProblems(draft, earlier, options));
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
): OpenTicketInput {
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
      imei: draft.device.imei.trim() || null,
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
    downPayment: intakeDownPayment(draft),
  };
}
