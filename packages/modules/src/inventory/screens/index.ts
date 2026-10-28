// The inventory module's React Native surface: importable only from apps/mobile (screens split).
export { PartsSurface, type PartsSurfaceProps } from './PartsSurface.js';
export {
  PutBackStep,
  TakePartStep,
  UsedPartsSection,
  type PartUse,
  type PutBackStepProps,
  type TakePartStepProps,
  type UsedPartsSectionProps,
} from './UsedParts.js';
export {
  InventoryRuntimeProvider,
  useInventoryRuntime,
  type InventoryRuntime,
} from '../runtime.js';
export { registerInventoryCatalog, ti } from '../i18n.js';
