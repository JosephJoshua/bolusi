// The `inventory` module's platform-free public surface. The registered instance is built in
// `@bolusi/modules` (it needs each use's check); this exports the parts it is built from.
export {
  defineInventoryModule,
  INVENTORY_PERMISSIONS,
  type InventoryModule,
  type InventoryModuleManifest,
} from './manifest.js';
export * from './constants.js';
export type * from './schema.js';
export type { PartUseCheck, PartUseTarget, PartUseTargets } from './part-use.js';
export { INVENTORY_REFUSALS } from './rules.js';
export { partSearchSource } from './search.js';
export {
  MOVEMENTS_SHOWN,
  PART_FILTERS,
  type GetPartInput,
  type ListPartsInput,
  type MovementRow,
  type PartDetailRow,
  type PartFilter,
  type PartRow,
  type PartsForUseInput,
  type PartsForUseRow,
  type UsedPartRow,
} from './queries.js';
export type { AddPartInput, CountStockInput, EditPartInput, UsePartInput } from './commands.js';
