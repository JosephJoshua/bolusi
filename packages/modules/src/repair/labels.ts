// The catalog key for each stored repair value. Values are stored as stable keys (a check, a
// peripheral, a photo slot) so either language reads them; a key this build does not know shows as
// it was stored. An intake list item the owner named shows that name instead.
import type { ChecklistState, IntakePhotoSlot, QuoteLineKind } from './constants.js';

import { tn, type RepairKey } from './i18n.js';
import type { IntakeStep, StaleStep, TicketStatus } from './flows.js';
import type { ScreenLockKind } from './screen-lock.js';
import {
  READY_UNKNOWN,
  readyDays,
  type IntakeCheck,
  type IntakeOption,
  type IntakeOptionList,
  type Peripheral,
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
