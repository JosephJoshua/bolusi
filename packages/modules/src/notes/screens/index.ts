// The `notes` module's RN screens (04 §8 / design-system §8.6) — Hermes-only, importable ONLY from
// apps/mobile (08 §3.2, boundary-lint enforced). The first module UI and the pattern every later
// module screen copies: `useQuery`/`useCommand` over a `NotesRuntime` the composition root binds
// (04 §7), all four §5 states, live-query invalidation, media, and full i18n.
export { NotesList, type NotesListProps } from './NotesList.js';
export { NoteEditor, type NoteEditorProps } from './NoteEditor.js';
export { NoteDetail, type NoteDetailProps } from './NoteDetail.js';

export {
  NotesRuntimeProvider,
  useNotesRuntime,
  useQuery,
  useCommand,
  useThumbnail,
  type NotesRuntime,
  type NotesRuntimeProviderProps,
  type NoteSyncStatuses,
  type CapturedMedia,
  type ThumbnailState,
  type QueryState,
} from './runtime.js';

export {
  registerNotesCatalog,
  tn,
  NOTES_KEYS,
  type NotesKey,
  type NotesCatalogTree,
} from './i18n.js';

export { statusesFor, hasRejectedOp, bodyPreview } from './model.js';

// Re-exported so a screen consumer has one import site; DEFINED in the data layer (media-ref.ts),
// because "may this attachment be fetched" is a property of the op version, not of a screen.
export { thumbnailRefFor, type ThumbnailRef, type NoteMediaFields } from '../media-ref.js';
