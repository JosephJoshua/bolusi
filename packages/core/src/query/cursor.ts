// Query pagination cursors (04-module-contract §6: "Cursor pagination everywhere (no offsets)").
//
// WHY NO OFFSETS. `LIMIT 20 OFFSET 40` answers "rows 41-60 of the current result", which is a
// different set of rows every time anything is inserted or removed — so a client walking pages
// silently skips and repeats rows while it walks. A cursor names a POSITION in a total order, so
// page N+1 starts exactly where page N stopped no matter what happened in between. This matters
// more here than in a typical app: rows arrive from OTHER DEVICES mid-walk (sync pull applies ops
// into the same projection the walk is reading), so "the list changed under you" is the normal case
// rather than the edge case.
//
// ── WHAT A CURSOR IS NOT ──────────────────────────────────────────────────────────────────────
//
// A cursor is a POSITION, never an AUTHORIZATION. It is not signed, and it does not need to be:
// every query re-runs the whole 04 §6 sequence — permission check at the single enforcement point
// (02 §4), then a handler that scopes its own reads to `qctx.tenantId` / `qctx.storeId`. A caller
// who hand-crafts a cursor moves their own position within the rows they were already entitled to,
// which is not an escalation; it is paging. The property that makes this true is that scope comes
// from `qctx` (which the runtime mints) and NEVER from the cursor — so a tampered cursor can name a
// position, but it cannot name a tenant, a store, or a user. A handler that put a scope value in
// its cursor and read it back would break that, which is why `CursorPosition` is a sort key only.
//
// Consequently the threat model here is CORRUPTION, not forgery: a truncated, stale, or
// hand-edited string must produce the typed rejection 04 §6 requires, never an unhandled throw and
// never a silent restart from page one. Silent restart is the interesting one — it is what a naive
// `try { parse } catch { return firstPage() }` does, and it turns a client's page-walk into an
// infinite loop that re-delivers page one forever while looking perfectly healthy.
import { base64ToBytes, bytesToBase64, bytesToUtf8, utf8ToBytes } from '../crypto/bytes.js';
import { DomainError } from '../errors/domain-error.js';

/**
 * A decoded cursor: the sort key of the LAST row of the page just delivered.
 *
 * `sort` is carried so a cursor cannot be replayed against a different ordering — walking
 * `createdAt.desc` and then handing that cursor to `createdAt.asc` is a caller bug whose symptom
 * (rows quietly missing) is unreadable. It is checked on decode and fails as a malformed cursor.
 *
 * `values` are the ordered sort-key components, ending with a unique tiebreaker (04 §6 pagination
 * is only total if the key is). The fixture module and every real module sort by
 * `(<sortColumn>, id)` for exactly that reason: without the id tiebreaker two rows sharing a
 * timestamp have no defined order, so a page boundary landing between them drops or repeats one —
 * the precise bug cursors exist to prevent, reintroduced one layer down.
 */
export interface CursorPosition {
  /** The `sort` value the page was walked with (e.g. `createdAt.desc`). */
  readonly sort: string;
  /** Ordered sort-key values of the last row delivered. */
  readonly values: readonly (string | number)[];
}

/** Format marker. A future change to the cursor's shape bumps this and old cursors reject cleanly. */
const CURSOR_VERSION = 1;

/** The wire shape, kept short: cursors travel in URLs and get logged. */
interface CursorWire {
  readonly v: number;
  readonly s: string;
  readonly k: readonly (string | number)[];
}

/** A malformed/tampered/stale cursor (04 §6). Always this, never an unhandled throw. */
function malformed(reason: string): DomainError {
  return new DomainError(
    'VALIDATION_FAILED',
    { field: 'cursor', issue: reason },
    `cursor rejected: ${reason} (04 §6)`,
  );
}

/** Encode a position into the opaque string a handler returns as `nextCursor` (04 §6). */
export function encodeCursor(position: CursorPosition): string {
  const wire: CursorWire = { v: CURSOR_VERSION, s: position.sort, k: position.values };
  return bytesToBase64(utf8ToBytes(JSON.stringify(wire)));
}

/**
 * Decode a caller-supplied cursor.
 *
 * `expectedSort` is the sort the CURRENT call is walking; a cursor minted under a different sort is
 * rejected rather than silently re-interpreted.
 *
 * @throws {DomainError} `VALIDATION_FAILED` — for every malformed input, with no other outcome.
 *   Not `ENTITY_NOT_FOUND` (a cursor is not an entity) and never `PERMISSION_DENIED` (a cursor
 *   carries no authority — see the header).
 */
export function decodeCursor(cursor: string, expectedSort: string): CursorPosition {
  if (typeof cursor !== 'string' || cursor.length === 0) {
    throw malformed('empty');
  }

  // Every layer below throws its own error type on bad input (`RangeError` from the codecs,
  // `SyntaxError` from JSON). They are caught and re-thrown as the ONE typed rejection: a caller
  // must not have to distinguish "not base64" from "not JSON" to know their cursor is bad, and an
  // unhandled RangeError escaping the query runtime is exactly what 04 §6 forbids.
  let wire: unknown;
  try {
    wire = JSON.parse(bytesToUtf8(base64ToBytes(cursor)));
  } catch {
    throw malformed('not a valid cursor encoding');
  }

  if (typeof wire !== 'object' || wire === null || Array.isArray(wire)) {
    throw malformed('not a cursor object');
  }
  const { v, s, k } = wire as Partial<CursorWire>;

  if (v !== CURSOR_VERSION) {
    throw malformed(`unsupported cursor version ${JSON.stringify(v)}`);
  }
  if (typeof s !== 'string') {
    throw malformed('missing sort');
  }
  if (s !== expectedSort) {
    throw malformed(
      `cursor was issued for sort ${JSON.stringify(s)}, this call sorts by ${JSON.stringify(expectedSort)}`,
    );
  }
  if (!Array.isArray(k) || k.length === 0) {
    throw malformed('missing sort key');
  }
  for (const value of k) {
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw malformed('sort key must contain only strings and numbers');
    }
    // A non-finite number would have JSON-serialized to `null` on the way out, so seeing one here
    // means the cursor was hand-edited. It would also compare false against everything in SQL,
    // silently returning an empty page — a wrong answer that looks like a legitimate end-of-list.
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw malformed('sort key contains a non-finite number');
    }
  }

  return { sort: s, values: k as readonly (string | number)[] };
}
