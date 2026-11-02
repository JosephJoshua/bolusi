// The purchasing module's React DOM pieces for the counter PC app (apps/desktop only).
export { registerPurchasingCatalog, tp } from '../i18n.js';
export {
  PurchasingRuntimeProvider,
  usePurchasingRuntime,
  type PurchasingRuntime,
} from '../runtime.js';
export { PURCHASING_PERMISSION } from '../constants.js';
export type { OrderFilter } from '../queries.js';
export { OrdersPage, type OrdersPageProps } from './OrdersPage.js';
