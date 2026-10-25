// The catalog key for each stored repair value. Values are stored as stable keys (a check, a
// peripheral, a photo slot) so either language reads them; a key this build does not know shows as
// it was stored.
import type { ChecklistState, IntakePhotoSlot, QuoteLineKind } from '../constants.js';

import { tn, type RepairKey } from './i18n.js';
import type { IntakeCheck, IntakeStep, Peripheral, ReadyChoice, TicketStatus } from '../flows.js';

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

export const READY_KEY: Readonly<Record<ReadyChoice, RepairKey>> = {
  today: 'repair.ready.today',
  tomorrow: 'repair.ready.tomorrow',
  threeDays: 'repair.ready.threeDays',
  unknown: 'repair.ready.unknown',
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

function storedLabel(keys: Readonly<Record<string, RepairKey>>, value: string): string {
  const key = Object.hasOwn(keys, value) ? keys[value] : undefined;
  return key === undefined ? value : tn(key);
}

export const statusLabel = (status: TicketStatus): string => tn(STATUS_KEY[status]);
export const checkLabel = (item: string): string => storedLabel(CHECK_KEY, item);
export const peripheralLabel = (item: string): string => storedLabel(PERIPHERAL_KEY, item);

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
