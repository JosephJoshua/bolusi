// A gallery picture (the store logo) entering the pipeline: refused before anything is written on
// a full device, and finalized like a capture otherwise, a PNG keeping its type.
import { closeClientDb, openClientDb, runClientMigrations, type ClientDb } from '@bolusi/db-client';
import { nodeColumnAead } from '@bolusi/test-support';
import { sql } from 'kysely';
import { VIDEO_MAX_SIZE_BYTES } from '@bolusi/schemas';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { openBetterSqlite3Driver } from '../../test/better-sqlite3-driver.js';
import { FakeFs, bytesOfLength, sha256Hex } from './_harness.test.js';
import { importImage, importVideo, type ImportDeps } from './import.js';

const keyStore = { getDatabaseEncryptionKey: () => Promise.resolve('a'.repeat(64)) };
const IDENTITY = {
  tenantId: 'tenant-1',
  storeId: 'store-1',
  userId: 'user-1',
  deviceId: 'device-1',
};

let db: ClientDb;

beforeEach(async () => {
  await closeClientDb();
  db = await openClientDb({
    driverFactory: openBetterSqlite3Driver,
    keyStore,
    aead: nodeColumnAead,
    location: ':memory:',
  });
  await runClientMigrations(db.driver, { now: () => 1 });
});

afterEach(async () => {
  await closeClientDb();
});

function deps(fs: FakeFs, freeBytes = 10_000_000_000): ImportDeps<never> {
  return {
    db: db.db as never,
    identity: IDENTITY,
    files: fs.port,
    moveToDocuments: (uri, id, ext) => fs.moveToDocuments(uri, id, ext),
    location: { getBestFix: () => null },
    clock: { now: () => 5 },
    newId: () => 'logo-1',
    freeSpaceBytes: () => freeBytes,
    onCaptured: () => undefined,
  };
}

describe('importing a gallery picture', () => {
  test('a PNG is finalized as a PNG with the hash of the bytes on disk', async () => {
    const fs = new FakeFs();
    const bytes = bytesOfLength(40_000);
    fs.write('/cache/logo.png', bytes);
    const outcome = await importImage(deps(fs), { uri: '/cache/logo.png', mime: 'image/png' });
    expect(outcome.kind).toBe('imported');
    if (outcome.kind !== 'imported') return;
    expect(outcome.ref).toMatchObject({
      mediaId: 'logo-1',
      mime: 'image/png',
      type: 'image',
      sha256: sha256Hex(bytes),
      userId: 'user-1',
    });
    const row = await sql<{ localPath: string; mimeType: string }>`
      SELECT local_path AS "localPath", mime_type AS "mimeType" FROM media_items WHERE id = 'logo-1'
    `.execute(db.db);
    expect(row.rows[0]?.mimeType).toBe('image/png');
    expect(row.rows[0]?.localPath).toMatch(/logo-1\.png$/);
  });

  test('a nearly full device refuses before writing anything', async () => {
    const fs = new FakeFs();
    fs.write('/cache/logo.jpg', bytesOfLength(10));
    const outcome = await importImage(deps(fs, 1), { uri: '/cache/logo.jpg', mime: 'image/jpeg' });
    expect(outcome.kind).toBe('refused_low_storage');
    const rows = await sql`SELECT id FROM media_items`.execute(db.db);
    expect(rows.rows).toHaveLength(0);
    // The clip not kept is not left lying around unencrypted.
    expect(fs.files.has('/cache/clip.webm')).toBe(false);
  });

  test('a clip bigger than the server takes is refused and dropped', async () => {
    const fs = new FakeFs();
    fs.write('/cache/clip.mp4', bytesOfLength(VIDEO_MAX_SIZE_BYTES + 1));
    const outcome = await importVideo(deps(fs), { uri: '/cache/clip.mp4', mime: 'video/mp4' });
    expect(outcome).toEqual({ kind: 'refused_too_large', sizeBytes: VIDEO_MAX_SIZE_BYTES + 1 });
    expect(fs.files.has('/cache/clip.mp4')).toBe(false);
    const rows = await sql`SELECT id FROM media_items`.execute(db.db);
    expect(rows.rows).toHaveLength(0);
  });
});

describe('keeping a recorded video clip', () => {
  test('an MP4 is kept as a video item, sealed under its own extension', async () => {
    const fs = new FakeFs();
    const bytes = bytesOfLength(3 * 256 * 1024 + 7);
    fs.write('/cache/clip.mp4', bytes);
    const outcome = await importVideo(deps(fs), { uri: '/cache/clip.mp4', mime: 'video/mp4' });
    expect(outcome.kind).toBe('imported');
    if (outcome.kind !== 'imported') return;
    expect(outcome.ref).toMatchObject({
      mime: 'video/mp4',
      type: 'video',
      sizeBytes: bytes.byteLength,
      sha256: sha256Hex(bytes),
    });
    const row = await sql<{ localPath: string; type: string; mimeType: string }>`
      SELECT local_path AS "localPath", type, mime_type AS "mimeType" FROM media_items
    `.execute(db.db);
    expect(row.rows[0]).toMatchObject({ type: 'video', mimeType: 'video/mp4' });
    expect(row.rows[0]?.localPath).toMatch(/\.mp4$/);
    expect(fs.files.has('/cache/clip.mp4')).toBe(false);
  });

  test('a nearly full device refuses a clip before writing anything', async () => {
    const fs = new FakeFs();
    fs.write('/cache/clip.webm', bytesOfLength(10));
    const outcome = await importVideo(deps(fs, 1), { uri: '/cache/clip.webm', mime: 'video/webm' });
    expect(outcome.kind).toBe('refused_low_storage');
    const rows = await sql`SELECT id FROM media_items`.execute(db.db);
    expect(rows.rows).toHaveLength(0);
    // The clip not kept is not left lying around unencrypted.
    expect(fs.files.has('/cache/clip.webm')).toBe(false);
  });

  test('a clip bigger than the server takes is refused and dropped', async () => {
    const fs = new FakeFs();
    fs.write('/cache/clip.mp4', bytesOfLength(VIDEO_MAX_SIZE_BYTES + 1));
    const outcome = await importVideo(deps(fs), { uri: '/cache/clip.mp4', mime: 'video/mp4' });
    expect(outcome).toEqual({ kind: 'refused_too_large', sizeBytes: VIDEO_MAX_SIZE_BYTES + 1 });
    expect(fs.files.has('/cache/clip.mp4')).toBe(false);
    const rows = await sql`SELECT id FROM media_items`.execute(db.db);
    expect(rows.rows).toHaveLength(0);
  });
});
