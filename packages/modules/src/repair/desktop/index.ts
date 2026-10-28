// Counter PC screens for `repair`: React DOM on @bolusi/ui-web, over the same runtime port, flows
// and queries the phone screens use. Only the desktop app imports this entry.
export { RepairBoardPage, type BoardFilters, type RepairBoardPageProps } from './Board.js';
export { IntakePage, type IntakePageProps } from './Intake.js';
export { TicketPane, type TicketPaneProps } from './TicketPane.js';
export { PaperSettings } from './PaperSettings.js';
export { RepairRuntimeProvider, type RepairPrinting, type RepairRuntime } from '../runtime.js';
export { registerRepairCatalog } from '../i18n.js';
export { tn } from '../i18n.js';
export type { IntakeDraft } from '../flows.js';
