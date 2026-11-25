// A servisan's page as both the phone and the PC show it: which step an action opens, whether an
// open step still leads somewhere, what a price line and each photo are called. The apps only draw
// these, so the two never disagree on what a servisan offers.
import type { ThumbnailRef } from '@bolusi/schemas';

import { HANDOVER_PHOTO_SLOTS } from './constants.js';
import { customerMessageKind, type CustomerMessageKind } from './customer-message.js';
import {
  arrangeTicketActions,
  downPaymentStale,
  photoInSlot,
  photoThumbnailRef,
  repairTypesStale,
  staleStep,
  ticketActions,
  warrantyClaimAction,
  workPhotos,
  type RepairAbilities,
  type StaleStep,
  type TicketAction,
  type TicketActionLayout,
  type TicketStep,
} from './flows.js';
import { tn, type RepairKey } from './i18n.js';
import { actionKey, optionLabel } from './labels.js';
import type { QuoteLineRow, TicketDetailRow } from './queries.js';

/** What an action that runs in place, or a step that lands, says afterwards. */
export const TICKET_DONE_KEY: Partial<Record<TicketAction | 'before' | 'after', RepairKey>> = {
  claim: 'repair.done.claim',
  start: 'repair.done.start',
  resume: 'repair.done.start',
  reopen: 'repair.done.start',
  before: 'repair.done.start',
  handover: 'repair.desk.done.handover',
};

/** What an action does on the servisan's page: open a step, or run in place. */
export type TicketMove =
  | { readonly kind: 'step'; readonly step: Exclude<TicketStep, { readonly kind: 'proposal' }> }
  | {
      readonly kind: 'step';
      readonly step: {
        readonly kind: 'proposal';
        readonly lineId: string;
        readonly line: QuoteLineRow;
      };
    }
  | { readonly kind: 'run'; readonly command: 'startWork' | 'claimTicket' }
  /** Nothing to decide: no proposed line is left. */
  | null;

export function ticketMove(action: TicketAction, row: TicketDetailRow): TicketMove {
  switch (action) {
    case 'decidePrice': {
      const line = row.quoteLines.find((candidate) => candidate.status === 'proposed');
      return line === undefined
        ? null
        : { kind: 'step', step: { kind: 'proposal', lineId: line.id, line } };
    }
    case 'start':
    case 'resume':
    case 'reopen':
      // The first start needs a before photo; a resume keeps the ones already taken.
      return workPhotos(row, 'before').length === 0
        ? { kind: 'step', step: { kind: 'before' } }
        : { kind: 'run', command: 'startWork' };
    case 'claim':
      return { kind: 'run', command: 'claimTicket' };
    case 'markRepaired':
      return { kind: 'step', step: { kind: 'after' } };
    case 'handover':
    case 'waitForParts':
    case 'cancel':
    case 'undoHandover':
    case 'changeCancelFee':
    case 'correctDetails':
    case 'assign':
    case 'changePrice':
    case 'proposePrice':
      return { kind: 'step', step: { kind: action } };
  }
}

/** A step open on the page, as far as staleness goes: the ticket's steps and the two money ones. */
export type OpenTicketStep =
  | TicketStep
  | { readonly kind: 'downPayment'; readonly mode: 'record' | 'correct' }
  | { readonly kind: 'repairTypes' }
  /** Steps that do not follow the servisan's state (printing, parts, approvals, money). */
  | { readonly kind: 'print' | 'takePart' | 'putBackPart' | 'approval' | 'refund' | 'reduce' };

/**
 * The ticket keeps reading live under an open step, so a change synced from another device while
 * the user fills the step in is caught here rather than as a refusal once they submit.
 */
export function openStepStale(
  step: OpenTicketStep | { readonly kind: 'none' },
  ticket: TicketDetailRow | undefined,
  can: RepairAbilities,
  userId: string,
  now: number,
): StaleStep | null {
  if (ticket === undefined) return null;
  switch (step.kind) {
    case 'none':
    case 'print':
    case 'takePart':
    case 'putBackPart':
    case 'approval':
    case 'refund':
    case 'reduce':
      return null;
    case 'downPayment':
      return downPaymentStale(ticket, can, step.mode);
    case 'repairTypes':
      return repairTypesStale(ticket, can);
    default:
      return staleStep(step, ticket, can, userId, now);
  }
}

/** An action's button. The counter's "cancel" asks an owner to cancel. */
export function ticketActionLabel(
  action: TicketAction,
  can: RepairAbilities,
  technicianId: string | null,
): string {
  return action === 'cancel' && !can.cancel
    ? tn('repair.approval.askCancel')
    : tn(actionKey(action, technicianId));
}

/** What a price line's status is, and why, under its amount. */
export function lineCaption(line: QuoteLineRow): string {
  const status = tn(
    line.status === 'proposed'
      ? 'repair.price.status.proposed'
      : line.status === 'declined'
        ? 'repair.price.status.declined'
        : line.customerAgreed === true
          ? 'repair.price.status.agreed'
          : 'repair.price.status.notAgreed',
  );
  return line.reason === null || line.reason === '' ? status : `${status} · ${line.reason}`;
}

export interface TicketPhoto {
  readonly key: string;
  /** Which shot it is, e.g. "Depan", "Sebelum 1". */
  readonly label: string;
  /** The group it belongs to, e.g. "Foto saat diterima". */
  readonly group: string;
  readonly ref: ThumbnailRef;
}

/**
 * Every photo on the ticket in the order it was taken: at intake (the angles the ticket asked for,
 * named as they were then), before, after, at handover.
 */
export function ticketPhotos(row: TicketDetailRow): TicketPhoto[] {
  const intake = row.intakePhotos.flatMap(({ slot, label }) => {
    const photo = photoInSlot(row, slot);
    return photo === null
      ? []
      : [
          {
            key: slot,
            label: optionLabel('photoAngles', { id: slot, label }),
            group: tn('repair.photo.intake'),
            photo,
          },
        ];
  });
  const work = (['before', 'after'] as const).flatMap((stage) =>
    workPhotos(row, stage).map((photo, index) => ({
      key: photo.slot,
      label: tn(stage === 'before' ? 'repair.photo.beforeN' : 'repair.photo.afterN', {
        n: index + 1,
      }),
      group: tn(stage === 'before' ? 'repair.photo.before' : 'repair.photo.after'),
      photo,
    })),
  );
  const handover = HANDOVER_PHOTO_SLOTS.flatMap((slot) => {
    const photo = photoInSlot(row, slot);
    return photo === null
      ? []
      : [
          {
            key: slot,
            label: tn(slot === 'signature' ? 'repair.handover.signature' : 'repair.photo.handover'),
            group: tn('repair.photo.handover'),
            photo,
          },
        ];
  });
  return [...intake, ...work, ...handover].map(({ photo, ...rest }) => ({
    ...rest,
    ref: photoThumbnailRef(photo),
  }));
}

/** What the page offers on a servisan: its actions, laid out, the WhatsApp message and a claim. */
export interface TicketPageActions {
  readonly actions: readonly TicketAction[];
  /** The next step leads; a correction stays beside what it corrects (the price, the technician). */
  readonly layout: TicketActionLayout;
  readonly messageKind: CustomerMessageKind | null;
  readonly claimAction: ReturnType<typeof warrantyClaimAction> | null;
}

export function ticketPageActions(
  ticket: TicketDetailRow | undefined,
  can: RepairAbilities,
  scope: {
    readonly userId: string;
    readonly now: number;
    readonly statusSite: string | null;
    /** Whether this page can start a claim's intake at all. */
    readonly offersClaim: boolean;
  },
): TicketPageActions {
  if (ticket === undefined) {
    return {
      actions: [],
      layout: { next: null, alternative: null, more: [] },
      messageKind: null,
      claimAction: null,
    };
  }
  const actions = ticketActions(ticket, can, scope.userId, scope.now);
  return {
    actions,
    layout: arrangeTicketActions(actions, ticket, scope.userId),
    messageKind: customerMessageKind(ticket, can, scope.statusSite),
    claimAction: scope.offersClaim ? warrantyClaimAction(ticket, can, scope.now) : null,
  };
}
