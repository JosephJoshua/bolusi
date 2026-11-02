// The purchasing module's React Native surface: importable only from apps/mobile (screens split).
export { PurchasingSurface, type PurchasingSurfaceProps } from './PurchasingSurface.js';
export {
  PurchasingRuntimeProvider,
  usePurchasingRuntime,
  type PurchasingRuntime,
} from '../runtime.js';
export { PURCHASING_KEYS, registerPurchasingCatalog, tp } from '../i18n.js';
