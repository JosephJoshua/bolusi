// `qctx` (04-module-contract §6) — the ENTIRE surface a query handler may touch:
//   { db /* read-only */, tenantId, storeId, userId, hasPermission(id) }
//
// The list is exhaustive in the spec and exhaustive here, and the suite pins the key set. As with
// `ctx` (runtime/ctx.ts), the interesting property is what is ABSENT:
//
//   NO clock    — a query that reads the clock is not a pure function of the projection, so two
//                 callers at different instants disagree and no test can pin either.
//   NO op()     — queries are READS. The op log is the only write path and commands are the only
//                 way into it (04 §5.1); a query minting an op would be a write path with no
//                 permission story, no envelope, and no chain position.
//   NO execute  — a query cannot run a command, for the same reason.
//   NO network  — reads come from the projection, which is the whole point of projecting.
//
// WHY `hasPermission` IS HERE AT ALL, given the runtime already checked the query's permission.
// Because 02 §9 gates DATA, not just actions: the query's own permission decides whether the
// caller may run it, and `hasPermission` decides which FIELDS and ROWS come back (§9.1 — "the
// handler consults `qctx.hasPermission(...)` and shapes the row"). Those are different questions,
// and only the handler knows how the second one maps onto its rows.
//
// WHY IT IS SYNCHRONOUS AND EMITS NO DENIAL OP. Synchronous because §6 requires it (cheap enough
// to run per command AND per query without anyone caching it ad hoc — NFR-1002); it reads task
// 09's in-memory effective-set memo, so there is no I/O to await. It emits no denial op because a
// gated field is not a denied ATTEMPT: 02 §7's denial log records someone trying to do something
// they may not, whereas gating is the query correctly shaping a result the caller IS allowed to
// receive. Emitting per gated field would also flood the log with one op per row per column, which
// is precisely what the §7 throttle exists to prevent.
import type { Kysely } from 'kysely';

/**
 * A `ProjectionDb` narrowed to reads (04 §6: "db: ProjectionDb /* read-only *&#47;").
 *
 * This is the TYPE half of the lock; `readOnlyDb` below is the runtime half. Neither is sufficient
 * alone — a cast defeats the type, and the type is what makes the mistake visible in an editor
 * rather than at 2am.
 */
export type ReadonlyProjectionDb<DB> = Pick<Kysely<DB>, 'selectFrom'>;

/** A write reached through `qctx.db`. A programming error, not a domain condition — see below. */
export class ReadOnlyDbError extends Error {
  override readonly name = 'ReadOnlyDbError';
  constructor(method: string) {
    super(
      `qctx.db.${method}() is not available: a query handler's db is READ-ONLY (04 §6). Commands are the only write path (04 §5.1) — a projection write outside an applier has no op behind it, so it would vanish on the next rebuild (04 §4.3) and exist on no other device.`,
    );
  }
}

/**
 * The methods a query handler may reach on the db handle.
 *
 * DELIBERATELY TINY, and smaller than it first looks like it should be:
 *
 *  - `with` / `withRecursive` are NOT here, though CTEs are read-shaped in spirit. Kysely hands the
 *    CTE callback a full `QueryCreator`, so `db.with('x', (qb) => qb.insertInto(...))` is a write
 *    through a read-looking door — and on Postgres a data-modifying CTE genuinely writes. An
 *    allowlist whose entries can hand back the thing the allowlist exists to withhold is not an
 *    allowlist.
 *  - `getExecutor` is NOT here: it is the handle every raw-`sql` call goes through, and with it any
 *    statement at all is reachable. Blocking it also means `sql\`...\`.execute(qctx.db)` does not
 *    work — which is a feature, not a casualty: raw SQL in a handler is how dialect-specific SQL
 *    gets in, and this contract runs the same handlers on SQLite and Postgres (04 §2).
 *
 * `selectFrom`'s own callback form is safe by construction: it receives an `ExpressionBuilder`,
 * which has no `insertInto`/`updateTable`/`deleteFrom`. The suite drives that case rather than
 * asserting it here.
 *
 * If a future module genuinely needs a CTE, that is a spec conversation (04 §6), not a quiet
 * addition to this set.
 */
const READ_ONLY_METHODS: ReadonlySet<string> = new Set(['selectFrom', 'fn', 'dynamic', 'case']);

/**
 * Wrap a `Kysely` handle so every non-read method throws (04 §6).
 *
 * A Proxy rather than a hand-built object literal on purpose: an object literal enumerates what it
 * FORWARDS, so a future Kysely version's new write method (`mergeInto` arrived exactly this way)
 * would be absent-and-silent — which for a `db` handle means a `TypeError: not a function` at best
 * and, for anything doing feature detection, a silent behaviour change. The Proxy enumerates what
 * it ALLOWS, so anything new is denied by default and says why. Default-deny is the same rule the
 * permission evaluator runs on (02 §5.3), for the same reason.
 */
export function readOnlyDb<DB>(db: Kysely<DB>): ReadonlyProjectionDb<DB> {
  return new Proxy(db, {
    get(target, property, receiver): unknown {
      if (typeof property === 'string' && !READ_ONLY_METHODS.has(property)) {
        throw new ReadOnlyDbError(property);
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      // Re-bind: Kysely's methods are prototype methods reading private state off `this`, and a
      // bare `Reflect.get` would hand back a function whose `this` is the Proxy — every internal
      // property read would then re-enter this trap and throw. Bind to the real instance.
      return typeof value === 'function' ? value.bind(target) : value;
    },
    // Writes THROUGH the handle object itself (`qctx.db.selectFrom = ...`) are refused too: the
    // guard must not be removable by the thing it guards.
    set(_target, property): never {
      throw new ReadOnlyDbError(String(property));
    },
    deleteProperty(_target, property): never {
      throw new ReadOnlyDbError(String(property));
    },
  }) as unknown as ReadonlyProjectionDb<DB>;
}

/** What every query handler returns (04 §6). */
export interface QueryPage<TRow> {
  readonly rows: readonly TRow[];
  /** Opaque cursor for the NEXT page, or `null` when this page is the last (04 §6). */
  readonly nextCursor: string | null;
}

/**
 * The query context (04 §6) — exactly `{ db, tenantId, storeId, userId, hasPermission }`.
 *
 * `storeId` is the enrolled device's store (02 §5.2's v0 rule), the same value the command runtime
 * evaluates permissions in and stamps onto every op — one field feeds all three.
 */
export interface QueryContext<DB> {
  /** Read-only projection handle (04 §6). See `readOnlyDb`. */
  readonly db: ReadonlyProjectionDb<DB>;
  readonly tenantId: string;
  readonly storeId: string | null;
  readonly userId: string;
  /**
   * Data-level gating (02 §9.1): may the CALLER see this field/row-class?
   *
   * Synchronous, and emits no denial op — see the file header for both. A `false` here means the
   * handler must OMIT the field (§9.2: absent, never `null`, never `"***"`) or filter the row.
   */
  hasPermission(permissionId: string): boolean;
}
