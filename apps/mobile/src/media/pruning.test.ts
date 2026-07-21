// The pruning ACTOR — 06-media-pipeline §7 — plus the `media_items` writes it drives (queue.ts).
//
// Core's `prunePlanFor` already has eleven sound tests and, until this task, ZERO callers: a correct
// decision computed and thrown away, invisible to any green run (§2.11's newest class). This suite
// is about the half that touches the disk, so every assertion here reads REAL rows in a REAL
// better-sqlite3 database through the REAL `CLIENT_MIGRATIONS`, and a REAL file map.
//
// THE ONE THAT MUST NEVER GO GREEN FOR THE WRONG REASON: "`pending`/`uploading`/`failed` media is
// never pruned automatically, regardless of storage pressure — it is un-uploaded evidence" (§7).
// It is driven at 10 MB free — below EVERY band, including the one where capture itself is refused —
// because a threshold-shaped bug would survive a test run at a comfortable free-space figure.
import { STORAGE_LOUD_BYTES, STORAGE_WARNING_BYTES, UPLOADED_RETENTION_MS } from '@bolusi/core';
import { closeClientDb, openClientDb, runClientMigrations, type ClientDb } from '@bolusi/db-client';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { openBetterSqlite3Driver } from '../../test/better-sqlite3-driver.js';
import { FakeFs, bytesOfLength } from './_harness.test.js';
import { PRUNE_MIN_INTERVAL_MS, createPruningPass, type RemoteCacheEntry } from './pruning.js';
import { attachMediaToOperation, insertMediaItem } from './queue.js';

const KEY = 'a'.repeat(64);
const keyStore = { getDatabaseEncryptionKey: () => Promise.resolve(KEY) };
const NOW = 1_726_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const ROOMY = 10_000_000_000;
/** Below every band in §7 — including `capture_refused`. */
const DESPERATE = 10_000_000;

let db: ClientDb;

async function seed(options: {
  id: string;
  uploadStatus: 'pending' | 'uploading' | 'uploaded' | 'failed';
  attached: boolean;
  capturedAt: number;
  uploadedAt?: number | null;
  localPath?: string | null;
}): Promise<void> {
  await insertMediaItem(db.db, {
    id: options.id,
    tenantId: 'tenant-1',
    storeId: null,
    userId: 'user-1',
    deviceId: 'device-1',
    type: 'image',
    mime: 'image/jpeg',
    sizeBytes: 1234,
    sha256: 'a'.repeat(64),
    capturedAt: options.capturedAt,
    location: null,
    localPath: `/documents/media/${options.id}.jpg`,
  });
  if (options.attached) await attachMediaToOperation(db.db, options.id, `op-${options.id}`);
  // The insert is capture-shaped by design (`pending`, no `uploadedAt`); the drain's own writers own
  // the rest, so the fixture nudges the bookkeeping columns directly — never an immutable one.
  await sql`
    UPDATE media_items
    SET upload_status = ${options.uploadStatus},
        uploaded_at = ${options.uploadedAt ?? null},
        local_path = ${options.localPath === undefined ? `/documents/media/${options.id}.jpg` : options.localPath}
    WHERE id = ${options.id}
  `.execute(db.db);
}

async function rowsById(): Promise<Map<string, { localPath: string | null }>> {
  const result = await sql<{ id: string; localPath: string | null }>`
    SELECT id, local_path AS "localPath" FROM media_items
  `.execute(db.db);
  return new Map(result.rows.map((row) => [row.id, { localPath: row.localPath }]));
}

function buildPass(
  fs: FakeFs,
  free: number,
  cache: readonly RemoteCacheEntry[] = [],
  evicted: string[] = [],
  now: () => number = () => NOW,
) {
  return createPruningPass({
    db: db.db,
    files: fs.port,
    clock: { now },
    freeSpaceBytes: () => free,
    listRemoteCache: () => cache,
    evictRemoteCache: (id) => {
      evicted.push(id);
      return Promise.resolve();
    },
  });
}

function fsWith(...ids: string[]): FakeFs {
  const fs = new FakeFs();
  for (const id of ids) fs.write(`/documents/media/${id}.jpg`, bytesOfLength(64));
  return fs;
}

beforeEach(async () => {
  await closeClientDb();
  db = await openClientDb({
    driverFactory: openBetterSqlite3Driver,
    keyStore,
    location: ':memory:',
  });
  await runClientMigrations(db.driver, { now: () => 1 });
});

afterEach(async () => {
  await closeClientDb();
});

describe('§7 — un-uploaded evidence is NEVER pruned, at any storage level', () => {
  test('pending / uploading / failed all survive at 10 MB free, however old', async () => {
    const fs = fsWith('pending', 'uploading', 'failed');
    await seed({
      id: 'pending',
      uploadStatus: 'pending',
      attached: true,
      capturedAt: NOW - 90 * DAY,
    });
    await seed({
      id: 'uploading',
      uploadStatus: 'uploading',
      attached: true,
      capturedAt: NOW - 90 * DAY,
    });
    await seed({
      id: 'failed',
      uploadStatus: 'failed',
      attached: true,
      capturedAt: NOW - 90 * DAY,
    });

    const report = await buildPass(fs, DESPERATE).run('app_start');

    expect(report?.band).toBe('capture_refused');
    expect(report?.filesDeleted).toBe(0);
    expect(report?.rowsDeleted).toBe(0);
    for (const id of ['pending', 'uploading', 'failed']) {
      expect(fs.files.has(`/documents/media/${id}.jpg`)).toBe(true);
      expect((await rowsById()).get(id)?.localPath).toBe(`/documents/media/${id}.jpg`);
    }
  });

  test('ADVERSARIAL: a `failed` row that somehow carries an `uploadedAt` STILL survives', async () => {
    // WHY THIS EXISTS, and it is the most useful thing in this file. The test above was GREEN when
    // core's "un-uploaded evidence is never pruned" rule was deliberately removed — because a
    // realistic `failed` row has `uploadedAt = null` (only `markUploaded` sets it), and
    // `prunePlanFor`'s LATER `uploadedAt === null` guard caught it instead. A true assertion,
    // produced by a different rule than the one it names: §2.11's exact class, found by breaking
    // the rule and watching the suite stay green rather than by reading it.
    //
    // So this row is constructed to isolate the guard: `failed`, attached, old, AND with an
    // `uploadedAt` — the state a bug would produce (a mis-ordered write, a partial recovery), and
    // the state in which the STATUS rule is the only thing between un-uploaded evidence and `rm`.
    const fs = fsWith('failed-with-timestamp');
    await seed({
      id: 'failed-with-timestamp',
      uploadStatus: 'failed',
      attached: true,
      capturedAt: NOW - 30 * DAY,
      uploadedAt: NOW - 30 * DAY,
    });

    const report = await buildPass(fs, DESPERATE).run('app_start');

    expect(report?.filesDeleted).toBe(0);
    expect(fs.files.has('/documents/media/failed-with-timestamp.jpg')).toBe(true);
  });

  test('POSITIVE CONTROL: at the SAME 10 MB, an uploaded file IS pruned', async () => {
    // Without this, the test above would pass on a pruning pass that deleted nothing ever — a
    // storage manager that manages no storage, green forever.
    const fs = fsWith('done');
    await seed({
      id: 'done',
      uploadStatus: 'uploaded',
      attached: true,
      capturedAt: NOW - 2 * DAY,
      uploadedAt: NOW - 1 * DAY,
    });

    const report = await buildPass(fs, DESPERATE).run('app_start');

    // §7's < 200 MB row: "uploaded-media retention window drops to 0 (prune all uploaded now)".
    expect(report?.filesDeleted).toBe(1);
    expect(fs.files.has('/documents/media/done.jpg')).toBe(false);
    // The ROW survives with a null path — "deleting rows would orphan `mediaRef`s".
    expect((await rowsById()).has('done')).toBe(true);
    expect((await rowsById()).get('done')?.localPath).toBeNull();
  });
});

describe('§7 — the retention window', () => {
  test('an uploaded file younger than 7 days is KEPT at normal free space', async () => {
    const fs = fsWith('fresh');
    await seed({
      id: 'fresh',
      uploadStatus: 'uploaded',
      attached: true,
      capturedAt: NOW - 8 * DAY,
      uploadedAt: NOW - 6 * DAY,
    });
    const report = await buildPass(fs, ROOMY).run('app_start');
    expect(report?.filesDeleted).toBe(0);
    expect(fs.files.has('/documents/media/fresh.jpg')).toBe(true);
  });

  test('at exactly 7 days it goes, and the row stays as the index into server media', async () => {
    const fs = fsWith('old');
    await seed({
      id: 'old',
      uploadStatus: 'uploaded',
      attached: true,
      capturedAt: NOW - 10 * DAY,
      uploadedAt: NOW - UPLOADED_RETENTION_MS,
    });
    const report = await buildPass(fs, ROOMY).run('app_start');
    expect(report?.filesDeleted).toBe(1);
    expect(fs.files.has('/documents/media/old.jpg')).toBe(false);
    expect((await rowsById()).get('old')?.localPath).toBeNull();
  });
});

describe('§4/§7 — the orphan rule', () => {
  test('an unattached capture older than 24 h loses BOTH its file and its row', async () => {
    const fs = fsWith('orphan');
    await seed({
      id: 'orphan',
      uploadStatus: 'pending',
      attached: false,
      capturedAt: NOW - DAY - 1,
    });
    const report = await buildPass(fs, ROOMY).run('app_start');
    expect(report?.rowsDeleted).toBe(1);
    expect(fs.files.has('/documents/media/orphan.jpg')).toBe(false);
    expect((await rowsById()).has('orphan')).toBe(false);
  });

  test('an unattached capture INSIDE the 24 h window is untouched — the user may still be typing', async () => {
    const fs = fsWith('recent');
    await seed({ id: 'recent', uploadStatus: 'pending', attached: false, capturedAt: NOW - 1000 });
    const report = await buildPass(fs, ROOMY).run('app_start');
    expect(report?.rowsDeleted).toBe(0);
    expect((await rowsById()).has('recent')).toBe(true);
  });

  test('an ATTACHED row is never row-deleted, even when the caller is wrong', async () => {
    // `deleteMediaRow` re-asserts `attached_to_operation_id IS NULL` in the statement. This drives
    // the actor over an attached-but-ancient row: nothing must delete a row that a signed op points
    // at, because nothing could ever find those bytes again.
    const fs = fsWith('attached');
    await seed({
      id: 'attached',
      uploadStatus: 'uploaded',
      attached: true,
      capturedAt: NOW - 400 * DAY,
      uploadedAt: NOW - 400 * DAY,
    });
    await buildPass(fs, DESPERATE).run('app_start');
    expect((await rowsById()).has('attached')).toBe(true);
  });
});

describe('§7 — the remote cache and the throttle', () => {
  test('below 200 MB the render cache is FULLY evicted; at normal free space, none of it is', async () => {
    const cache: RemoteCacheEntry[] = [
      { id: 'c1', lastUsedAt: 3 },
      { id: 'c2', lastUsedAt: 1 },
      { id: 'c3', lastUsedAt: 2 },
    ];
    const loud: string[] = [];
    await buildPass(new FakeFs(), STORAGE_LOUD_BYTES - 1, cache, loud).run('app_start');
    // Oldest-first, and all of them.
    expect(loud).toEqual(['c2', 'c3', 'c1']);

    const normal: string[] = [];
    await buildPass(new FakeFs(), ROOMY, cache, normal).run('app_start');
    expect(normal).toEqual([]);
  });

  test('between 200 and 500 MB, the cache is half-evicted oldest-first', async () => {
    const evicted: string[] = [];
    await buildPass(
      new FakeFs(),
      STORAGE_WARNING_BYTES - 1,
      [
        { id: 'c1', lastUsedAt: 3 },
        { id: 'c2', lastUsedAt: 1 },
        { id: 'c3', lastUsedAt: 2 },
      ],
      evicted,
    ).run('app_start');
    expect(evicted).toEqual(['c2', 'c3']);
  });

  test('the pass runs at most once an hour — but `app_start` and a low band always run', async () => {
    const fs = new FakeFs();
    let now = NOW;
    const pass = buildPass(fs, ROOMY, [], [], () => now);

    expect(await pass.run('app_start')).not.toBeNull();
    // Ten minutes later, a routine trigger is throttled — `null` means "did not run", which a
    // caller must be able to tell from "ran and deleted nothing".
    now = NOW + 10 * 60 * 1000;
    expect(await pass.run('after_drain')).toBeNull();
    // An hour on, it runs again.
    now = NOW + PRUNE_MIN_INTERVAL_MS + 1;
    expect(await pass.run('after_drain')).not.toBeNull();
  });

  test('a device under storage pressure is NOT throttled — §7 says "immediate pruning pass"', async () => {
    let now = NOW;
    const pass = buildPass(new FakeFs(), STORAGE_WARNING_BYTES - 1, [], [], () => now);
    expect(await pass.run('app_start')).not.toBeNull();
    now = NOW + 1000;
    expect(await pass.run('after_drain')).not.toBeNull();
    expect(pass.lastBand()).toBe('warning');
  });

  test('`app_start` is never throttled by a timestamp from the previous process', async () => {
    // The clock is wall time, not uptime. A phone restarted five minutes after its last pass must
    // still get its boot pass — §7 names app start as one of the three occasions.
    let now = NOW;
    const pass = buildPass(new FakeFs(), ROOMY, [], [], () => now);
    expect(await pass.run('app_start')).not.toBeNull();
    now = NOW + 60_000;
    expect(await pass.run('app_start')).not.toBeNull();
  });
});
