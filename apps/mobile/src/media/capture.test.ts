// 06-media-pipeline §2.2 steps 1–8 — and above all, THE ORDER.
//
// Three of the eight steps are only correct in sequence, and each has a named failure:
//   • free space is read BEFORE the shutter (§7) — otherwise a full device dies silently in the
//     camera, which PRD-012 §6 says "will be discovered at the worst moment";
//   • the cache→document MOVE completes before the row INSERT (§2.2 step 5, §10's checklist) —
//     otherwise the row points into an OS-purgeable directory and the OS eventually deletes a
//     shop's only record of a repair;
//   • the HASH is taken AFTER the move, at the final path (§2.2 step 6) — otherwise the signed
//     `mediaRef` binds a file that no longer exists there.
// So this suite asserts the SEQUENCE, not just the outcome. An implementation that did all eight
// steps in the wrong order would produce an identical return value and fail here.
import { closeClientDb, openClientDb, runClientMigrations, type ClientDb } from '@bolusi/db-client';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { openBetterSqlite3Driver } from '../../test/better-sqlite3-driver.js';
import { FakeFs, ShrinkingCompressor, bytesOfLength, sha256Hex } from './_harness.test.js';
import { capturePhoto, type CameraCapturePort, type CaptureDeps } from './capture.js';

const KEY = 'a'.repeat(64);
const keyStore = { getDatabaseEncryptionKey: () => Promise.resolve(KEY) };
const NOW = 1_726_000_000_000;
const SHOT = { uri: '/cache/shot.jpg', width: 4000, height: 3000 };
const IDENTITY = {
  tenantId: 'tenant-1',
  storeId: 'store-1',
  userId: 'user-1',
  deviceId: 'device-1',
};

let db: ClientDb;

/** Records the ORDER of the effects the spec sequences. */
interface Trace {
  readonly events: string[];
}

function buildDeps(
  trace: Trace,
  options: { freeBytes?: number; fs?: FakeFs } = {},
): { deps: CaptureDeps<never>; fs: FakeFs; camera: CameraCapturePort } {
  const fs = options.fs ?? new FakeFs();
  fs.write(SHOT.uri, bytesOfLength(9_000_000));
  const compressor = new ShrinkingCompressor({ width: SHOT.width, height: SHOT.height }, fs);
  const camera: CameraCapturePort = {
    takePicture: () => {
      trace.events.push('shutter');
      return Promise.resolve(SHOT);
    },
  };

  const deps: CaptureDeps<never> = {
    db: db.db as never,
    identity: IDENTITY,
    camera,
    compressor,
    files: {
      ...fs.port,
      hashFile: async (path) => {
        trace.events.push(`hash:${path}`);
        return fs.port.hashFile(path);
      },
    },
    moveToDocuments: async (cacheUri, mediaId, extension) => {
      trace.events.push('move');
      return fs.moveToDocuments(cacheUri, mediaId, extension);
    },
    location: { getBestFix: () => ({ lat: -6.2, lng: 106.8, accuracyMeters: 9 }) },
    clock: { now: () => NOW },
    newId: () => 'media-1',
    freeSpaceBytes: () => {
      trace.events.push('freeSpace');
      return options.freeBytes ?? 10_000_000_000;
    },
    onCaptured: () => trace.events.push('trigger'),
  };
  return { deps, fs, camera };
}

async function readRow(): Promise<Record<string, unknown> | undefined> {
  const result = await sql<Record<string, unknown>>`
    SELECT id, upload_status AS "uploadStatus", local_path AS "localPath", sha256,
           byte_size AS "byteSize", mime_type AS "mimeType", type,
           captured_at AS "capturedAt", location,
           attached_to_operation_id AS "attachedToOperationId",
           captured_by_user_id AS "capturedByUserId", device_id AS "deviceId",
           tenant_id AS "tenantId", store_id AS "storeId"
    FROM media_items WHERE id = 'media-1'
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

describe('06 §2.2 — the capture pipeline', () => {
  test('the effects happen in the SPEC`s order, and the row lands only after the move', async () => {
    const trace: Trace = { events: [] };
    const { deps, camera } = buildDeps(trace);
    const outcome = await capturePhoto({ ...deps, camera });
    expect(outcome.kind).toBe('captured');

    // The sequence, read as a story: check the disk, take the picture, move it out of the cache,
    // hash where it now lives, then tell the drain there is something to send.
    expect(trace.events[0]).toBe('freeSpace');
    expect(trace.events[1]).toBe('shutter');
    expect(trace.events[2]).toBe('move');
    expect(trace.events[3]).toBe('hash:/documents/media/media-1.jpg');
    expect(trace.events.at(-1)).toBe('trigger');

    // The row exists, and its path is the DOCUMENT dir — never the cache.
    const row = await readRow();
    expect(row?.['localPath']).toBe('/documents/media/media-1.jpg');
    expect(String(row?.['localPath'])).not.toContain('/cache/');
  });

  test('the hash and size in the `mediaRef` describe THE FILE ON DISK', async () => {
    // The op's Ed25519 signature covers these two numbers (06 §3.1). If they describe the
    // pre-move file, the pre-compression file, or the compressor's own report, the server rejects
    // the upload at `complete` and the user is told their evidence rotted (HASH_MISMATCH).
    const trace: Trace = { events: [] };
    const { deps, fs } = buildDeps(trace);
    const outcome = await capturePhoto(deps);
    if (outcome.kind !== 'captured') throw new Error('expected a capture');

    const stored = fs.read('/documents/media/media-1.jpg');
    expect(outcome.ref.sha256).toBe(sha256Hex(stored));
    expect(outcome.ref.sizeBytes).toBe(stored.byteLength);

    const row = await readRow();
    expect(row?.['sha256']).toBe(outcome.ref.sha256);
    expect(Number(row?.['byteSize'])).toBe(outcome.ref.sizeBytes);
  });

  test('the row is born `pending` and UNATTACHED, with the frozen metadata (§2.2 step 7, §4)', async () => {
    const trace: Trace = { events: [] };
    const { deps } = buildDeps(trace);
    await capturePhoto(deps);

    const row = await readRow();
    expect(row?.['uploadStatus']).toBe('pending');
    expect(row?.['attachedToOperationId']).toBeNull();
    expect(row?.['type']).toBe('image');
    expect(row?.['mimeType']).toBe('image/jpeg');
    expect(Number(row?.['capturedAt'])).toBe(NOW);
    expect(row?.['capturedByUserId']).toBe('user-1');
    expect(row?.['deviceId']).toBe('device-1');
    expect(row?.['tenantId']).toBe('tenant-1');
    expect(row?.['storeId']).toBe('store-1');
    expect(JSON.parse(String(row?.['location']))).toEqual({
      lat: -6.2,
      lng: 106.8,
      accuracyMeters: 9,
    });
  });

  test('a null GPS fix is carried as null — never defaulted to a coordinate (T-19)', async () => {
    // `?? {lat: 0, lng: 0}` here would put the Gulf of Guinea in a signed, immutable claim about
    // where a repair happened. `null` is the NORMAL answer indoors (05 §2.1) and must survive.
    const trace: Trace = { events: [] };
    const { deps } = buildDeps(trace);
    const outcome = await capturePhoto({ ...deps, location: { getBestFix: () => null } });
    if (outcome.kind !== 'captured') throw new Error('expected a capture');

    expect(outcome.ref.location).toBeNull();
    expect((await readRow())?.['location']).toBeNull();
  });

  test('06 §7: under 50 MB free, capture is REFUSED — and the shutter never fires', async () => {
    const trace: Trace = { events: [] };
    const { deps } = buildDeps(trace, { freeBytes: 40_000_000 });
    const outcome = await capturePhoto(deps);

    expect(outcome).toEqual({ kind: 'refused_low_storage', freeBytes: 40_000_000 });
    // The refusal is a RETURN VALUE, so the screen can render §7's explicit dialog. And it happens
    // before the camera: no half-written cache file, no row, no trigger.
    expect(trace.events).toEqual(['freeSpace']);
    expect(await readRow()).toBeUndefined();
  });

  test('POSITIVE CONTROL: just above the threshold, capture proceeds', async () => {
    // Without this, the test above would pass on a `capturePhoto` that refused unconditionally — a
    // camera that never works, which is the same silent death §7 exists to prevent.
    const trace: Trace = { events: [] };
    const { deps } = buildDeps(trace, { freeBytes: 60_000_000 });
    expect((await capturePhoto(deps)).kind).toBe('captured');
  });

  test('a move that REJECTS leaves no row — the crash-between-capture-and-move rule (§10)', async () => {
    // "a crash between capture and move loses the photo cleanly, never a dangling row." A row
    // written first would point at a cache path the OS is free to purge, and the drain would later
    // report a file that vanished as corrupted evidence.
    const trace: Trace = { events: [] };
    const { deps } = buildDeps(trace);
    await expect(
      capturePhoto({
        ...deps,
        moveToDocuments: () => Promise.reject(new Error('disk went away')),
      }),
    ).rejects.toThrow('disk went away');
    expect(await readRow()).toBeUndefined();
  });
});
