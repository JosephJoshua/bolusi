// Writes made beside a command's transaction on the one client connection. A bare statement runs at
// once (db-client `serializeTransactions`), so with a command's transaction open it lands inside it
// and is lost when that command rolls back: a captured photo's row, or a user's saved draft. Each
// writer opens its own transaction, which waits its turn. Real connection and migrations.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sql } from 'kysely';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { createWorkStore } from '@bolusi/core';
import { closeClientDb, openClientDb, runClientMigrations, type ClientDb } from '@bolusi/db-client';
import { nodeColumnAead } from '@bolusi/test-support';

import { openBetterSqlite3Driver } from '../../test/better-sqlite3-driver.js';
import { insertMediaItem } from './queue.js';

let dir: string | null = null;
let connection: ClientDb;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'bolusi-shared-connection-'));
  const file = join(dir, 'bolusi.db');
  connection = await openClientDb({
    driverFactory: () => openBetterSqlite3Driver({ name: 'bolusi.db', location: file }),
    keyStore: { getDatabaseEncryptionKey: () => Promise.resolve('a'.repeat(64)) },
    aead: nodeColumnAead,
    name: 'bolusi.db',
    location: file,
  });
  await runClientMigrations(connection.driver, { now: () => 1 });
});

afterEach(async () => {
  await closeClientDb().catch(() => undefined);
  if (dir !== null) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

/**
 * A command's transaction held open until `write` has been started beside it, then rolled back.
 * Resolves once both have finished.
 */
async function besideARolledBackCommand(write: () => Promise<void>): Promise<void> {
  let started!: () => void;
  const open = new Promise<void>((resolve) => {
    started = resolve;
  });
  let writing: Promise<void> = Promise.resolve();
  // Through the driver, as the op store appends a command's ops: not behind Kysely's own lock.
  const command = connection.transaction(async () => {
    started();
    // Let the write run as far as it can while this transaction is open.
    await new Promise((resolve) => setTimeout(resolve, 10));
    throw new Error('applier failed');
  });
  await open;
  writing = write();
  await expect(command).rejects.toThrow('applier failed');
  await writing;
}

test('a photo captured while a command rolls back keeps its row', async () => {
  await besideARolledBackCommand(() =>
    insertMediaItem(
      connection.db,
      {
        id: 'media-1',
        tenantId: 'tenant-1',
        storeId: 'store-1',
        userId: 'user-1',
        deviceId: 'device-1',
        type: 'image',
        mime: 'image/jpeg',
        sizeBytes: 1234,
        sha256: 'a'.repeat(64),
        capturedAt: 1_700_000_000_000,
        location: null,
        localPath: '/documents/media-1.jpg',
      },
      (fn) => connection.transaction(() => fn()),
    ),
  );
  const rows = await sql<{ id: string }>`SELECT id FROM media_items`.execute(connection.db);
  expect(rows.rows.map((row) => row.id)).toEqual(['media-1']);
});

test('a draft saved while a command rolls back is still there', async () => {
  const store = createWorkStore(
    connection.db,
    (value) => value as { draft: string },
    () => 1,
    (fn) => connection.transaction(() => fn()),
  );
  await besideARolledBackCommand(() => store.save('user-1', { draft: 'Layar retak' }));
  expect(await store.load('user-1')).toEqual({ draft: 'Layar retak' });
});
