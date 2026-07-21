// 06-media-pipeline §2.3's capture tail — "§2.2 steps 2, 5–8", over PNG bytes.
//
// The rule this suite exists for is `refused_empty`. A blank 800 x 400 white PNG is a perfectly
// valid file: it hashes, it uploads, it renders, and it would sit in a repair record as a
// customer's acknowledgement of work nobody acknowledged. The ONLY moment that is knowable is
// before the bytes exist, which is why the check lives in `captureSignature` and not in the screen —
// a UI bug must not be able to produce one.
import { closeClientDb, openClientDb, runClientMigrations, type ClientDb } from '@bolusi/db-client';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { openBetterSqlite3Driver } from '../../test/better-sqlite3-driver.js';
import { FakeFs, sha256Hex } from './_harness.test.js';
import { captureSignature, type SignatureCaptureDeps } from './signature.js';
import type { SignatureStroke } from './signature-png.js';

const KEY = 'a'.repeat(64);
const keyStore = { getDatabaseEncryptionKey: () => Promise.resolve(KEY) };
const NOW = 1_726_000_000_000;
const PAD = { width: 400, height: 200 };
const STROKE: SignatureStroke = [
  { x: 20, y: 20 },
  { x: 200, y: 120 },
];

let db: ClientDb;

function buildDeps(
  trace: string[],
  options: { freeBytes?: number } = {},
): { deps: SignatureCaptureDeps<never>; fs: FakeFs } {
  const fs = new FakeFs();
  const deps: SignatureCaptureDeps<never> = {
    db: db.db as never,
    identity: {
      tenantId: 'tenant-1',
      storeId: null,
      userId: 'user-1',
      deviceId: 'device-1',
    },
    files: fs.port,
    writeToCache: (bytes, mediaId, extension) => {
      trace.push('writeCache');
      return fs.writeToCache(bytes, mediaId, extension);
    },
    moveToDocuments: async (cacheUri, mediaId, extension) => {
      trace.push('move');
      return fs.moveToDocuments(cacheUri, mediaId, extension);
    },
    location: { getBestFix: () => null },
    clock: { now: () => NOW },
    newId: () => 'sig-1',
    freeSpaceBytes: () => {
      trace.push('freeSpace');
      return options.freeBytes ?? 10_000_000_000;
    },
    onCaptured: () => trace.push('trigger'),
  };
  return { deps, fs };
}

async function readRow(): Promise<Record<string, unknown> | undefined> {
  const result = await sql<Record<string, unknown>>`
    SELECT id, type, mime_type AS "mimeType", byte_size AS "byteSize", sha256,
           local_path AS "localPath", upload_status AS "uploadStatus",
           attached_to_operation_id AS "attachedToOperationId", store_id AS "storeId"
    FROM media_items WHERE id = 'sig-1'
  `.execute(db.db);
  return result.rows[0];
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

describe('06 §2.3 — signature capture', () => {
  test('a signed pad produces a PNG row, moved out of the cache before it is hashed', async () => {
    const trace: string[] = [];
    const { deps, fs } = buildDeps(trace);
    const outcome = await captureSignature(deps, [STROKE], PAD);
    if (outcome.kind !== 'captured') throw new Error(`expected a capture, got ${outcome.kind}`);

    // §2.3 defers to §2.2 steps 5–8, so the same ordering rule applies: cache, then move, then row.
    expect(trace).toEqual(['freeSpace', 'writeCache', 'move', 'trigger']);
    expect(outcome.localPath).toBe('/documents/media/sig-1.png');
    expect(fs.files.has('/cache/media-capture/sig-1.png')).toBe(false);

    const row = await readRow();
    expect(row?.['type']).toBe('signature');
    expect(row?.['mimeType']).toBe('image/png');
    expect(row?.['uploadStatus']).toBe('pending');
    expect(row?.['attachedToOperationId']).toBeNull();
    // A store-less device stores NULL, not an empty string (api/03-media §2).
    expect(row?.['storeId']).toBeNull();

    // The bytes really are a PNG, and the hash/size describe the file on disk — not `png.length`,
    // which is what we INTENDED to write.
    const stored = fs.read('/documents/media/sig-1.png');
    expect([...stored.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(outcome.ref.sha256).toBe(sha256Hex(stored));
    expect(outcome.ref.sizeBytes).toBe(stored.byteLength);
  });

  test('an UNSIGNED pad is refused — no bytes, no file, no row, no trigger', async () => {
    const trace: string[] = [];
    const { deps, fs } = buildDeps(trace);

    expect(await captureSignature(deps, [], PAD)).toEqual({ kind: 'refused_empty' });
    expect(await captureSignature(deps, [[], []], PAD)).toEqual({ kind: 'refused_empty' });

    // Nothing at all happened — the refusal precedes even the storage check.
    expect(trace).toEqual([]);
    expect(fs.files.size).toBe(0);
    expect(await readRow()).toBeUndefined();
  });

  test('06 §7 applies to signatures too: under 50 MB free, refused before any byte is written', async () => {
    const trace: string[] = [];
    const { deps, fs } = buildDeps(trace, { freeBytes: 10_000_000 });
    expect(await captureSignature(deps, [STROKE], PAD)).toEqual({
      kind: 'refused_low_storage',
      freeBytes: 10_000_000,
    });
    expect(trace).toEqual(['freeSpace']);
    expect(fs.files.size).toBe(0);
  });

  test('POSITIVE CONTROL: with room, the same pad captures — the refusals are state-driven', async () => {
    const trace: string[] = [];
    const { deps } = buildDeps(trace, { freeBytes: 60_000_000 });
    expect((await captureSignature(deps, [STROKE], PAD)).kind).toBe('captured');
  });
});
