// Keyset pagination (04-module-contract §6) — the shared halves of every paginated list handler,
// extracted from three per-site copies (auth denials, platform conflicts, notes; CLAUDE.md §2.8).
//
// Two helpers, matching the two halves every site hand-rolled:
//   `keysetPredicate`  — the tuple comparison that resumes a walk after `CursorPosition`.
//   `fetchKeysetPage`  — the "One MORE than asked" contract: limit+1 fetch, sentinel slice,
//                        `nextCursor` from the last DELIVERED row, null on the last page.
//
// WHY `fetchKeysetPage` TAKES A `fetch` CALLBACK AND NOT THE QUERY BUILDER. The handler keeps
// building its own Kysely query (filters, gating, ordering are module policy — 02 §9 gating happens
// THERE); this helper owns only the page arithmetic, which is exactly the part that was drifting
// toward three divergent copies. A helper that took the builder would also have to take the row
// mapper and the gating rules, i.e. it would become a fourth query runtime.
import type { ExpressionBuilder, ExpressionWrapper, StringReference } from 'kysely';
import type { SqlBool } from 'kysely';

import { encodeCursor, type CursorPosition } from './cursor.js';

/**
 * The resume-a-walk predicate: `(column, id) < (lastValue, lastId)` — spelled as
 * `column < v OR (column = v AND id < lastId)` — or `>` ascending.
 *
 * The tiebreaker leg is why a page boundary landing between two rows that share a timestamp
 * neither drops nor repeats one (cursor.ts's whole reason to exist, one layer down). The
 * comparison values come from a decoded `CursorPosition`, whose `sort` the codec already checked
 * against the walk's sort — so a cursor from a different ordering never reaches this predicate.
 */
export function keysetPredicate<DB, TB extends keyof DB & string>(
  eb: ExpressionBuilder<DB, TB>,
  opts: {
    readonly column: StringReference<DB, TB>;
    readonly idColumn: StringReference<DB, TB>;
    readonly position: CursorPosition;
    readonly descending: boolean;
  },
): ExpressionWrapper<DB, TB, SqlBool> {
  const [lastValue, lastId] = opts.position.values as [
    // The cursor codec types values as (string | number)[]; the column's concrete type is the
    // site's knowledge, exactly as it was when each site cast `position.values` itself.
    never,
    never,
  ];
  const cmp = opts.descending ? '<' : '>';
  return eb.or([
    eb(opts.column, cmp, lastValue),
    eb.and([eb(opts.column, '=', lastValue), eb(opts.idColumn, cmp, lastId)]),
  ]);
}

/** What a paginated handler returns to shape: the delivered page and the (nullable) next cursor. */
export interface KeysetPage<Row> {
  readonly rows: readonly Row[];
  readonly nextCursor: string | null;
}

/**
 * One MORE than asked: how "is there a next page?" is answered without a second COUNT, and what
 * makes the last page's `nextCursor` null rather than a cursor yielding an empty page (04 §6).
 *
 * `cursorValues` names the sort-key components of a delivered row, ending with the id tiebreaker —
 * the same shape `keysetPredicate` consumes on the next call.
 */
export async function fetchKeysetPage<Row>(opts: {
  /** Runs the site's fully-built query with the sentinel limit. */
  readonly fetch: (limitPlusOne: number) => Promise<Row[]>;
  readonly limit: number;
  /** The walk's sort value, carried into the cursor so it rejects on a different ordering. */
  readonly sort: string;
  /** Sort-key components of a row, tiebreaker last — fed to `encodeCursor`. */
  readonly cursorValues: (last: Row) => readonly (string | number)[];
}): Promise<KeysetPage<Row>> {
  const found = await opts.fetch(opts.limit + 1);
  const hasMore = found.length > opts.limit;
  const page = hasMore ? found.slice(0, opts.limit) : found;

  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last !== undefined
      ? encodeCursor({ sort: opts.sort, values: opts.cursorValues(last) })
      : null;

  return { rows: page, nextCursor };
}
