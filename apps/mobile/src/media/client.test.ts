// THE ACCEPTANCE (task 82): "a photo captured on-device reaches the server through the real engine."
//
// This file drives the WHOLE composition — capture → the two compression passes → the cache→document
// move → the hash → the `media_items` row → the §5.2 capture trigger → task 18's `MediaDrainLoop` →
// the REAL `createFetchMediaTransport` (api/03 §3's wire) → a protocol-faithful in-memory server that
// verifies the assembled bytes against the sha256 `init` declared.
//
// WHAT MAKES IT DIFFERENT FROM TASK 18's SUITE, which already proved the engine: everything here is
// the DEVICE WIRING. The transport is the real fetch adapter, not a port double. The DB is a real
// better-sqlite3 file running the real `CLIENT_MIGRATIONS`. The trigger is the real debounce over a
// real `TimerPort`. The only doubles left are the four things that need hardware — a camera, a JPEG
// encoder, a filesystem, and a socket — and each is a fake with its own falsification
// (`_harness.test.ts`).
//
// NOT COVERED, said plainly: no camera, no expo-image-manipulator, no expo-file-system, no
// expo-background-task run here. There is no Android device and no iOS device on this
// infrastructure (D12/D13). The native adapters are type-checked against the installed SDK 57
// declarations and unexecuted.
import { createUuidV7Generator, type MediaTransportPort } from '@bolusi/core';
import { closeClientDb, openClientDb, runClientMigrations, type ClientDb } from '@bolusi/db-client';
import { noblePort } from '@bolusi/test-support';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { openBetterSqlite3Driver } from '../../test/better-sqlite3-driver.js';
import {
  FakeFs,
  FakeMediaServer,
  FakeTimer,
  ShrinkingCompressor,
  activeAppState,
  bytesOfLength,
  fakeNetInfo,
  sha256Hex,
} from './_harness.test.js';
import { createMediaClient, type MediaClient, type MediaClientDeps } from './client.js';
import { SIZE_BUDGET_BYTES } from './compression.js';
import type { CameraCapturePort, CaptureIdentity } from './capture.js';
import { createFetchMediaTransport } from './transport.js';

const KEY = 'a'.repeat(64);
const keyStore = { getDatabaseEncryptionKey: () => Promise.resolve(KEY) };
const NOW = 1_726_000_000_000;
const BASE_URL = 'https://api.example.test';
const OPERATION_ID = '01920000-0000-7000-8000-0000000000ff';

const IDENTITY: CaptureIdentity = {
  tenantId: '00000000-0000-4000-8000-00000000000a',
  storeId: '00000000-0000-4000-8000-00000000000b',
  userId: '00000000-0000-4000-8000-00000000000c',
  deviceId: '00000000-0000-4000-8000-00000000000d',
};

/** A 12 MP shot, the size 06 §2.2's "8–12 MB" note is about. */
const SHOT = { uri: '/cache/shot.jpg', width: 4000, height: 3000 };
const SHOT_BYTES = 9_000_000;

let db: ClientDb;
/** Every client a test built, so `afterEach` can stop its triggers BEFORE the connection closes. */
let live: MediaClient[] = [];

interface Rig {
  readonly client: MediaClient;
  readonly fs: FakeFs;
  readonly server: FakeMediaServer;
  readonly timer: FakeTimer;
  readonly compressor: ShrinkingCompressor;
  readonly camera: CameraCapturePort;
  readonly errors: unknown[];
}

function buildRig(overrides: Partial<MediaClientDeps> = {}): Rig {
  const fs = new FakeFs();
  fs.write(SHOT.uri, bytesOfLength(SHOT_BYTES));
  const server = new FakeMediaServer(64 * 1024);
  const timer = new FakeTimer();
  const compressor = new ShrinkingCompressor({ width: SHOT.width, height: SHOT.height }, fs);
  const errors: unknown[] = [];
  const camera: CameraCapturePort = { takePicture: () => Promise.resolve(SHOT) };

  // THE REAL ADAPTER (transport.ts), over the fake socket. Everything api/03 §3 says about URLs,
  // the bearer header, the octet-stream body and the api/00 §7 envelope is exercised here.
  const transport: MediaTransportPort = createFetchMediaTransport({
    baseUrl: BASE_URL,
    deviceToken: () => Promise.resolve('bdt_test'),
    fetchImpl: server.fetch,
  });

  const client = createMediaClient({
    db,
    transport,
    files: fs.port,
    compressor,
    crypto: noblePort,
    clock: { now: () => NOW },
    timer,
    appState: activeAppState,
    netInfo: fakeNetInfo(true).port,
    // Plenty of room — the storage bands have their own suite (`pruning.test.ts`).
    freeSpaceBytes: () => 10_000_000_000,
    moveToDocuments: fs.moveToDocuments,
    writeToCache: fs.writeToCache,
    findCached: () => null,
    writeCached: (mediaId, extension, bytes) =>
      fs.write(`/cache/media/${mediaId}.${extension}`, bytes),
    evictCached: () => undefined,
    listRemoteCache: () => [],
    newId: createUuidV7Generator({ now: () => NOW, randomBytes: (n) => noblePort.randomBytes(n) }),
    location: { getBestFix: () => ({ lat: -6.2, lng: 106.8, accuracyMeters: 12 }) },
    background: null,
    onError: (error) => errors.push(error),
    ...overrides,
  });

  live.push(client);
  return { client, fs, server, timer, compressor, camera, errors };
}

/**
 * Read a row with EXPLICIT camelCase aliases.
 *
 * `SELECT *` would be wrong here and silently so: the production client wires `CamelCasePlugin`
 * (db-client/connection.ts), which rewrites raw-`sql` RESULT keys — so `row['uploadStatus']` comes
 * back `undefined` and every assertion on it passes vacuously against a value that is not there.
 * That is exactly the shape core's `ITEM_COLUMNS` comment warns about, hit for real while writing
 * this file. Aliases with no underscore are inert under both wirings.
 */
async function rowFor(mediaId: string): Promise<Record<string, unknown>> {
  const result = await sql<Record<string, unknown>>`
    SELECT id, upload_status AS "uploadStatus", uploaded_at AS "uploadedAt",
           last_error_code AS "lastErrorCode", local_path AS "localPath",
           attached_to_operation_id AS "attachedToOperationId", byte_size AS "byteSize",
           sha256, mime_type AS "mimeType", type, captured_at AS "capturedAt", location
    FROM media_items WHERE id = ${mediaId}
  `.execute(db.db);
  const row = result.rows[0];
  if (row === undefined) throw new Error(`no media_items row ${mediaId}`);
  return row;
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
  // Stop the triggers and let any in-flight cycle settle BEFORE the connection goes. A drain still
  // running when the driver is destroyed surfaces as an unhandled rejection that vitest reports as
  // a run-level error — noise that would eventually be ignored, hiding a real one.
  for (const client of live) client.stop();
  // THREE rounds, not one. The connectivity arm (`onConnectivityRegained`) AWAITS a DB write before
  // it requests its drain, so a single `settle()` can return before that second cycle even exists —
  // and the cycle then lands on a destroyed driver as an unhandled rejection. Observed, not
  // hypothesised: with one round this suite reported 12 passed AND a run-level error.
  for (let round = 0; round < 3; round += 1) {
    await Promise.allSettled(live.map((client) => client.settle()));
    await new Promise((resolve) => setImmediate(resolve));
  }
  live = [];
  await closeClientDb();
});

describe('capture → compress → queue → drain → the real MediaTransportPort', () => {
  test('a captured photo reaches the server, byte-verified, and the row ends `uploaded`', async () => {
    const rig = buildRig();

    const outcome = await rig.client.capturePhoto(IDENTITY, rig.camera);
    if (outcome.kind !== 'captured') throw new Error(`expected a capture, got ${outcome.kind}`);

    // 06 §2.2 step 7: the row is born `pending` and UNATTACHED, so the drain cannot see it — the
    // orphan exclusion is a security property (core/repository.ts), not an optimisation.
    expect((await rowFor(outcome.ref.mediaId))['uploadStatus']).toBe('pending');

    // 04 §5.1 step 5 — the command runtime's attach. Task 25 will drive this from a real command.
    await rig.client.attach(outcome.ref.mediaId, OPERATION_ID);

    // §5.2 (b): the 3 s debounce. Nothing has drained yet — the trigger is a timer, not a call.
    expect(rig.server.sessions.size).toBe(0);
    rig.timer.runPending();
    await rig.client.settle();

    const row = await rowFor(outcome.ref.mediaId);
    expect(row['uploadStatus']).toBe('uploaded');
    expect(row['uploadedAt']).toBe(NOW);
    expect(row['lastErrorCode']).toBeNull();

    // THE POINT: the server holds bytes that hash to the value in the signed-payload `mediaRef`.
    const session = rig.server.sessions.get(outcome.ref.mediaId);
    expect(session?.complete).toBe(true);
    expect(sha256Hex(rig.server.assembled(outcome.ref.mediaId))).toBe(outcome.ref.sha256);
    expect(rig.server.assembled(outcome.ref.mediaId).byteLength).toBe(outcome.ref.sizeBytes);
  });

  test('FALSIFICATION: with the capture trigger unwired, the item never leaves `pending`', async () => {
    // The positive control above and this are ONE test in two halves: this half proves the green
    // above is produced by the trigger wiring and not by something else in the rig happening to
    // drain. `onCaptured`/`attach` still run; the TIMER simply never fires, which is exactly what a
    // broken `notifyCapture` (a dropped `timer.schedule`) looks like from the outside.
    const rig = buildRig();

    const outcome = await rig.client.capturePhoto(IDENTITY, rig.camera);
    if (outcome.kind !== 'captured') throw new Error(`expected a capture, got ${outcome.kind}`);
    await rig.client.attach(outcome.ref.mediaId, OPERATION_ID);

    // No `runPending()` — the debounce never elapses.
    await rig.client.settle();

    expect((await rowFor(outcome.ref.mediaId))['uploadStatus']).toBe('pending');
    expect(rig.server.sessions.size).toBe(0);
  });

  test('an UNATTACHED capture is never uploaded, even when the drain runs', async () => {
    // 06 §4/§5.1: `attached_to_operation_id IS NOT NULL` is the orphan exclusion — evidence with no
    // signed claim behind it must not leave the device. Asserted here because it is the one drain
    // predicate a capture-side bug (attaching too early, or not at all) can silently defeat.
    const rig = buildRig();
    const outcome = await rig.client.capturePhoto(IDENTITY, rig.camera);
    if (outcome.kind !== 'captured') throw new Error('expected a capture');

    rig.timer.runPending();
    await rig.client.settle();

    expect(rig.server.sessions.size).toBe(0);
    expect((await rowFor(outcome.ref.mediaId))['uploadStatus']).toBe('pending');
  });

  test('the chunk PUTs carry NO Content-Encoding (06 §5.5 / api/03 §7)', async () => {
    const rig = buildRig();
    const outcome = await rig.client.capturePhoto(IDENTITY, rig.camera);
    if (outcome.kind !== 'captured') throw new Error('expected a capture');
    await rig.client.attach(outcome.ref.mediaId, OPERATION_ID);
    rig.timer.runPending();
    await rig.client.settle();

    expect(rig.server.chunkEncodings.length).toBeGreaterThan(0);
    // gzipping an already-compressed JPEG burns 2 GB-device CPU for ~0% gain, and api/03 §7 answers
    // `415 UNSUPPORTED_ENCODING` and stores nothing.
    expect(rig.server.chunkEncodings.every((value) => value === null)).toBe(true);
  });

  test('COMPRESSION IS REAL: the stored bytes are far smaller than the shot, and within §2.2`s caps', async () => {
    const rig = buildRig();
    const outcome = await rig.client.capturePhoto(IDENTITY, rig.camera);
    if (outcome.kind !== 'captured') throw new Error('expected a capture');

    // A pass-through compressor would leave 9 MB here and fail every line below.
    expect(outcome.ref.sizeBytes).toBeLessThan(SHOT_BYTES / 10);
    expect(outcome.ref.sizeBytes).toBeLessThanOrEqual(SIZE_BUDGET_BYTES);
    // Both passes ran: 4000 x 3000 at pass 1's cap is still over 300 KiB in this model, so §2.2
    // step 4's second pass is the branch under test.
    expect(outcome.passes).toBe(2);
    const [first, second] = rig.compressor.calls;
    expect(first?.target).toEqual({ width: 1600 });
    expect(first?.compress).toBe(0.7);
    expect(second?.target).toEqual({ width: 1280 });
    expect(second?.compress).toBe(0.5);
    // Pass 2 re-encodes the ORIGINAL, never pass 1's output — no stacked JPEG generations.
    expect(second?.uri).toBe(SHOT.uri);
  });

  test('crash recovery walks an `uploading` row back to `pending` at start', async () => {
    // 03 §4: an `uploading` row with no live task is a process that died mid-upload. Left alone it
    // is invisible to the drain selection (`pending`/`failed`) FOREVER — an upload that silently
    // never happens again.
    const rig = buildRig();
    const outcome = await rig.client.capturePhoto(IDENTITY, rig.camera);
    if (outcome.kind !== 'captured') throw new Error('expected a capture');
    await sql`UPDATE media_items SET upload_status = 'uploading' WHERE id = ${outcome.ref.mediaId}`.execute(
      db.db,
    );

    const report = await rig.client.start();
    expect(report.recovered).toBe(1);
    expect((await rowFor(outcome.ref.mediaId))['uploadStatus']).toBe('pending');
  });

  test('`start()` reports NO background registration when no platform is wired', async () => {
    // `null` is "trigger (d) is absent", not "it worked". 06 §5.4 makes the background trigger a
    // bonus; what must never happen is a caller believing uploads are queued in the background.
    const report = await buildRig().client.start();
    expect(report.background).toBeNull();
  });
});
