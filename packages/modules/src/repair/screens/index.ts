// The `repair` module's phone screens, importable only from apps (08 §3.2): the board, ticket detail
// with its action steps, the intake wizard, the handover and the owner's settings, over a `RepairRuntime` the app binds.
export { NoTicketOpen, RepairBoard, type RepairBoardProps } from './RepairBoard.js';
export { TicketDetail, type TicketDetailProps } from './TicketDetail.js';
export { IntakeWizard, type IntakeWizardProps } from './IntakeWizard.js';
export type { DiscardGuard, StepBack } from '../../screen-kit/index.js';
export { Handover, type HandoverProps } from './Handover.js';
export { IntakeOptionsScreen, type IntakeOptionsScreenProps } from './IntakeOptionsScreen.js';
export { CancelFeesScreen, type CancelFeesScreenProps } from './CancelFeesScreen.js';
export { PrintSettingsScreen, type PrintSettingsScreenProps } from './PrintSettingsScreen.js';
export { PaperScreen, type PaperScreenProps } from './PaperScreen.js';
export { PaperChoice } from './PaperChoice.js';
export { StoreBasicsList } from './StoreBasicsList.js';
export { PAPER_KEY, PHONE_PAPERS, useDevicePaper } from '../paper.js';
export { UncollectedDaysScreen, type UncollectedDaysScreenProps } from './UncollectedDaysScreen.js';
export type { RepairChrome } from './parts.js';
export { catalogModelSearch } from '../model-picker.js';
export {
  RepairRuntimeProvider,
  moneyRuntimeOf,
  servisanCustomers,
  useRepairRuntime,
  type RepairPrinting,
  type RepairRuntime,
  type RepairTechnician,
  type SlipOutput,
} from '../runtime.js';
export {
  REPAIR_KEYS,
  registerRepairCatalog,
  tn,
  type RepairCatalogTree,
  type RepairKey,
} from '../i18n.js';
