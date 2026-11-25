// The inventory module's React DOM pieces for the counter PC app (apps/desktop only).
export { registerInventoryCatalog, ti } from '../i18n.js';
export {
  InventoryRuntimeProvider,
  useInventoryRuntime,
  type InventoryRuntime,
  type PhoneModelOption,
} from '../runtime.js';
export { INVENTORY_PERMISSION, opensParts, opensTransfers } from '../constants.js';
export { NO_FILTER, type ListFilter } from '../list-filter.js';
export type { PartUse } from '../take-part.js';
export { PartsPage, type PartsPageProps } from './PartsPage.js';
export { PartsSection, type PartsSectionProps } from './PartsSection.js';
export { TransfersPage, type TransfersPageProps } from './TransfersPage.js';
export type { TransferFilter } from '../transfers/queries.js';
export { UsedPartsSection, type UsedPartsSectionProps } from './UsedParts.js';
