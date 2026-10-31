// Shared plumbing for module screens: a typed runtime context, live queries that re-run on
// projection changes (04 §7), verified thumbnail loading (06 §6), per-entity sync statuses and
// module catalogs. Each module's screens bind these to their own runtime port; nothing here knows
// about any one module.
export { useActionRunner, type ActionRunner, type DiscardGuard, type StepBack } from './action.js';
export { createRuntimeContext, type RuntimeContext } from './context.js';
export {
  moduleTranslator,
  registerModuleCatalog,
  type ModuleCatalogs,
  type ModuleCatalogTree,
} from './i18n.js';
export type {
  CaptureRequest,
  CapturedMedia,
  CapturedVideo,
  PhotoCapture,
  SignatureCapture,
  VideoCapture,
  VideoMediaRef,
  VideoPlayback,
} from './media.js';
export { useLiveQuery, type LiveSource, type QueryState } from './live.js';
export { TYPING_PAUSE_MS, useSettledValue } from './settled.js';
export { useTick } from './tick.js';
export { rejectedCount, statusesFor, type EntitySyncStatuses } from './sync-statuses.js';
export {
  useThumbnailState,
  type ThumbnailLoader,
  type ThumbnailRef,
  type ThumbnailState,
} from './thumbnail.js';
