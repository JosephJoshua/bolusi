// `SyncState` persistence (01-domain-model §5.2; DDL 10-db §9.3) + the derived pending counts.
//
// WHY RAW `sql` AND A `Kysely<DB>` GENERIC. @bolusi/core may not import @bolusi/db-client (08 §3.3),
// so it cannot name `ClientDatabase` and cannot get typed table access to `sync_state`. The house
// pattern for exactly this is `projection/watermarks.ts` and `projection/oplog-source.ts`: stay
// generic over `DB`, address the columns 10-db owns through typed `sql` templates. Same shape here
// rather than a fourth invention (CLAUDE.md §2.8).
//
// THE ROW ALWAYS EXISTS. 10-db §9.3 seeds `INSERT INTO sync_state (id) VALUES (1)` in the initial
// migration, and the PK is `CHECK (id = 1)`. So this module is UPDATE-only: no upsert, no
// create-if-missing. A missing row is a broken migration, not a state to paper over — `readSyncState`
// throws rather than returning defaults, because silently substituting `cursor: 0` would re-pull the
// world and look like a sync bug rather than a schema bug.
import { sql, type Kysely } from 'kysely';

import type { StalenessInput } from './staleness.js';

/** `SyncState` as the loop reads it (01 §5.2). Booleans are real booleans here; 0/1 is a SQLite detail. */
export interface SyncState extends StalenessInput {
  /** Opaque server pull cursor (= last applied `serverSeq`). Never do arithmetic on it (api/00 §10). */
  readonly cursor: number;
  readonly devicesDirectoryVersion: number;
  readonly lastSuccessfulSyncAt: number | null;
  readonly lastPushAt: number | null;
  readonly lastPullAt: number | null;
  readonly lastServerTime: number | null;
  readonly lastServerTimeReceivedAt: number | null;
  /** Set by `CHAIN_BROKEN` (05 §8); push stays halted until repaired (03 §10). */
  readonly pushHalted: boolean;
  /** Set by `DEVICE_REVOKED`; all sync stops (03 §10). */
  readonly syncDisabled: boolean;
  readonly syncDisabledReason: string | null;
  /** Last failure, as a label-catalog code (01 §5.2). */
  readonly lastSyncError: string | null;
  readonly backoffUntil: number | null;
}

/** A partial update. Every key is optional; absent keys are left untouched. */
export type SyncStatePatch = Partial<{
  [K in keyof SyncState]: SyncState[K];
}>;

interface SyncStateRow {
  readonly pullCursor: number;
  readonly devicesDirectoryVersion: number;
  readonly lastSuccessfulSyncAt: number | null;
  readonly lastPushAt: number | null;
  readonly lastPullAt: number | null;
  readonly lastServerTime: number | null;
  readonly lastServerTimeReceivedAt: number | null;
  readonly lastSyncError: string | null;
  readonly backoffUntil: number | null;
  readonly pushHalted: number;
  readonly syncDisabled: number;
  readonly syncDisabledReason: string | null;
}

/** Read the singleton (10-db §9.3). @throws {Error} when the seeded row is absent. */
export async function readSyncState<DB>(db: Kysely<DB>): Promise<SyncState> {
  const result = await sql<SyncStateRow>`
    SELECT pull_cursor, devices_directory_version, last_successful_sync_at, last_push_at,
           last_pull_at, last_server_time, last_server_time_received_at, last_sync_error,
           backoff_until, push_halted, sync_disabled, sync_disabled_reason
    FROM sync_state WHERE id = 1
  `.execute(db);
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(
      'sync_state row id=1 is missing — the 10-db §9.3 migration seeds it; this is a schema failure, not an empty state',
    );
  }
  return {
    cursor: Number(row.pullCursor),
    devicesDirectoryVersion: Number(row.devicesDirectoryVersion),
    lastSuccessfulSyncAt: nullableNumber(row.lastSuccessfulSyncAt),
    lastPushAt: nullableNumber(row.lastPushAt),
    lastPullAt: nullableNumber(row.lastPullAt),
    lastServerTime: nullableNumber(row.lastServerTime),
    lastServerTimeReceivedAt: nullableNumber(row.lastServerTimeReceivedAt),
    pushHalted: row.pushHalted !== 0,
    syncDisabled: row.syncDisabled !== 0,
    syncDisabledReason: row.syncDisabledReason,
    lastSyncError: row.lastSyncError,
    backoffUntil: nullableNumber(row.backoffUntil),
  };
}

const nullableNumber = (value: number | null): number | null =>
  value === null ? null : Number(value);

/**
 * Patch the singleton. Only the named columns are written, so two writers touching disjoint
 * fields cannot clobber each other's values by round-tripping a whole row.
 *
 * The column list is exhaustive over `SyncStatePatch` by construction: each entry maps one
 * `SyncState` key to its 10-db §9.3 column, and TypeScript's `Record<keyof SyncState, ...>`
 * makes a new field a COMPILE error here rather than a silently-dropped write.
 */
const COLUMNS: Record<keyof SyncState, string> = {
  cursor: 'pull_cursor',
  devicesDirectoryVersion: 'devices_directory_version',
  lastSuccessfulSyncAt: 'last_successful_sync_at',
  lastPushAt: 'last_push_at',
  lastPullAt: 'last_pull_at',
  lastServerTime: 'last_server_time',
  lastServerTimeReceivedAt: 'last_server_time_received_at',
  pushHalted: 'push_halted',
  syncDisabled: 'sync_disabled',
  syncDisabledReason: 'sync_disabled_reason',
  lastSyncError: 'last_sync_error',
  backoffUntil: 'backoff_until',
};

export async function writeSyncState<DB>(db: Kysely<DB>, patch: SyncStatePatch): Promise<void> {
  const assignments = Object.entries(patch)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => {
      const column = COLUMNS[key as keyof SyncState];
      const encoded =
        typeof value === 'boolean' ? (value ? 1 : 0) : (value as number | string | null);
      return sql`${sql.raw(column)} = ${encoded}`;
    });
  if (assignments.length === 0) return;
  await sql`UPDATE sync_state SET ${sql.join(assignments, sql`, `)} WHERE id = 1`.execute(db);
}

/**
 * `pendingOperationCount` = `count(syncStatus = 'local')` (01 §5.2).
 *
 * DERIVED, NEVER STORED — 01 §5.2 is explicit ("stored derivables drift"), so this is a query and
 * there is deliberately no column to write. The loop recomputes it at drain (03 §10); nothing
 * caches it.
 */
export async function pendingOperationCount<DB>(db: Kysely<DB>): Promise<number> {
  const result = await sql<{ c: number }>`
    SELECT COUNT(*) AS c FROM operations WHERE sync_status = 'local'
  `.execute(db);
  return Number(result.rows[0]?.c ?? 0);
}

/**
 * `pendingMediaCount` (01 §5.2, formula owned by 06-media-pipeline §4):
 * `count(attachedToOperationId != null AND uploadStatus IN ('pending','uploading','failed'))`.
 * Orphans (unattached captures) do NOT count — they are not pending work, they are debris.
 */
export async function pendingMediaCount<DB>(db: Kysely<DB>): Promise<number> {
  const result = await sql<{ c: number }>`
    SELECT COUNT(*) AS c FROM media_items
    WHERE attached_to_operation_id IS NOT NULL
      AND upload_status IN ('pending', 'uploading', 'failed')
  `.execute(db);
  return Number(result.rows[0]?.c ?? 0);
}
