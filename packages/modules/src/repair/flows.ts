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
  type WorkPhotoStage,
} from './constants.js';
import { readyDays, type IntakeOption, type IntakeOptionLists } from './intake-options.js';
import type {
  ListTicketsInput,
  TicketDetailRow,
  TicketPhotoRow,
  TicketSummaryRow,
} from './queries.js';

// ── board ─────────────────────────────────────────────────────────────────────────────────────

export const BOARD_VIEWS = ['active', 'mine', 'unassigned', 'pickup', 'returned'] as const;
export type BoardView = (typeof BOARD_VIEWS)[number];

const IN_PROGRESS = IN_PROGRESS_OUTCOMES;

/** The `listTickets` filter behind each board view. */
export function boardFilter(view: BoardView, userId: string): ListTicketsInput['filter'] {
  switch (view) {
    case 'active':
      return { outcomes: [...IN_PROGRESS], location: 'in_store' };
    case 'mine':
      return { outcomes: [...IN_PROGRESS], location: 'in_store', technicianId: userId };
    case 'unassigned':
      return { outcomes: [...IN_PROGRESS], location: 'in_store', unassigned: true };
    case 'pickup':
      return { outcomes: ['repaired', 'cancelled'], location: 'in_store' };
    case 'returned':
      return { location: 'returned' };
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
  readonly handover: boolean;
  /** Edit the franchise's intake lists (tenant-wide). */
  readonly manageIntakeOptions: boolean;
  /** Hide intake list items at this store. */
  readonly hideIntakeOptions: boolean;
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
    handover: hasPermission(P.handover),
    manageIntakeOptions: hasPermission(P.manageIntakeOptions),
    hideIntakeOptions: hasPermission(P.hideIntakeOptions),
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
  device: z.strictObject({
    brand: z.string(),
    model: z.string(),
    color: z.string(),
    imei: z.string(),
    passcode: z.string(),
  }),
  complaint: z.string(),
  intakeNotes: z.string(),
  checks: z.record(z.string(), z.enum(CHECKLIST_STATES)),
  peripherals: z.array(z.string()),
  /** Photo per angle id. */
  photos: z.record(z.string(), zMediaRef),
  lines: z.array(zLineDraft),
  /** The ready-by option id picked, or '' while the store's default stands. */
  ready: z.string().transform((ready) => LEGACY_READY[ready] ?? ready),
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
    device: { brand: '', model: '', color: '', imei: '', passcode: '' },
    complaint: '',
    intakeNotes: '',
    checks: {},
    peripherals: [],
    photos: {},
    lines: [],
    ready: '',
  };
}

/** Whether the draft holds anything worth keeping or asking before discarding. */
export function intakeDirty(draft: IntakeDraft): boolean {
  const empty = emptyIntakeDraft();
  return JSON.stringify({ ...draft, step: 0 }) !== JSON.stringify(empty);
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
  | 'complaint'
  | 'photos'
  | 'quoteLines'
  | 'incompleteLine'
  | 'negativeTotal';

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

export function intakeTotal(lines: readonly QuoteLineDraft[]): number {
  return validLines(lines).reduce((sum, line) => sum + signedAmount(line.kind, line.amount), 0);
}

/**
 * The `openTicket` input for a complete draft, against the lists the counter was shown. Each
 * check, accessory and photo carries its label as shown, so the ticket keeps it. Call only when
 * `review` has no problems.
 */
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
    customer:
      draft.customer.kind === 'existing'
        ? { customerId: draft.customer.customerId }
        : { name: draft.customer.name.trim(), phone: draft.customer.phone.trim() || null },
    device: {
      brand: draft.device.brand.trim(),
      model: draft.device.model.trim(),
      color: draft.device.color.trim(),
      imei: draft.device.imei.trim() || null,
      passcode: draft.device.passcode === '' ? null : draft.device.passcode,
    },
    complaint: draft.complaint.trim(),
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
  };
}
