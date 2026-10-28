// An op holding U+0000 can never be stored (Postgres refuses it in jsonb and text), so the push
// pipeline refuses it per op instead of failing the whole batch and wedging the device.
import { type DB, type ForTenant, type TenantDb } from '@bolusi/db-server';
import { createTestDatabase } from '@bolusi/db-server/testing';
import { ChainBuilder, makeWorld } from '@bolusi/test-support';
import { sql, type Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, inject, test } from 'vitest';

import { resolveDeps } from '../../../src/deps.js';
import { serverCryptoPort } from '../../../src/oplog/crypto.js';
import { processPushBatch } from '../../../src/oplog/pipeline.js';
import type { OplogPipelineDeps } from '../../../src/oplog/types.js';
import { readOps, seedWorld } from '../oplog/helpers.js';

let db: Kysely<DB>;
let closeDb: (() => Promise<void>) | undefined;

const NOW = 1_726_100_000_000;

function forTenantOn(handle: Kysely<DB>): ForTenant {
  return <T>(tenantId: string, fn: (tdb: TenantDb) => Promise<T>) =>
    handle.transaction().execute(async (trx) => {
      await sql`SET LOCAL ROLE bolusi_app`.execute(trx);
      await sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
      return fn(trx);
    });
}

function productionDeps(): OplogPipelineDeps {
  const deps = resolveDeps({ forTenant: forTenantOn(db), now: () => NOW });
  return {
    forTenant: deps.forTenant,
    crypto: deps.serverCrypto,
    now: deps.now,
    newId: deps.newOpLogId,
    registry: deps.opRegistry,
    projections: deps.projections,
  };
}

beforeEach(async () => {
  const handle = await createTestDatabase(
    {
      maintenanceUri: inject('pgMaintenanceUri'),
      baseUri: inject('pgBaseUri'),
      owner: inject('pgOwner'),
    },
    expect.getState().testPath,
  );
  db = handle.db;
  closeDb = handle.close;
}, 120_000);

afterEach(async () => {
  await closeDb?.();
  closeDb = undefined;
});

describe('a NUL character in an op', () => {
  test('is refused as SCHEMA_INVALID while the rest of the batch is accepted', async () => {
    const world = makeWorld(9201, serverCryptoPort);
    const builder = new ChainBuilder(world, serverCryptoPort);
    const genesis = builder.genesis();
    await seedWorld(db, world, { lastSeq: 1, lastHash: genesis.hash, grants: 'all' });

    const nul = builder.append({
      type: 'notes.note_created',
      schemaVersion: 3,
      entityType: 'note',
      payload: { title: 'Catatan', body: 'pasted\u0000text', mediaRef: null },
    });
    const honest = builder.append({
      type: 'notes.note_created',
      schemaVersion: 3,
      entityType: 'note',
      payload: { title: 'Catatan 2', body: 'ok', mediaRef: null },
    });
    const push = () =>
      processPushBatch(productionDeps(), { deviceId: world.deviceId, tenantId: world.tenantId }, [
        nul,
        honest,
      ]);

    const first = await push();
    expect(first.results[0]).toMatchObject({
      id: nul.id,
      status: 'rejected',
      code: 'SCHEMA_INVALID',
    });
    expect(first.results[1]).toMatchObject({ id: honest.id, status: 'accepted' });
    expect((await readOps(db, world.tenantId)).map((op) => op.id)).toEqual([honest.id]);

    // A re-send settles instead of failing again: the device is not stuck.
    const again = await push();
    expect(again.results.map((r) => r.status)).toEqual(['rejected', 'duplicate']);
  });
});
