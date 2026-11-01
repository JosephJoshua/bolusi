// A person store (least-privilege sync, owner decisions 2026-10-31 and 2026-11-01). A device holds
// on disk only what its read set covers. When someone signs in who may read more there, such as an
// owner on the store's counter PC, the rest is pulled for them, folded and shown, and kept in
// memory only for as long as they stay signed in. It is the same model for everyone: the extra is
// what the person may read minus what the device holds, and for most people it is empty.
//
// It reuses the device's sync rather than adding a second one: the same pull wire (a person pull,
// `PullRequest.person`), the same verification against the device's signer list, the same
// projection engine and module appliers, folding into the same table names. The tables are SQLite
// `temp` tables, which live in memory (`temp_store = MEMORY`), are never written to the database
// file, and shadow the device's own (empty) tables of the same name for every query, so module
// queries and rules read them unchanged. The person's log is a `temp` table too.
//
// What makes the shadowing sound is that every projection table is read with one permission (all
// the op types folding into it share it, checked by `projectionTableReads`): the device never folds
// into a table the person store holds, and the person store never into one the device holds.
//
// Dropped on sign-out, switching person, idle lock and app close; nothing to clean up on disk.
import type { PullRequest, PullResponse, SignedOperation } from '@bolusi/schemas';
import { MAX_PULL_LIMIT } from '@bolusi/schemas';
import { sql, type Kysely } from 'kysely';

import type { CryptoPort } from '../crypto/port.js';
import { signedCoreJcsOf } from '../crypto/signed-core.js';
import type { OperationRegistry } from '../module/registry.js';
import { insertOpLogRow } from '../oplog/row.js';
import { readOwnOps } from '../projection/oplog-source.js';
import {
  createPersonProjectionEngine,
  PERSON_OP_TABLE,
  type ProjectionEngine,
} from '../projection/engine.js';
import type { InvalidationBus } from '../projection/invalidation.js';
import type { ProjectionRegistry } from '../projection/registry.js';
import type { ClockPort } from '../runtime/ports.js';
import { readDeviceRegistry } from './devices.js';
import { AppUpdateRequiredError, firstUnknownOp, parsePullResponse } from './pull.js';
import { verifyPulledOp } from './quarantine.js';

/**
 * The permission each projection table is read with: the one read of every op type folding into it
 * (by entity type), or null for a table every device reads. Throws when a table mixes reads, since a
 * person store could then neither hold it nor leave it.
 */
export function projectionTableReads<DB>(
  projections: ProjectionRegistry<DB>,
  operations: Pick<OperationRegistry, 'readPermissionFor' | 'entityTypeFor'>,
): ReadonlyMap<string, string | null> {
  const reads = new Map<string, string | null>();
  for (const module of projections.modules()) {
    for (const [table, manifest] of Object.entries(module.tables)) {
      const found = new Set<string | null>();
      for (const type of Object.keys(module.appliers)) {
        if (operations.entityTypeFor(type) !== manifest.entityType) continue;
        const read = operations.readPermissionFor(type);
        found.add(typeof read === 'string' ? read : null);
      }
      if (found.size > 1) {
        throw new Error(
          `projection table ${table} is folded from op types read with different permissions ` +
            `(${[...found].join(', ')}): give each read its own table`,
        );
      }
      reads.set(table, found.values().next().value ?? null);
    }
  }
  return reads;
}

/** The person pull's wire: `POST /v1/sync/pull` with `person: true` and the person's session. */
export interface PersonPullPort {
  pull(request: PullRequest): Promise<PullResponse>;
}

export interface PersonStoreDeps<DB> {
  readonly db: Kysely<DB>;
  readonly transaction: <T>(fn: () => Promise<T>) => Promise<T>;
  readonly crypto: CryptoPort;
  readonly clock: ClockPort;
  readonly projections: ProjectionRegistry<DB>;
  readonly operations: Pick<OperationRegistry, 'readPermissionFor' | 'entityTypeFor' | 'types'>;
  /** The device's bus: a screen showing a held table refreshes as the store fills and empties. */
  readonly invalidation: InvalidationBus;
  /** Can this build fold `op`? As the device's pull: a newer op stops the pull, see there. */
  readonly knowsOp?: (op: Pick<SignedOperation, 'type' | 'schemaVersion'>) => boolean;
  readonly limit?: number;
  /**
   * Whether the device itself now holds a read (its read set grew since the server named this
   * person's extra). Such a read stays the device's: shadowing it would hide the device's rows.
   */
  readonly deviceHolds?: (read: string) => boolean;
}

/**
 * How a person pull ended. `reopen`: what the person may read here changed (a role edit), so the
 * store must start over with `reads`.
 */
export type PersonPullOutcome =
  { readonly kind: 'current' } | { readonly kind: 'reopen'; readonly reads: readonly string[] };

const CURRENT: PersonPullOutcome = { kind: 'current' };

/**
 * A signed-in person's store. Open it with what they may read beyond the device (the server says,
 * on the person session), pull it, and close it when they leave.
 */
export class PersonStore<DB> {
  private cursor = 0;
  private nextArrival = 1;
  private unverified: SignedOperation[] = [];
  private closed = false;

  private constructor(
    private readonly deps: PersonStoreDeps<DB>,
    /** The read permissions this store holds. */
    readonly reads: readonly string[],
    /** The tables it holds, shadowing the device's. */
    readonly tables: readonly string[],
    private readonly engine: ProjectionEngine<DB>,
  ) {}

  /**
   * Create the store's in-memory tables. Holds nothing, and creates nothing, for an empty extra.
   * What it holds is settled inside its transaction: reads the device has come to hold itself are
   * left to the device (`deviceHolds`), and tables left over from an earlier store go first.
   */
  static async open<DB>(
    deps: PersonStoreDeps<DB>,
    reads: readonly string[],
  ): Promise<PersonStore<DB>> {
    const tableReads = projectionTableReads(deps.projections, deps.operations);
    return deps.transaction(async () => {
      await dropPersonStoreTables(deps.db);
      const wanted = new Set(reads.filter((read) => deps.deviceHolds?.(read) !== true));
      const tables = [...tableReads]
        .filter(([, read]) => read !== null && wanted.has(read))
        .map(([table]) => table);
      const folds = (type: string): boolean => {
        const read = deps.operations.readPermissionFor(type);
        return typeof read === 'string' && wanted.has(read);
      };
      const engine = createPersonProjectionEngine(deps.db, deps.projections, {
        invalidation: deps.invalidation,
        folds,
      });
      const store = new PersonStore(deps, [...wanted].sort(), tables, engine);
      if (tables.length > 0) {
        await copyTable(deps.db, 'operations', PERSON_OP_TABLE);
        for (const table of tables) await copyTable(deps.db, table, table);
        // The person's own changes on this device fold at once, sent or not: the server may not
        // have them yet, and a lock and unlock must not hide them.
        const types = deps.operations.types().filter(folds);
        for (const op of await readOwnOps(deps.db, types)) await store.fold(op, 'append');
      }
      return store;
    });
  }

  /** Whether this store folds `type`: a type read with one of its permissions. */
  folds(type: string): boolean {
    const read = this.deps.operations.readPermissionFor(type);
    return !this.closed && typeof read === 'string' && this.reads.includes(read);
  }

  /** Whether the store holds anything: an empty extra needs no pull and holds no table. */
  get holds(): boolean {
    return this.tables.length > 0;
  }

  /**
   * Pull until current. Each page verifies against the device's signer list and folds in one
   * transaction, like the device's own pull. An op whose signer the device does not know yet waits
   * in memory and is tried again on the next pull, after the device's own pull refreshed the list.
   */
  async pull(port: PersonPullPort): Promise<PersonPullOutcome> {
    if (!this.holds || this.closed) return CURRENT;
    await this.retryUnverified();
    for (;;) {
      const response = await port.pull({
        cursor: this.cursor,
        limit: this.deps.limit ?? MAX_PULL_LIMIT,
        devicesDirectoryVersion: 0,
        person: true,
      });
      const parsed = parsePullResponse(response);
      const reads = parsed.envelope.readSet ?? [];
      if (!sameReads(reads, this.reads)) return { kind: 'reopen', reads };
      const unknown =
        this.deps.knowsOp === undefined ? undefined : firstUnknownOp(parsed.ops, this.deps.knowsOp);
      if (unknown !== undefined)
        throw new AppUpdateRequiredError(unknown.type, unknown.schemaVersion);
      await this.deps.transaction(async () => {
        // Checked inside the transaction: once the store closed, its tables are gone and the
        // same names are the device's own, which must never receive the person's rows.
        if (this.closed) return;
        const signers = await readDeviceRegistry(this.deps.db);
        for (const entry of parsed.ops) {
          // An op that does not parse cannot be verified or identified; it is skipped, as the
          // device's pull drops it, and the cursor moves past it.
          if (!entry.ok) continue;
          const verification = verifyPulledOp(entry.op, signers, this.deps.crypto);
          if (!verification.ok) {
            if (verification.reason === 'unknown_pubkey') this.unverified.push(entry.op);
            continue;
          }
          await this.fold(entry.op, 'pull');
        }
      });
      if (this.closed) return CURRENT;
      this.cursor = parsed.envelope.nextCursor;
      if (!parsed.envelope.hasMore) return CURRENT;
    }
  }

  /**
   * Fold one of this device's own new changes of a type the store holds, inside the append's
   * transaction: the person sees it at once. The device's log keeps it for the chain and the push.
   */
  async applyAppended(op: SignedOperation): Promise<void> {
    if (!this.folds(op.type)) return;
    await this.fold(op, 'append');
  }

  /** A change the server refused never happened: take it back out of the record it changed. */
  async refuse(
    op: Pick<SignedOperation, 'id' | 'type' | 'entityType' | 'entityId'>,
  ): Promise<void> {
    if (!this.folds(op.type)) return;
    await sql`
      UPDATE ${sql.table(PERSON_OP_TABLE)} SET sync_status = 'rejected' WHERE id = ${op.id}
    `.execute(this.deps.db);
    await this.engine.refoldEntityOf(op);
  }

  /**
   * Drop the store: its tables and log go, and screens on them refresh to the device's own.
   * `withinTransaction`: the caller already holds the connection's transaction (a device pull that
   * is about to fold into these table names), so no second one is opened.
   */
  async close(options: { readonly withinTransaction?: boolean } = {}): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!this.holds) return;
    const drop = async (): Promise<void> => {
      for (const table of [PERSON_OP_TABLE, ...this.tables]) {
        await sql`DROP TABLE IF EXISTS ${sql.table(`temp.${table}`)}`.execute(this.deps.db);
      }
    };
    if (options.withinTransaction === true) await drop();
    else await this.deps.transaction(drop);
    this.deps.invalidation.emit(new Set(this.tables));
  }

  private async fold(op: SignedOperation, source: 'pull' | 'append'): Promise<void> {
    if (this.closed) return;
    const present = await sql<{ one: number }>`
      SELECT 1 AS one FROM ${sql.table(PERSON_OP_TABLE)} WHERE id = ${op.id} LIMIT 1
    `.execute(this.deps.db);
    if (present.rows.length > 0) return;
    await insertOpLogRow(
      this.deps.db,
      { op, signedCoreJcs: signedCoreJcsOf(op, this.deps.crypto) },
      source === 'pull'
        ? { syncStatus: 'synced', syncedAt: this.deps.clock.now(), arrivalSeq: this.nextArrival++ }
        : { syncStatus: 'local', syncedAt: null, arrivalSeq: null },
      PERSON_OP_TABLE,
    );
    if (source === 'pull') await this.engine.applyPulledOp(op);
    else await this.engine.applyAppendedOp(op);
  }

  private async retryUnverified(): Promise<void> {
    if (this.unverified.length === 0) return;
    const waiting = this.unverified;
    this.unverified = [];
    await this.deps.transaction(async () => {
      if (this.closed) return;
      const signers = await readDeviceRegistry(this.deps.db);
      for (const op of waiting) {
        const verification = verifyPulledOp(op, signers, this.deps.crypto);
        if (verification.ok) await this.fold(op, 'pull');
        else if (verification.reason === 'unknown_pubkey') this.unverified.push(op);
      }
    });
  }
}

function sameReads(readSet: readonly string[], reads: readonly string[]): boolean {
  return [...readSet].sort().join('\n') === reads.join('\n');
}

/**
 * Create `temp.<to>` with the columns and indexes of the device's `main.<from>`, so the store's
 * rows have exactly the shape the device's appliers and queries expect.
 */
async function copyTable<DB>(db: Kysely<DB>, from: string, to: string): Promise<void> {
  const definition = await sql<{ type: string; name: string; sql: string | null }>`
    SELECT type, name, sql FROM main.sqlite_master
    WHERE tbl_name = ${from} AND type IN ('table', 'index') AND sql IS NOT NULL
    ORDER BY type = 'index', name
  `.execute(db);
  const table = definition.rows.find((row) => row.type === 'table');
  if (table?.sql == null) throw new Error(`person store: no table ${from} to copy`);
  await sql.raw(retarget(table.sql, 'TABLE', from, `temp.${quote(to)}`)).execute(db);
  for (const index of definition.rows) {
    if (index.type !== 'index' || index.sql === null) continue;
    const named = retarget(index.sql, 'INDEX', index.name, `temp.${quote(`person_${index.name}`)}`);
    await sql.raw(onTable(named, from, quote(to))).execute(db);
  }
}

const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** `CREATE [UNIQUE] <kind> <name>` with the name replaced. */
function retarget(ddl: string, kind: 'TABLE' | 'INDEX', name: string, replacement: string): string {
  const pattern = new RegExp(
    `^(\\s*CREATE\\s+(?:UNIQUE\\s+)?${kind}\\s+)(?:"${escape(name)}"|${escape(name)}|\\[${escape(name)}\\]|\`${escape(name)}\`)`,
    'i',
  );
  if (!pattern.test(ddl))
    throw new Error(`person store: unexpected ${kind} definition for ${name}`);
  return ddl.replace(pattern, `$1${replacement}`);
}

/** An index definition's `ON <table>` pointed at the copy. */
function onTable(ddl: string, from: string, to: string): string {
  const pattern = new RegExp(`(\\sON\\s+)(?:"${escape(from)}"|${escape(from)})(\\s*\\()`, 'i');
  if (!pattern.test(ddl)) throw new Error(`person store: unexpected index definition on ${from}`);
  return ddl.replace(pattern, `$1${to}$2`);
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Drop every person-store table (the only temp tables a device has). Safe to repeat, and safe
 * inside a caller's transaction: a device pull about to fold into names a person store shadows
 * calls it there, so a rollback and retry drops them again.
 */
export async function dropPersonStoreTables<DB>(db: Kysely<DB>): Promise<boolean> {
  const tables = await sql<{ name: string }>`
    SELECT name FROM temp.sqlite_master WHERE type = 'table'
  `.execute(db);
  for (const { name } of tables.rows) {
    await sql`DROP TABLE IF EXISTS ${sql.table(`temp.${name}`)}`.execute(db);
  }
  return tables.rows.length > 0;
}
