// Shared plumbing for module screens: a typed runtime context, live queries that re-run on
// projection changes (04 §7), verified thumbnail loading (06 §6), per-entity sync statuses and
// module catalogs. Each module's screens bind these to their own runtime port; nothing here knows
// about any one module.
export {
  useActionRunner,
  useCapture,
  usePlaceOpen,
  type ActionRunner,
  type DiscardGuard,
  type PlaceOpen,
  type PlaceStep,
  type StepBack,
} from './action.js';
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
export { FRESH_ACTION_MS, TYPING_PAUSE_MS, useJustReplaced, useSettledValue } from './settled.js';
export {
  changeView,
  DEFAULT_PAGE_SIZE,
  pageCount,
  PAGE_SIZES,
  pageWindow,
  tableView,
  TableViewProvider,
  useTableView,
  viewRows,
  type ColumnSort,
  type TableView,
  type TableViewStore,
} from './table-view.js';
export { useTick } from './tick.js';
export {
  UNDO_WINDOW_MS,
  UndoProvider,
  useOfferUndo,
  useShownUndo,
  type ShownUndo,
  type UndoOffer,
} from './undo.js';
export { rejectedCount, statusesFor, type EntitySyncStatuses } from './sync-statuses.js';
export {
  useThumbnailState,
  type ThumbnailLoader,
  type ThumbnailRef,
  type ThumbnailState,
} from './thumbnail.js';
