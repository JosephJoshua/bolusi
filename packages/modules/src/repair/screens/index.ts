// The `repair` module's phone screens, importable only from apps (08 §3.2): the board, ticket detail
// with its action steps, the intake wizard and the handover, over a `RepairRuntime` the app binds.
export { RepairBoard, type RepairBoardProps } from './RepairBoard.js';
export { TicketDetail, type TicketDetailProps } from './TicketDetail.js';
export { IntakeWizard, type IntakeWizardProps } from './IntakeWizard.js';
export type { DiscardGuard } from '../../screen-kit/index.js';
export { Handover, type HandoverProps } from './Handover.js';
export type { RepairChrome } from './parts.js';
export {
  RepairRuntimeProvider,
  useRepairRuntime,
  type RepairRuntime,
  type RepairTechnician,
} from './runtime.js';
export {
  REPAIR_KEYS,
  registerRepairCatalog,
  tn,
  type RepairCatalogTree,
  type RepairKey,
} from './i18n.js';
