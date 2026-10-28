// Counter PC screens for `repair`: React DOM on @bolusi/ui-web, over the same runtime port, flows
// and queries the phone screens use. Only the desktop app imports this entry.
export { RepairBoardPage, type BoardFilters, type RepairBoardPageProps } from './Board.js';
export { IntakePage, type IntakePageProps } from './Intake.js';
export { TicketPane, type TicketPaneProps } from './TicketPane.js';
export { PrintSettings } from './PrintSettings.js';
export {
  CancelFeesSettings,
  DiscardChangesDialog,
  IntakeListSettings,
  repairSettingsAccess,
  SlipSettings,
  UncollectedSettings,
  type RepairSettingsProps,
} from './Settings.js';
export { repairAbilities } from '../flows.js';
export { INTAKE_LIST_KEY } from '../labels.js';
export { INTAKE_OPTION_LISTS, type IntakeOptionList } from '../intake-options.js';
export {
  PrinterProblem,
  RepairRuntimeProvider,
  useRepairRuntime,
  type DecodedImage,
  type DevicePrinter,
  type DevicePrinters,
  type RepairPrinting,
  type RepairRuntime,
  type SlipOutput,
} from '../runtime.js';
export { registerRepairCatalog } from '../i18n.js';
export { tn } from '../i18n.js';
export type { IntakeDraft } from '../flows.js';
