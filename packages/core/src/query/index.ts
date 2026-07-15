// @bolusi/core query runtime (04-module-contract §6): typed reads, permission-checked at the SAME
// enforcement point commands use (02 §4), cursor pagination (no offsets), and the read-only `qctx`
// inside which data-gating happens (02 §9, FR-1029).
//
// A denial here is an explicit `DomainError('PERMISSION_DENIED')` and NEVER an empty result
// (FR-1036, security-guide §2.2) — an empty page leaks "the store exists and is quiet" and is
// indistinguishable from a legitimate empty page.
export { QueryRuntime, type ExecutableQuery, type QueryRuntimeOptions } from './execute.js';

export {
  readOnlyDb,
  ReadOnlyDbError,
  type QueryContext,
  type QueryPage,
  type ReadonlyProjectionDb,
} from './qctx.js';

export { decodeCursor, encodeCursor, type CursorPosition } from './cursor.js';
