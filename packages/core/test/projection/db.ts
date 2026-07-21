// Projection-engine test harness: a real SQLite DB behind the shim dialect (testing-guide
// §2.3), the client migrations (10-db §9), and the op-insert + apply pipeline the append/pull
// paths model. Every helper here is the FAITHFUL insert-then-apply discipline the engine
// assumes (05 §5 dedup at insert; op persisted before apply), so the tests drive the real
// engine, never a re-implementation of it (T-7).
import { CamelCasePlugin, Kysely, sql } from 'kysely';

import {
  createClientDialect,
  runClientMigrations,
  type ClientDatabase,
  type DbDriver,
} from '@bolusi/db-client';
import type { SignedOperation } from '@bolusi/schemas';
import { noblePort } from '@bolusi/test-support';

import {
  createProjectionEngine,
  digestModule,
  ProjectionRegistry,
  type ModuleProjectionManifest,
  type ProjectionEngine,
} from '../../src/index.js';
import { openMemoryDriver } from './better-sqlite3-driver.js';
import { notesModule, type GeneratedOp } from './notes-fixture.js';

/** The oracle's SHA-256 (real crypto via the noble CryptoPort — testing-guide §2.1 L1/L2). */
export const sha256 = (data: Uint8Array): Uint8Array => noblePort.sha256(data);

export interface ProjectionHarness {
  readonly db: Kysely<ClientDatabase>;
  /** The raw driver, for a driver-level transaction that the engine's `db` shares (append model). */
  readonly driver: DbDriver;
  readonly engine: ProjectionEngine<ClientDatabase>;
  readonly registry: ProjectionRegistry<ClientDatabase>;
  digest(module?: ModuleProjectionManifest<ClientDatabase>): Promise<string>;
  close(): Promise<void>;
}

/**
 * Run `fn` inside a driver-level transaction — the SAME shape as the append path's store
 * transaction (04 §5.1): the engine's `db` and the raw `driver` share one connection, so an
 * apply inside `fn` participates and a throw rolls the whole op back. Rethrows after rollback.
 */
export async function runInTransaction<T>(
  harness: ProjectionHarness,
  fn: () => Promise<T>,
): Promise<T> {
  await harness.driver.begin();
  try {
    const result = await fn();
    await harness.driver.commit();
    return result;
  } catch (error) {
    await harness.driver.rollback();
    throw error;
  }
}

/** Open a fresh in-memory harness with the given modules registered (default: `notes`). */
export async function openProjectionHarness(
  modules: readonly ModuleProjectionManifest<ClientDatabase>[] = [notesModule],
): Promise<ProjectionHarness> {
  const driver = openMemoryDriver();
  await runClientMigrations(driver, { now: () => 1 });
  const db = new Kysely<ClientDatabase>({
    dialect: createClientDialect(driver),
    plugins: [new CamelCasePlugin({ underscoreBetweenUppercaseLetters: true })],
  });
  const registry = new ProjectionRegistry<ClientDatabase>();
  for (const module of modules) registry.register(module);
  const engine = createProjectionEngine(db, registry);

  return {
    db,
    driver,
    engine,
    registry,
    digest: (module = notesModule) => digestModule(db, module, { hash: sha256 }),
    close: async () => {
      await db.destroy();
      await driver.close();
    },
  };
}

/** Insert one op row into the op log (the caller's job before apply). `arrivalSeq` null = local. */
export async function insertOpRow(
  db: Kysely<ClientDatabase>,
  op: SignedOperation,
  arrivalSeq: number | null,
): Promise<void> {
  await db
    .insertInto('operations')
    .values({
      id: op.id,
      tenantId: op.tenantId,
      storeId: op.storeId,
      userId: op.userId,
      deviceId: op.deviceId,
      seq: op.seq,
      type: op.type,
      entityType: op.entityType,
      entityId: op.entityId,
      schemaVersion: op.schemaVersion,
      payload: JSON.stringify(op.payload),
      timestampMs: op.timestamp,
      location: op.location === null ? null : JSON.stringify(op.location),
      source: op.source,
      agentInitiated: op.agentInitiated ? 1 : 0,
      agentConversationId: op.agentConversationId,
      previousHash: op.previousHash,
      hash: op.hash,
      signature: op.signature,
      // Not verified by the projection engine (that is the sync layer's job) — a placeholder
      // satisfying the NOT NULL column. Distinct per op so no accidental collision hides a bug.
      signedCoreJcs: `test-jcs:${op.id}`,
      syncStatus: arrivalSeq === null ? 'local' : 'synced',
      arrivalSeq,
      syncedAt: arrivalSeq === null ? null : 1,
    })
    .execute();
}

/** True if an op `id` already exists locally (the pull/append dedup key, 05 §5). */
export async function hasOpId(db: Kysely<ClientDatabase>, id: string): Promise<boolean> {
  const result = await sql<{
    one: number;
  }>`SELECT 1 AS one FROM operations WHERE id = ${id} LIMIT 1`.execute(db);
  return result.rows.length > 0;
}

async function nextArrivalSeq(db: Kysely<ClientDatabase>): Promise<number> {
  const result = await sql<{ maxSeq: number | null }>`
    SELECT MAX(arrival_seq) AS max_seq FROM operations
  `.execute(db);
  return (result.rows[0]?.maxSeq ?? 0) + 1;
}

/**
 * Deliver ops through the PULL path in the given arrival order, deduping by id first (05 §5).
 * A pulled op with no preset arrivalSeq gets the next arrival-order counter value. Returns the count
 * actually applied (post-dedup) so a test can assert a non-trivial fixture (T-14b).
 */
export async function deliverPulled(
  harness: ProjectionHarness,
  ops: readonly GeneratedOp[],
): Promise<number> {
  let seq = await nextArrivalSeq(harness.db);
  let applied = 0;
  for (const { op, arrivalSeq } of ops) {
    if (await hasOpId(harness.db, op.id)) continue;
    const assigned = arrivalSeq ?? seq++;
    await insertOpRow(harness.db, op, assigned);
    await harness.engine.applyPulledOp(op);
    applied += 1;
  }
  return applied;
}

/** Deliver ops through the APPEND path (own-device, arrivalSeq null), deduping by id. */
export async function deliverAppended(
  harness: ProjectionHarness,
  ops: readonly SignedOperation[],
): Promise<number> {
  let applied = 0;
  for (const op of ops) {
    if (await hasOpId(harness.db, op.id)) continue;
    await insertOpRow(harness.db, op, null);
    await harness.engine.applyAppendedOp(op);
    applied += 1;
  }
  return applied;
}

/** Row count of a projection table — a fixture assertion (T-14b: state exists before equality). */
export async function countRows(db: Kysely<ClientDatabase>, table: string): Promise<number> {
  const result = await sql<{ c: number }>`SELECT COUNT(*) AS c FROM ${sql.table(table)}`.execute(
    db,
  );
  return result.rows[0]?.c ?? 0;
}
