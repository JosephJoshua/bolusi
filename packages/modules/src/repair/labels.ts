// The catalog key for each stored repair value. Values are stored as stable keys (a check, a
// peripheral, a photo slot) so either language reads them; a key this build does not know shows as
// it was stored. An intake list item the owner named shows that name instead.
import { formatDate } from '@bolusi/i18n';

import type { ChecklistState, IntakePhotoSlot, QuoteLineKind } from './constants.js';

import { tn, type RepairKey } from './i18n.js';
import type { DownPaymentGap, IntakeStep, StaleStep, TicketAction, TicketStatus } from './flows.js';
import type { SpecFactKey } from './device-specs.js';
import type { ScreenLockKind } from './screen-lock.js';
import {
  READY_UNKNOWN,
  readyDays,
  type IntakeCheck,
  type IntakeOption,
  type IntakeOptionList,
  type Peripheral,
  type RecordedRepairType,
  type RepairTypeId,
  warrantyEnds,
} from './intake-options.js';

const STATUS_KEY: Readonly<Record<TicketStatus, RepairKey>> = {
  received: 'repair.status.received',
  in_repair: 'repair.status.inRepair',
  waiting_for_parts: 'repair.status.waitingForParts',
  repaired: 'repair.status.repaired',
  cancelled: 'repair.status.cancelled',
  returned: 'repair.status.returned',
};

export const INTAKE_SLOT_KEY: Readonly<Record<IntakePhotoSlot, RepairKey>> = {
  front: 'repair.photo.slot.front',
  back: 'repair.photo.slot.back',
  left: 'repair.photo.slot.left',
  right: 'repair.photo.slot.right',
  top: 'repair.photo.slot.top',
  bottom: 'repair.photo.slot.bottom',
};

export const PRICE_KIND_KEY: Readonly<Record<QuoteLineKind, RepairKey>> = {
  part: 'repair.price.kind.part',
  labour: 'repair.price.kind.labour',
  discount: 'repair.price.kind.discount',
  adjustment: 'repair.price.kind.adjustment',
};

/** A screen lock's kind, as the intake step offers it and the ticket names it. */
export const LOCK_KIND_KEY: Readonly<Record<'none' | ScreenLockKind, RepairKey>> = {
  none: 'repair.lock.none',
  pin: 'repair.lock.pin',
  password: 'repair.lock.password',
  pattern: 'repair.lock.pattern',
};

const CHECK_KEY: Readonly<Record<IntakeCheck, RepairKey>> = {
  screen: 'repair.check.screen',
  touch: 'repair.check.touch',
  camera: 'repair.check.camera',
  speaker: 'repair.check.speaker',
  microphone: 'repair.check.microphone',
  charging: 'repair.check.charging',
  buttons: 'repair.check.buttons',
  signal: 'repair.check.signal',
  biometrics: 'repair.check.biometrics',
};

const PERIPHERAL_KEY: Readonly<Record<Peripheral, RepairKey>> = {
  charger: 'repair.peripheral.charger',
  cable: 'repair.peripheral.cable',
  case: 'repair.peripheral.case',
  simCard: 'repair.peripheral.simCard',
  memoryCard: 'repair.peripheral.memoryCard',
  box: 'repair.peripheral.box',
};

const REPAIR_TYPE_KEY: Readonly<Record<RepairTypeId, RepairKey>> = {
  screen: 'repair.repairType.screen',
  battery: 'repair.repairType.battery',
  chargingPort: 'repair.repairType.chargingPort',
  camera: 'repair.repairType.camera',
  audio: 'repair.repairType.audio',
  buttons: 'repair.repairType.buttons',
  noPower: 'repair.repairType.noPower',
  software: 'repair.repairType.software',
  waterDamage: 'repair.repairType.waterDamage',
  unlock: 'repair.repairType.unlock',
};

export const statusLabel = (status: TicketStatus): string => tn(STATUS_KEY[status]);

/** "Hari ini", "Besok", "3 hari", "Belum tahu": a ready-by choice reads as its number of days. */
export function readyLabel(id: string): string {
  if (id === READY_UNKNOWN) return tn('repair.ready.unknown');
  const days = readyDays(id);
  if (days === 0) return tn('repair.ready.today');
  if (days === 1) return tn('repair.ready.tomorrow');
  return days === null ? id : tn('repair.ready.inDays', { count: days });
}

const BUILT_IN_KEYS: Readonly<Record<IntakeOptionList, Readonly<Record<string, RepairKey>>>> = {
  checks: CHECK_KEY,
  accessories: PERIPHERAL_KEY,
  photoAngles: INTAKE_SLOT_KEY,
  brands: {},
  readyBy: {},
  repairTypes: REPAIR_TYPE_KEY,
};

/** The app's own name for a built-in intake list item, in the current language, or null. */
export function builtInLabel(list: IntakeOptionList, id: string): string | null {
  if (list === 'readyBy') return readyLabel(id);
  const key = Object.hasOwn(BUILT_IN_KEYS[list], id) ? BUILT_IN_KEYS[list][id] : undefined;
  return key === undefined ? null : tn(key);
}

/**
 * An intake list item's name: what the owner typed, else the app's name for a built-in item. A
 * ticket passes the label it recorded, so it reads as it did at intake.
 */
export function optionLabel(list: IntakeOptionList, option: IntakeOption): string {
  if (list === 'readyBy') return readyLabel(option.id);
  return option.label ?? builtInLabel(list, option.id) ?? option.id;
}

/** A recorded repair type's name, as the servisan showed it. */
export function repairTypeLabel(type: Pick<RecordedRepairType, 'item' | 'label'>): string {
  return optionLabel('repairTypes', { id: type.item, label: type.label });
}

/**
 * One repair type's warranty as the counter tells the customer: its length while the phone is in
 * the store, its last day once the phone went home. "30 hari", "s/d 27/11/2026", "tanpa garansi".
 */
export function warrantyTerms(type: RecordedRepairType, returnedAt: number | null): string {
  const ends = warrantyEnds(type, returnedAt);
  return type.warrantyDays === 0
    ? tn('repair.warranty.none')
    : ends === null
      ? tn('repair.warranty.days', { count: type.warrantyDays })
      : tn('repair.warranty.until', { date: formatDate(ends) });
}

/**
 * A type and its warranty on one line, as the ticket lists them: "Ganti layar · garansi 30 hari",
 * "Ganti layar · garansi s/d 27/11/2026", "Kena air · tanpa garansi".
 */
export function warrantyLine(type: RecordedRepairType, returnedAt: number | null): string {
  const name = repairTypeLabel(type);
  return type.warrantyDays === 0
    ? tn('repair.warranty.lineNone', { name })
    : tn('repair.warranty.line', { name, terms: warrantyTerms(type, returnedAt) });
}

/** What an open step says once the ticket changed under it and the step can no longer finish. */
export function staleStepMessage(stale: StaleStep): string {
  switch (stale.kind) {
    case 'cancelled':
      return tn('repair.stale.cancelled');
    case 'returned':
      return tn('repair.stale.returned');
    case 'proposalDecided':
      return tn(
        stale.decision === 'applied'
          ? 'repair.stale.proposalApplied'
          : 'repair.stale.proposalDeclined',
      );
    case 'proposalPending':
      return tn('repair.stale.proposalPending');
    case 'changed':
      return tn('repair.stale.changed');
  }
}

export const INTAKE_STEP_KEY: Readonly<Record<IntakeStep, RepairKey>> = {
  customer: 'repair.intake.step.customer',
  device: 'repair.intake.step.device',
  condition: 'repair.intake.step.condition',
  photos: 'repair.intake.step.photos',
  price: 'repair.intake.step.price',
  review: 'repair.intake.step.review',
};

export const CHECK_STATE_KEY: Readonly<Record<ChecklistState, RepairKey>> = {
  ok: 'repair.condition.ok',
  issue: 'repair.condition.issue',
  not_checked: 'repair.condition.notChecked',
};

/** What a down payment entry still needs, said under the field or beside the save button. */
export const DOWN_PAYMENT_GAP_KEY: Readonly<Record<DownPaymentGap, RepairKey>> = {
  aboveTotal: 'repair.problem.downPaymentAboveTotal',
  amount: 'repair.hint.downPayment',
  reference: 'repair.problem.downPaymentReference',
  correctAmount: 'repair.hint.downPaymentCorrect',
  same: 'repair.hint.downPaymentSame',
  reason: 'repair.hint.reason',
};

/** The label of each fact the phone catalog gives about a model (`specFacts`). */
export const SPEC_FACT_KEY: Readonly<Record<SpecFactKey, RepairKey>> = {
  memory: 'repair.spec.memory',
  screen: 'repair.spec.screen',
  chipset: 'repair.spec.chipset',
  battery: 'repair.spec.battery',
  port: 'repair.spec.port',
  sim: 'repair.spec.sim',
  cardSlot: 'repair.spec.cardSlot',
  os: 'repair.spec.os',
};

const ACTION_KEY: Readonly<Record<TicketAction, RepairKey>> = {
  decidePrice: 'repair.action.decidePrice',
  claim: 'repair.action.claim',
  start: 'repair.action.start',
  resume: 'repair.action.resume',
  reopen: 'repair.action.reopen',
  waitForParts: 'repair.action.waitForParts',
  markRepaired: 'repair.action.markRepaired',
  assign: 'repair.action.assign',
  changePrice: 'repair.action.changePrice',
  proposePrice: 'repair.action.proposePrice',
  handover: 'repair.action.handover',
  cancel: 'repair.action.cancel',
};

/**
 * An action's button label. Picking a technician and taking a repair read differently once someone
 * already has it: "Ganti teknisi", and "Ambil alih" instead of "Masukkan ke Tugasku".
 */
export function actionKey(action: TicketAction, technicianId: string | null): RepairKey {
  if (technicianId !== null && action === 'assign') return 'repair.action.reassign';
  if (technicianId !== null && action === 'claim') return 'repair.action.takeOver';
  return ACTION_KEY[action];
}
