// Reading the op log for the projection engine (10-db §9.2 `idx_operations_entity_canonical`).
//
// The engine folds the operation log into projections, so it reads `operations` directly
// through the injected `ProjectionDb` — the op log lives in the SAME database (client
// SQLite or server Postgres). Every read is dialect-neutral raw `sql` over the verbatim
// snake_case columns (10-db §2); CamelCasePlugin rewrites RESULT keys to camelCase (it does
// not touch identifiers inside a raw fragment), so rows come back keyed camelCase.
//
// Canonical order is `(timestamp ASC, deviceId ASC, seq ASC)` (05 §4). We sort in SQL here
// (unlike the oracle, which sorts in JS): the ordering columns are `timestamp_ms` (integer),
// `device_id` and `seq` — and `device_id` is a lowercase-hex UUID whose BINARY/bytewise
// collation equals the canonical `deviceId ASC` on every engine (10-db §2), so the index
// order and `compareCanonicalOrder` agree. `oplog-source.test.ts` falsifies that assumption
// by cross-checking SQL order against the shared comparator.
import { sql, type Kysely } from 'kysely';

import type { Location, SignedOperation } from '@bolusi/schemas';

import {
  boolColumnToBoolean,
  jsonColumnToObject,
  type BoolColumnValue,
  type JsonColumnValue,
} from './columns.js';
import { int8ToBigInt, int8ToNumber, type Int8Value } from './int8.js';

/** A canonical-order position (05 §4) — the rebuild checkpoint triple (04 §4.3). */
export interface CanonicalCursor {
  readonly timestamp: number;
  readonly deviceId: string;
  readonly seq: number;
}

/**
 * The op-log columns a projection read needs, keyed camelCase (CamelCasePlugin result keys).
 *
 * THESE TYPES ARE THE DRIVERS' TRUTH, NOT THE ENVELOPE'S (task 48). `RawOpRow` annotates a raw
 * `sql<>` result, and such an annotation is an ASSERTION the compiler simply believes — it derives
 * nothing and checks nothing at runtime. This interface used to describe the CLIENT's marshalling
 * (`seq: number`, `payload: string`, `agentInitiated: number`) while the same rows on the server
 * arrive as int8 strings, parsed jsonb and real booleans (10-db §3). `tsc` believed the assertion,
 * so three separate production bugs typechecked clean and no lane could see them (T-14f).
 *
 * kysely-codegen had already derived the truth from the live schema — `db.d.ts` says `seq: Int8`
 * (`= ColumnType<string, …>`), `payload: Json`, `agentInitiated: Generated<boolean>`. The answer
 * was in the repo the whole time and a hand-written assertion overrode it. So each field below is
 * now the UNION the drivers actually produce, which makes the compiler force the normalisation
 * rather than take our word for it.
 */
interface RawOpRow {
  id: string;
  tenantId: string;
  storeId: string | null;
  userId: string;
  deviceId: string;
  /** `bigint` column: STRING on real `pg`, `number` on SQLite/PGlite. `"10" < "9"` is the bug. */
  seq: Int8Value;
  type: string;
  entityType: string;
  entityId: string;
  schemaVersion: number;
  /** `jsonb` server-side (already parsed), TEXT client-side (JSON string). */
  payload: JsonColumnValue;
  /** `bigint` column, same as `seq`. */
  timestampMs: Int8Value;
  location: JsonColumnValue | null;
  source: string;
  /** `boolean` server-side, `0`/`1` client-side. `false !== 0` is the bug. */
  agentInitiated: BoolColumnValue;
  agentConversationId: string | null;
  previousHash: string;
  hash: string;
  signature: string;
}

/** The verbatim column list read for reconstruction, in a stable order. */
const OP_COLUMNS = sql`
  id, tenant_id, store_id, user_id, device_id, seq, type, entity_type, entity_id,
  schema_version, payload, timestamp_ms, location, source, agent_initiated,
  agent_conversation_id, previous_hash, hash, signature
`;

/** The canonical `(timestamp, deviceId, seq)` position of an op. */
export function cursorOf(op: SignedOperation): CanonicalCursor {
  return { timestamp: op.timestamp, deviceId: op.deviceId, seq: op.seq };
}

/**
 * Rebuild a `SignedOperation` from a stored op-log row: decode `payload`/`location` JSON, map
 * `timestamp_ms → timestamp`, narrow the int8 counters, and normalise `agent_initiated`.
 *
 * The result is structurally identical to the object the append seam hands in — so an applier sees
 * one op shape regardless of whether it came head-first or through a re-fold, AND regardless of
 * which driver opened the connection. That second half is the whole point of the three seams below
 * (task 48): this function is the ONE boundary where a stored row becomes an envelope, so it is
 * the one place the drivers' differences are allowed to exist. Past it, `SignedOperation` means
 * what `zSignedOperation` says it means (05 §2.1) — `seq`/`timestamp` are numbers, `payload` and
 * `location` are objects, `agentInitiated` is a boolean — on every engine.
 *
 * Each field goes through the shared normaliser for its COLUMN CLASS rather than an inline cast.
 * Task 46's finding, quoted because it is the reason this file looks like this: "one function had
 * the cast, the neighbour twelve lines away didn't" — which is exactly how `seq`, `payload` and
 * `agent_initiated` came to be wrong in three different ways inside one 20-line function
 * (CLAUDE.md §2.8).
 */
function reconstructOperation(row: RawOpRow): SignedOperation {
  return {
    id: row.id,
    tenantId: row.tenantId,
    storeId: row.storeId,
    userId: row.userId,
    deviceId: row.deviceId,
    // Narrowed HERE, at the exit, because here is where the value escapes into JS: `seq` is
    // `z.number().int()` in the envelope, and every consumer past this line does arithmetic and
    // `<`/`>` on it. `int8ToNumber` throws past 2^53 rather than round (int8.ts) — a rounded `seq`
    // is a wrong `seq` returned with no error, and `seq` is a canonical-order key.
    seq: int8ToNumber(row.seq, 'operations.seq'),
    type: row.type,
    entityType: row.entityType,
    entityId: row.entityId,
    schemaVersion: row.schemaVersion,
    payload: jsonColumnToObject(row.payload, 'operations.payload') as SignedOperation['payload'],
    timestamp: int8ToNumber(row.timestampMs, 'operations.timestamp_ms'),
    location:
      row.location === null
        ? null
        : (jsonColumnToObject(row.location, 'operations.location') as Location),
    source: row.source as SignedOperation['source'],
    agentInitiated: boolColumnToBoolean(row.agentInitiated, 'operations.agent_initiated'),
    agentConversationId: row.agentConversationId,
    previousHash: row.previousHash,
    hash: row.hash,
    signature: row.signature,
  };
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
  const result = await sql<RawOpRow>`
    SELECT ${OP_COLUMNS} FROM operations
    WHERE entity_type = ${entityType} AND entity_id = ${entityId}
    ORDER BY timestamp_ms, device_id, seq
  `.execute(db);
  return result.rows.map(reconstructOperation);
}

/**
 * One canonical-order page of the whole log restricted to `opTypes`, strictly AFTER `after`
 * (null = from the start). This is the rebuild scan (04 §4.3): iterate the canonical index,
 * apply each op (all head-case, since canonical order means each is newest-so-far for its
 * entity), checkpointing `after` per page so an interrupted rebuild resumes without
 * re-applying anything at or below the cursor.
 */
export async function readCanonicalPage<DB>(
  db: Kysely<DB>,
  opTypes: readonly string[],
  after: CanonicalCursor | null,
  limit: number,
): Promise<SignedOperation[]> {
  if (opTypes.length === 0) return [];
  const typeList = sql.join(opTypes.map((t) => sql`${t}`));
  const query =
    after === null
      ? sql<RawOpRow>`
          SELECT ${OP_COLUMNS} FROM operations
          WHERE type IN (${typeList})
          ORDER BY timestamp_ms, device_id, seq
          LIMIT ${limit}
        `
      : sql<RawOpRow>`
          SELECT ${OP_COLUMNS} FROM operations
          WHERE type IN (${typeList})
            AND (timestamp_ms, device_id, seq) > (${after.timestamp}, ${after.deviceId}, ${after.seq})
          ORDER BY timestamp_ms, device_id, seq
          LIMIT ${limit}
        `;
  const result = await query.execute(db);
  return result.rows.map(reconstructOperation);
}

/**
 * The highest contiguous `server_seq` present in the log at or above `from`, walking the
 * global stream (10-db §3 gapless per tenant). Returns `from` when `from + 1` is missing —
 * a gap pins the watermark below it until filled (04 §4.3; §5 test 5). The walk terminates
 * at the first hole, so a contiguous pull advances one step per applied op.
 */
export async function highestContiguousServerSeq<DB>(
  db: Kysely<DB>,
  from: number,
): Promise<number> {
  // Bounded, ordered scan of everything above the current watermark. Contiguity breaks at
  // the first gap; the loop stops there. `> from` uses the (server_seq) column ordering.
  //
  // The result type is `Int8Value`, NOT `number`, because that is what the drivers actually
  // return and a raw-`sql<>` annotation is an ASSERTION the compiler simply believes — it derives
  // nothing and checks nothing at runtime. This one used to read `sql<{ serverSeq: number }>`;
  // `server_seq` is `bigint` (10-db §5) and the real `pg` driver returns int8 as a STRING, so
  // `row.serverSeq === watermark + 1` was `"1" === 1` → false, forever. The walk returned `from`
  // and `applied_server_seq` never advanced in production — silently, since the `>` branch below
  // coerces (`"1" > 1` is false too) and so never fired either. Every test lane ran a driver that
  // hands back numbers, so nothing went red (task 46; testing-guide T-14f). Widening the
  // annotation to the truth is half the fix: it makes the compiler force the normalisation.
  const result = await sql<{ serverSeq: Int8Value }>`
    SELECT server_seq AS server_seq FROM operations
    WHERE server_seq > ${from}
    ORDER BY server_seq
  `.execute(db);

  // The walk itself runs in BIGINT, and narrows exactly once, on the way out.
  //
  // Not a stylistic choice: `server_seq` is bigint, so bigint is the only type in which `===` and
  // `+ 1` are exact over the column's whole range. Narrowing per row would instead make the walk
  // throw on a row it was about to IGNORE — a value past 2^53 sitting beyond a gap is none of this
  // function's business, since contiguity already stopped it. Deciding "is this the next one?" in
  // the column's own arithmetic, and only converting the answer, keeps the range check exactly
  // where the value escapes into JS.
  let watermark = int8ToBigInt(from, 'operations.server_seq');
  for (const row of result.rows) {
    const serverSeq = int8ToBigInt(row.serverSeq, 'operations.server_seq');
    if (serverSeq === watermark + 1n) {
      watermark = serverSeq;
    } else if (serverSeq > watermark + 1n) {
      break;
    }
  }
  // The returned watermark is the one value that leaves this function, so this is the one place
  // the 2^53 claim has to hold. It throws rather than round (int8.ts) — a rounded watermark is a
  // wrong watermark returned with no error, which is task 46 again one magnitude up.
  return int8ToNumber(watermark, 'operations.server_seq');
}
