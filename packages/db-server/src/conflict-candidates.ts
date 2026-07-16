// Rule 1's candidate query (01-domain-model §8.2) — the ONE statement that decides which
// already-accepted ops a just-accepted op collided with.
//
// ── WHY IT LIVES IN db-server AND NOT NEXT TO THE RULES (apps/server/src/sync) ────────────────
//
// The same reason task 49 homed `createServerProjectionEngine` here, and task 47 the watermark
// store: `pnpm test:rls` — the ONLY attributed real-PG16 lane — is `--project db-server`, and
// `packages/*` never import `apps/*` (08 §3.3 rule 1). A copy of this query living in apps/server
// could only ever be executed by PGlite, and D16 is explicit that a substitute "may never be the
// sole witness for a claim about the production driver". Homed here, the statement the push
// transaction runs is the statement PG16 runs — closed by construction, not by discipline.
//
// The RULES (what conflicts, what severity, dedupe, emission) stay in apps/server. This file is
// only the part whose correctness depends on the driver and the planner.
//
// ── EVERY COMPARISON IS IN SQL, DELIBERATELY (T-14f) ──────────────────────────────────────────
//
// Rule 1 is `serverSeq(P) > lastPullCursor(O.device)` and the A/B ordering is canonical order
// `(timestamp ASC, deviceId ASC, seq ASC)` (05 §4). Every operand of both is an `int8`/`uuid`
// COLUMN, and the production `pg` driver returns `int8` as a STRING while better-sqlite3 and PGlite
// return a number. Pulling these into JS to compare them is task 46 exactly: `"10" > "9"` is false,
// so past `server_seq` 9 the rule would silently stop firing — green on every substitute lane,
// broken in production, no error.
//
// So nothing is compared in JS. Postgres compares `int8` to `int8` and `uuid` to `uuid` natively,
// with its own semantics, and hands back the one thing that cannot be mis-marshalled: a boolean.
// This is not "a cast someone remembered"; it is a shape in which the bug cannot be written.
import { sql, type Kysely } from 'kysely';

import type { DB } from './generated/db.js';
import type { TenantDb } from './for-tenant.js';

/** What Rule 1 needs to know about the op being accepted (05 §2.1's envelope fields). */
export interface Rule1Probe {
  /** The accepted op's id — excluded from its own candidate set. */
  readonly opId: string;
  /** The conflicted entity (01 §8.1: two ops conflict only when they share entityId + key). */
  readonly entityId: string;
  /** The pushing device — `P.deviceId ≠ O.deviceId` is half the rule. */
  readonly deviceId: string;
  /** Canonical-order operands for this op (05 §4). Numbers: they came off the wire, not the DB. */
  readonly timestamp: number;
  readonly seq: number;
  /**
   * Every op type that declares the SAME `conflict.key` as the accepted op (01 §8.1).
   *
   * The key is declared per TYPE (04 §3), and the op log stores types, not keys — so "ops sharing
   * conflict key K" is resolved to a type set by the caller, from the module registry, and passed
   * here. Two DIFFERENT types may share a key (a v1 and a v2 of the same edit), which is why this
   * is a set and not the accepted op's own type.
   */
  readonly typesWithSameKey: readonly string[];
}

/** One already-accepted op that collided with the probe (01 §8.2 Rule 1). */
export interface Rule1Candidate {
  /** The colliding op `P`'s id. */
  readonly opId: string;
  /**
   * Is `P` canonically BEFORE the accepted op `O` (05 §4's `(timestamp, deviceId, seq)`)?
   *
   * Computed by Postgres, returned as a boolean — see the header. The caller uses it to put the
   * pair in canonical order (01 §5.4: "The colliding ops, canonical order (A before B)") without
   * ever touching an `int8` in JS.
   */
  readonly beforeProbe: boolean;
}

/**
 * Find the ops a just-accepted op conflicts with under Rule 1 (01 §8.2).
 *
 * > On accepting op `O` with conflict key `K` on entity `E`: `O` conflicts with every
 * > already-accepted op `P` on (`E`, `K`) where `P.deviceId ≠ O.deviceId` **and**
 * > `serverSeq(P) > lastPullCursor(O.device)` at acceptance time.
 *
 * Each clause below is one of those conjuncts, and the reading of the whole is: O's device had not
 * pulled P when it pushed O, so O's author acted without knowledge of P — a genuine concurrent
 * edit rather than a sequence.
 *
 * `db` is the caller's tenant-bound handle from `forTenant`, so RLS scopes `operations` to the
 * tenant (10-db §6.2) and no `WHERE tenant_id` is written here — a hand-added filter that
 * disagreed with the GUC is the bug forTenant's contract exists to prevent.
 *
 * Returns `[]` when the type set is empty (an op whose type declares no conflict), WITHOUT a
 * round trip: `IN ()` is not a legal Postgres predicate, and Kysely would compile the empty list
 * to `in (null)` — a silently-matches-nothing clause. Same answer, stated rather than stumbled on.
 */
export async function findRule1Candidates(
  db: TenantDb | Kysely<DB>,
  probe: Rule1Probe,
): Promise<Rule1Candidate[]> {
  if (probe.typesWithSameKey.length === 0) return [];

  const rows = await db
    .selectFrom('operations as o')
    // The pushing device's pull cursor, joined rather than read: it keeps `server_seq >
    // last_pull_cursor` a Postgres int8 comparison between two COLUMNS. Reading the cursor into JS
    // and passing it back as a parameter would work too, but it puts a bigint through the driver
    // for no reason — and "it happens to survive the round trip" is a property nobody re-checks.
    .innerJoin('devices as d', (join) => join.on('d.id', '=', probe.deviceId))
    .select([
      'o.id as opId',
      // Canonical order (05 §4), decided by Postgres. Row-value comparison, so the three keys are
      // compared left-to-right with exactly the precedence 05 §4 specifies.
      sql<boolean>`(o.timestamp_ms, o.device_id, o.seq) < (${probe.timestamp}::bigint, ${probe.deviceId}::uuid, ${probe.seq}::bigint)`.as(
        'beforeProbe',
      ),
    ])
    // … on the same ENTITY …
    .where('o.entityId', '=', probe.entityId)
    // … sharing the conflict KEY (01 §8.1), resolved to the types that declare it.
    .where('o.type', 'in', probe.typesWithSameKey)
    // `P.deviceId ≠ O.deviceId` — the same device editing twice is a sequence, not a conflict.
    .where('o.deviceId', '!=', probe.deviceId)
    // `serverSeq(P) > lastPullCursor(O.device)` — O's device had not seen P. THE int8 comparison.
    .whereRef('o.serverSeq', '>', 'd.lastPullCursor')
    // An op never conflicts with itself. It is already in the log at this point (the pipeline
    // INSERTs before detection runs), and it trivially satisfies every other clause except the
    // device one — so this is belt-and-braces rather than load-bearing. Cheap, and it makes the
    // set's meaning ("other ops") true on its face.
    .where('o.id', '!=', probe.opId)
    .execute();

  return rows.map((row) => ({ opId: row.opId, beforeProbe: row.beforeProbe }));
}
