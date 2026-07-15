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

/** A canonical-order position (05 §4) — the rebuild checkpoint triple (04 §4.3). */
export interface CanonicalCursor {
  readonly timestamp: number;
  readonly deviceId: string;
  readonly seq: number;
}

/** The op-log columns a projection read needs, keyed camelCase (CamelCasePlugin result keys). */
interface RawOpRow {
  id: string;
  tenantId: string;
  storeId: string | null;
  userId: string;
  deviceId: string;
  seq: number;
  type: string;
  entityType: string;
  entityId: string;
  schemaVersion: number;
  payload: string;
  timestampMs: number;
  location: string | null;
  source: string;
  agentInitiated: number;
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
 * Rebuild a `SignedOperation` from a stored op-log row: decode `payload`/`location` JSON,
 * map `timestamp_ms → timestamp`, and coerce the SQLite 0/1 `agent_initiated` to boolean.
 * The result is structurally identical to the object the append seam hands in, so an applier
 * sees one op shape regardless of whether it came head-first or through a re-fold.
 */
function reconstructOperation(row: RawOpRow): SignedOperation {
  return {
    id: row.id,
    tenantId: row.tenantId,
    storeId: row.storeId,
    userId: row.userId,
    deviceId: row.deviceId,
    seq: row.seq,
    type: row.type,
    entityType: row.entityType,
    entityId: row.entityId,
    schemaVersion: row.schemaVersion,
    payload: JSON.parse(row.payload) as SignedOperation['payload'],
    timestamp: row.timestampMs,
    location: row.location === null ? null : (JSON.parse(row.location) as Location),
    source: row.source as SignedOperation['source'],
    agentInitiated: row.agentInitiated !== 0,
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
  let watermark = from;
  // Bounded, ordered scan of everything above the current watermark. Contiguity breaks at
  // the first gap; the loop stops there. `> from` uses the (server_seq) column ordering.
  const result = await sql<{ serverSeq: number }>`
    SELECT server_seq AS server_seq FROM operations
    WHERE server_seq > ${from}
    ORDER BY server_seq
  `.execute(db);
  for (const row of result.rows) {
    if (row.serverSeq === watermark + 1) {
      watermark = row.serverSeq;
    } else if (row.serverSeq > watermark + 1) {
      break;
    }
  }
  return watermark;
}
