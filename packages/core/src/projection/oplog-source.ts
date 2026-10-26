// Reading the op log for the projection engine (10-db §9.2 `idx_operations_entity_canonical`).
//
// The engine folds the operation log into projections, so it reads `operations` directly
// through the injected `ProjectionDb` — the op log lives in the SAME database (client
// SQLite or server Postgres). Every read is dialect-neutral raw `sql` over the verbatim
// snake_case columns (10-db §2), each EXPLICITLY ALIASED to the camelCase key the row type
// names (`server_seq AS "serverSeq"`) — NOT relying on `CamelCasePlugin` to rewrite raw-`sql`
// result keys. The plugin does do that rewrite when wired, but a reader that depends on it
// silently returns `undefined` the moment a Kysely is built without it (task 74; T-14f).
//
// Canonical order is `(timestamp ASC, deviceId ASC, seq ASC)` (05 §4). We sort in SQL here
// (unlike the oracle, which sorts in JS): the ordering columns are `timestamp_ms` (integer),
// `device_id` and `seq` — and `device_id` is a lowercase-hex UUID whose BINARY/bytewise
// collation equals the canonical `deviceId ASC` on every engine (10-db §2), so the index
// order and `compareCanonicalOrder` agree. `oplog-source.test.ts` falsifies that assumption
// by cross-checking SQL order against the shared comparator.
import { sql, type Kysely } from 'kysely';

import type { SignedOperation } from '@bolusi/schemas';

import { operationFromSignedCoreJcs } from '../crypto/signed-core.js';
import { int8ToBigInt, int8ToNumber, type Int8Value } from './int8.js';

/** A canonical-order position (05 §4) — the rebuild checkpoint triple (04 §4.3). */
export interface CanonicalCursor {
  readonly timestamp: number;
  readonly deviceId: string;
  readonly seq: number;
}

/**
 * The op-log columns a projection read needs: the signed text and the two fields derived from it,
 * keyed camelCase by explicit aliases in `OP_COLUMNS`, not by `CamelCasePlugin` (task 74).
 *
 * The op is rebuilt from its verbatim signed text (05 §3), the one copy every engine stores
 * identically. The client keeps no other copy of the payload or location (client migration 6), and
 * reading the text sidesteps the per-driver column types task 48 found in the typed columns (int8 as
 * strings on `pg`, jsonb parsed or not, `agent_initiated` as 0/1 or a boolean): JSON numbers and
 * booleans parse the same everywhere. The ordering columns stay in the WHERE/ORDER BY clauses,
 * where the canonical index serves them.
 */
interface RawOpRow {
  signedCoreJcs: string;
  hash: string;
  signature: string;
}

const OP_COLUMNS = sql`signed_core_jcs AS "signedCoreJcs", hash, signature`;

/** The canonical `(timestamp, deviceId, seq)` position of an op. */
export function cursorOf(op: SignedOperation): CanonicalCursor {
  return { timestamp: op.timestamp, deviceId: op.deviceId, seq: op.seq };
}

/** Rebuild an op from its stored row; the same shape the append seam hands in, on every engine. */
function reconstructOperation(row: RawOpRow): SignedOperation {
  return operationFromSignedCoreJcs(row.signedCoreJcs, row);
}

/**
 * Is there any op for this entity that sorts canonically AFTER `op`? True ⇒ `op` arrived
 * out of order (an already-present op is newer) and the engine must re-fold (§4.2); false ⇒
 * `op` is the entity's canonical head and can be applied incrementally. O(1)-indexed via a
 * row-value comparison on `idx_operations_entity_canonical`.
 *
 * Requires `op` to be persisted already (the append/pull path inserts before applying) — it
 * only guards against OTHER newer ops, so a false answer means "op is the max in the log".
 */
export async function hasNewerEntityOp<DB>(
  db: Kysely<DB>,
  op: Pick<SignedOperation, 'entityType' | 'entityId' | 'timestamp' | 'deviceId' | 'seq'>,
): Promise<boolean> {
  const result = await sql<{ one: number }>`
    SELECT 1 AS one FROM operations
    WHERE entity_type = ${op.entityType} AND entity_id = ${op.entityId}
      AND (timestamp_ms, device_id, seq) > (${op.timestamp}, ${op.deviceId}, ${op.seq})
    LIMIT 1
  `.execute(db);
  return result.rows.length > 0;
}

/** Every op for `(entityType, entityId)` in canonical order — the re-fold input (§4.2). */
export async function readEntityOps<DB>(
  db: Kysely<DB>,
  entityType: string,
  entityId: string,
): Promise<SignedOperation[]> {
  return (await readEntitiesOps(db, entityType, [entityId])).get(entityId) ?? [];
}

/** An entity's position in the rebuild walk: `(entityType, entityId)` order (04 §4.3). */
export interface EntityCursor {
  readonly entityType: string;
  readonly entityId: string;
}

/**
 * The next `limit` distinct entities, in `(entityType, entityId)` order strictly AFTER `after` (null =
 * from the start), that have at least one op of `opTypes` in the log. This is the rebuild walk
 * (04 §4.3): the rebuild re-folds entity by entity, checkpointing the last entity of each page.
 */
export async function readEntityPage<DB>(
  db: Kysely<DB>,
  opTypes: readonly string[],
  after: EntityCursor | null,
  limit: number,
): Promise<EntityCursor[]> {
  if (opTypes.length === 0) return [];
  const typeList = sql.join(opTypes.map((t) => sql`${t}`));
  const afterClause =
    after === null
      ? sql``
      : sql`AND (entity_type, entity_id) > (${after.entityType}, ${after.entityId})`;
  const result = await sql<EntityCursor>`
    SELECT DISTINCT entity_type AS "entityType", entity_id AS "entityId" FROM operations
    WHERE type IN (${typeList}) ${afterClause}
    ORDER BY entity_type, entity_id
    LIMIT ${limit}
  `.execute(db);
  return result.rows.map((row) => ({ entityType: row.entityType, entityId: row.entityId }));
}

/**
 * Every op of several entities of one type, grouped by entity id, each group in canonical order: the
 * re-fold input for a batch of entities in one query (§4.2, §4.3).
 */
export async function readEntitiesOps<DB>(
  db: Kysely<DB>,
  entityType: string,
  entityIds: readonly string[],
): Promise<Map<string, SignedOperation[]>> {
  const byEntity = new Map<string, SignedOperation[]>();
  if (entityIds.length === 0) return byEntity;
  const result = await sql<RawOpRow>`
    SELECT ${OP_COLUMNS} FROM operations
    WHERE entity_type = ${entityType} AND entity_id IN (${sql.join(entityIds.map((id) => sql`${id}`))})
    ORDER BY entity_id, timestamp_ms, device_id, seq
  `.execute(db);
  for (const row of result.rows) {
    const op = reconstructOperation(row);
    const ops = byEntity.get(op.entityId);
    if (ops === undefined) byEntity.set(op.entityId, [op]);
    else ops.push(op);
  }
  return byEntity;
}

/**
 * The op-log column the contiguity walk runs over. THE TWO SIDES ARE DIFFERENT COLUMNS HOLDING
 * DIFFERENT NUMBERS (10-db §9.2's table; D20 §4) — not a naming preference:
 *
 *   'server_seq'  — SERVER. The per-tenant acceptance counter (10-db §3/§5), gapless per tenant.
 *   'arrival_seq' — CLIENT. A local, gapless arrival counter assigned at pull-insert (10-db §9.2).
 *                   The client CANNOT store real serverSeqs: its stream is scope-filtered
 *                   (api/01 §4.3), so they are legitimately gappy and would pin the watermark
 *                   below the first other-store op forever.
 *
 * Required, never defaulted, and never inferred from the handle: a default would be right on one
 * side and a silent decoy on the other, which is the whole class this rename removed. Mis-wiring
 * fails LOUDLY — neither schema has the other's column, so the query errors rather than answering
 * wrongly.
 */
export type OpSeqColumn = 'server_seq' | 'arrival_seq';

/**
 * The highest contiguous `column` value present in the log at or above `from`. Returns `from`
 * when `from + 1` is missing — a gap pins the watermark below it until filled (04 §4.3; §5 test
 * 5). The walk terminates at the first hole, so a contiguous pull advances one step per applied
 * op. Both streams it runs over are gapless by construction (10-db §3 server-side; the client
 * arrival counter §9.2), which is what makes "no hole" mean "caught up" rather than "lucky".
 */
export async function highestContiguousSeq<DB>(
  db: Kysely<DB>,
  from: number,
  column: OpSeqColumn,
): Promise<number> {
  // Bounded, ordered scan of everything above the current watermark. Contiguity breaks at
  // the first gap; the loop stops there. `> from` uses the sequence column's own ordering.
  //
  // The result type is `Int8Value`, NOT `number`, because that is what the drivers actually
  // return and a raw-`sql<>` annotation is an ASSERTION the compiler simply believes — it derives
  // nothing and checks nothing at runtime. This one used to read `sql<{ serverSeq: number }>`;
  // the server's `server_seq` is `bigint` (10-db §5) and the real `pg` driver returns int8 as a
  // STRING, so `row.serverSeq === watermark + 1` was `"1" === 1` → false, forever. The walk
  // returned `from` and `applied_server_seq` never advanced in production — silently, since the
  // `>` branch below coerces (`"1" > 1` is false too) and so never fired either. Every test lane
  // ran a driver that hands back numbers, so nothing went red (task 46; testing-guide T-14f).
  // Widening the annotation to the truth is half the fix: it makes the compiler force the
  // normalisation.
  // `AS "seqValue"` — a REAL alias to a camelCase result key with no underscore, so it is inert
  // under both wirings. This line previously read `server_seq AS server_seq`: a NO-OP self-alias
  // that looked like the task-18 hardening but resolved the key ONLY via `CamelCasePlugin` (10-db
  // §11.4). Without the plugin the property was undefined and the walk threw — at task 46's OWN
  // fix site, under a comment all about int8, so the second dimension went unseen (task 74; T-15:
  // a hardened line is not a verified line). The alias binds the key by construction.
  const seq = sql.ref(column);
  const result = await sql<{ seqValue: Int8Value }>`
    SELECT ${seq} AS "seqValue" FROM operations
    WHERE ${seq} > ${from}
    ORDER BY ${seq}
  `.execute(db);

  // The walk itself runs in BIGINT, and narrows exactly once, on the way out.
  //
  // Not a stylistic choice: `server_seq` is bigint server-side, so bigint is the only type in which
  // `===` and `+ 1` are exact over the column's whole range. Narrowing per row would instead make
  // the walk throw on a row it was about to IGNORE — a value past 2^53 sitting beyond a gap is none
  // of this function's business, since contiguity already stopped it. Deciding "is this the next
  // one?" in the column's own arithmetic, and only converting the answer, keeps the range check
  // exactly where the value escapes into JS.
  const label = `operations.${column}`;
  let watermark = int8ToBigInt(from, label);
  for (const row of result.rows) {
    const value = int8ToBigInt(row.seqValue, label);
    if (value === watermark + 1n) {
      watermark = value;
    } else if (value > watermark + 1n) {
      break;
    }
  }
  // The returned watermark is the one value that leaves this function, so this is the one place
  // the 2^53 claim has to hold. It throws rather than round (int8.ts) — a rounded watermark is a
  // wrong watermark returned with no error, which is task 46 again one magnitude up.
  return int8ToNumber(watermark, label);
}
