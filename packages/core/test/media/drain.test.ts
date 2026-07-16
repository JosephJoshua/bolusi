// The upload drain loop (06-media-pipeline §5; api/03-media §8's client-behavior column).
//
// Runs the REAL MediaDrainLoop, the REAL state machine, the REAL backoff and the REAL repository
// SQL over a REAL SQLite engine (better-sqlite3 — the production client family). The two fakes are
// at I/O boundaries only (T-7): the transport and the filesystem. `_fixtures.ts`'s header states
// exactly what the fake server does and does not prove — read it before trusting a number here.
//
// No clock, no RNG, no timers, no sleeps (T-6). Every backoff assertion below is arithmetic on a
// FakeClock, not a wait.
import { sql } from 'kysely';
import { beforeEach, describe, expect, it } from 'vitest';

import { MediaDrainLoop, recoverInterruptedUploads } from '../../src/index.js';
import {
  FakeClock,
  WIRE_CHUNK_SIZE,
  flipByte,
  jpegBytes,
  openMediaHarness,
  readStatus,
  seedMediaItem,
  sha256Hex,
  type MediaHarness,
} from './_fixtures.js';

let h: MediaHarness;

beforeEach(async () => {
  h = await openMediaHarness();
});

function loopFor(harness: MediaHarness): MediaDrainLoop<never> {
  return new MediaDrainLoop({
    db: harness.db as never,
    transport: harness.server,
    files: harness.files,
    clock: harness.clock,
    surface: harness.surface,
  });
}

/** A media item whose bytes exist on the fake filesystem and whose row is attached to an op. */
async function givenCapture(
  harness: MediaHarness,
  id: string,
  bytes: Uint8Array,
  extra: Partial<Parameters<typeof seedMediaItem>[1]> = {},
): Promise<string> {
  const path = `/doc/media/${id}.jpg`;
  harness.files.write(path, bytes);
  await seedMediaItem(harness.db, {
    id,
    sizeBytes: bytes.byteLength,
    sha256: sha256Hex(bytes),
    capturedAt: 1_000,
    localPath: path,
    ...extra,
  });
  return path;
}

describe('a multi-chunk upload, end to end (task 18 acceptance: the fake-server drain suite completes)', () => {
  it('walks pending -> uploaded and the server holds byte-identical content', async () => {
    // 4 chunks + 3 bytes — the CHAOS-09 fixture size (testing-guide), so the last chunk is a
    // 3-byte remainder rather than a convenient full one.
    const bytes = jpegBytes(4 * WIRE_CHUNK_SIZE + 3);
    await givenCapture(h, 'm-1', bytes);

    const loop = loopFor(h);
    loop.requestDrain('capture');
    await loop.settle();

    const row = await readStatus(h.db, 'm-1');
    expect(row.uploadStatus).toBe('uploaded');
    expect(row.uploadedAt).toBe(h.clock.now());
    expect(row.uploadAttempts).toBe(0);

    // The real assertion: the server's assembled blob is byte-for-byte our capture.
    const served = await h.server.download('m-1');
    expect(sha256Hex(served)).toBe(sha256Hex(bytes));
    expect(served.byteLength).toBe(bytes.byteLength);
  });

  it('pins the SERVER-DICTATED chunk geometry rather than assuming one (06 §4; api/03 §4)', async () => {
    const bytes = jpegBytes(WIRE_CHUNK_SIZE + 10);
    await givenCapture(h, 'm-2', bytes);
    const loop = loopFor(h);
    loop.requestDrain('manual');
    await loop.settle();

    const row = await h.db
      .selectFrom('mediaItems')
      .select(['chunkSize', 'chunksTotal'])
      .where('id', '=', 'm-2' as never)
      .executeTakeFirstOrThrow();
    expect(row.chunkSize).toBe(WIRE_CHUNK_SIZE);
    expect(row.chunksTotal).toBe(2);
  });
});

describe('resume is SERVER-authoritative — local progress lies, the server wins (06 §5.1; 03 §4)', () => {
  it('sends exactly the chunks the server lacks, even when the server holds fewer than we sent', async () => {
    const bytes = jpegBytes(4 * WIRE_CHUNK_SIZE);
    await givenCapture(h, 'm-3', bytes);

    // Pre-load the server with chunks 0 and 1 only — as if a previous attempt died after two.
    await h.server.init('m-3', {
      sizeBytes: bytes.byteLength,
      sha256: sha256Hex(bytes),
      mime: 'image/jpeg',
      type: 'image',
      metadata: { capturedAt: 1_000, location: null, userId: 'u-1', deviceId: 'd-1' },
    });
    for (const i of [0, 1]) {
      await h.server.putChunk(
        'm-3',
        i,
        bytes.subarray(i * WIRE_CHUNK_SIZE, (i + 1) * WIRE_CHUNK_SIZE),
      );
    }
    h.server.putLog.length = 0; // only count what the DRAIN sends

    const loop = loopFor(h);
    loop.requestDrain('manual');
    await loop.settle();

    expect((await readStatus(h.db, 'm-3')).uploadStatus).toBe('uploaded');
    // Exactly {2,3} — not {0,1,2,3} (a restart) and not {} (trusting a local claim).
    expect(h.server.putLog.map((p) => p.index)).toEqual([2, 3]);
  });

  it('a server claiming MORE than we believe shrinks the send set to the true missing one', async () => {
    const bytes = jpegBytes(3 * WIRE_CHUNK_SIZE);
    await givenCapture(h, 'm-4', bytes);
    await h.server.init('m-4', {
      sizeBytes: bytes.byteLength,
      sha256: sha256Hex(bytes),
      mime: 'image/jpeg',
      type: 'image',
      metadata: { capturedAt: 1_000, location: null, userId: 'u-1', deviceId: 'd-1' },
    });
    for (const i of [0, 1, 2]) {
      await h.server.putChunk(
        'm-4',
        i,
        bytes.subarray(i * WIRE_CHUNK_SIZE, (i + 1) * WIRE_CHUNK_SIZE),
      );
    }
    h.server.putLog.length = 0;

    const loop = loopFor(h);
    loop.requestDrain('manual');
    await loop.settle();

    // The client believed nothing was sent (it persists no progress); the server had everything.
    expect(h.server.putLog).toEqual([]);
    expect((await readStatus(h.db, 'm-4')).uploadStatus).toBe('uploaded');
  });

  it('local progress is never persisted as resume input — no column holds it', async () => {
    // The structural version of the claim above. 10-db §9.4 stores `chunk_size`/`chunks_total`
    // (server facts) and NO progress column; if one were ever added, this test names why not.
    const info = await sql<{ name: string }>`PRAGMA table_info(media_items)`.execute(h.db);
    const names = info.rows.map((r) => r.name);
    // Denominator (T-14): 10-db §9.4 declares 21 columns. A starved PRAGMA returning 0 rows would
    // satisfy every `not.toContain` below while proving nothing at all.
    expect(names).toHaveLength(21);
    expect(names).toContain('chunk_size');
    expect(names).not.toContain('chunks_received');
    expect(names).not.toContain('upload_progress');
    expect(names).not.toContain('bytes_sent');
  });
});

describe('crash recovery (03 §4: app restart finds no live upload task)', () => {
  it('resets uploading -> pending at startup and resumes WITHOUT re-sending held chunks', async () => {
    const bytes = jpegBytes(3 * WIRE_CHUNK_SIZE);
    await givenCapture(h, 'm-5', bytes, { uploadStatus: 'uploading' });
    // The server kept chunks 0-1 from the dead process.
    await h.server.init('m-5', {
      sizeBytes: bytes.byteLength,
      sha256: sha256Hex(bytes),
      mime: 'image/jpeg',
      type: 'image',
      metadata: { capturedAt: 1_000, location: null, userId: 'u-1', deviceId: 'd-1' },
    });
    for (const i of [0, 1]) {
      await h.server.putChunk(
        'm-5',
        i,
        bytes.subarray(i * WIRE_CHUNK_SIZE, (i + 1) * WIRE_CHUNK_SIZE),
      );
    }
    h.server.putLog.length = 0;

    // Positive control (T-17): the row really IS stuck in `uploading` before we recover it —
    // otherwise "recovered 1" and "there was nothing to recover" look identical.
    expect((await readStatus(h.db, 'm-5')).uploadStatus).toBe('uploading');
    const recovered = await recoverInterruptedUploads(h.db as never);
    expect(recovered).toBe(1);
    expect((await readStatus(h.db, 'm-5')).uploadStatus).toBe('pending');

    const loop = loopFor(h);
    loop.requestDrain('periodic');
    await loop.settle();

    expect((await readStatus(h.db, 'm-5')).uploadStatus).toBe('uploaded');
    // Resume, never restart (06 §5.1): chunk 0 and 1 were NOT re-sent.
    expect(h.server.putLog.map((p) => p.index)).toEqual([2]);
  });

  it('recovery retains uploadAttempts — a crash is not an excuse to reset the surfacing counter', async () => {
    await givenCapture(h, 'm-6', jpegBytes(100), { uploadStatus: 'uploading', uploadAttempts: 3 });
    await recoverInterruptedUploads(h.db as never);
    expect((await readStatus(h.db, 'm-6')).uploadAttempts).toBe(3);
  });
});

describe('backoff (03 §4.1: 5s -> 15s -> 60s -> 5min cap, indexed by uploadAttempts)', () => {
  it('each successive failure schedules the next delay in the schedule, capping at 5 min', async () => {
    const expected = [5_000, 15_000, 60_000, 300_000, 300_000, 300_000];
    let checked = 0;

    for (const [i, delay] of expected.entries()) {
      const harness = await openMediaHarness();
      const clock = new FakeClock(2_000_000);
      harness.clock.set(clock.now());
      await givenCapture(harness, `b-${i}`, jpegBytes(50), { uploadAttempts: i });
      // A retryable server error: 500 STORAGE_ERROR (api/03 §8: "Retryable with backoff").
      harness.server.faults.failNextWith = { method: 'init', code: 'STORAGE_ERROR', status: 500 };

      const loop = loopFor(harness);
      loop.requestDrain('manual');
      await loop.settle();

      const row = await readStatus(harness.db, `b-${i}`);
      expect(row.uploadStatus).toBe('failed');
      expect(row.uploadAttempts).toBe(i + 1);
      expect(row.nextAttemptAt, `after ${i + 1} attempts`).toBe(harness.clock.now() + delay);
      checked += 1;
    }
    // Denominator (T-14): all six rungs, including the two past the cap.
    expect(checked).toBe(6);
  });

  it('an item still inside its backoff window is not selected', async () => {
    await givenCapture(h, 'm-7', jpegBytes(50), {
      uploadStatus: 'failed',
      uploadAttempts: 1,
      nextAttemptAt: h.clock.now() + 5_000,
    });
    const loop = loopFor(h);
    loop.requestDrain('periodic');
    await loop.settle();
    expect(h.server.putLog).toEqual([]);
    expect((await readStatus(h.db, 'm-7')).uploadStatus).toBe('failed');
  });

  it('the same item IS selected once the clock passes nextAttemptAt', async () => {
    const bytes = jpegBytes(50);
    await givenCapture(h, 'm-8', bytes, {
      uploadStatus: 'failed',
      uploadAttempts: 1,
      nextAttemptAt: h.clock.now() + 5_000,
    });
    h.clock.advance(5_000);
    const loop = loopFor(h);
    loop.requestDrain('periodic');
    await loop.settle();
    expect((await readStatus(h.db, 'm-8')).uploadStatus).toBe('uploaded');
  });

  it('connectivity regained clears nextAttemptAt on failed items but RETAINS uploadAttempts', async () => {
    await givenCapture(h, 'm-9', jpegBytes(50), {
      uploadStatus: 'failed',
      uploadAttempts: 3,
      nextAttemptAt: h.clock.now() + 300_000,
      lastErrorCode: 'STORAGE_ERROR',
    });
    const loop = loopFor(h);
    await loop.onConnectivityRegained();
    await loop.settle();

    const row = await readStatus(h.db, 'm-9');
    // It drained immediately (the backoff was cleared) rather than waiting out 5 minutes.
    expect(row.uploadStatus).toBe('uploaded');
  });

  it('connectivity regained does NOT revive an auto-retry-exempt item — the network was never its problem', async () => {
    await givenCapture(h, 'm-10', jpegBytes(50), {
      uploadStatus: 'failed',
      uploadAttempts: 2,
      nextAttemptAt: null,
      lastErrorCode: 'LOCAL_CORRUPT',
    });
    const loop = loopFor(h);
    await loop.onConnectivityRegained();
    await loop.settle();

    expect((await readStatus(h.db, 'm-10')).uploadStatus).toBe('failed');
    expect(h.server.putLog).toEqual([]);
  });

  it('uploadAttempts >= 5 raises the persistent-failure flag while retries continue at the cap', async () => {
    await givenCapture(h, 'm-11', jpegBytes(50), { uploadAttempts: 4 });
    h.server.faults.failNextWith = { method: 'init', code: 'STORAGE_ERROR', status: 500 };
    const loop = loopFor(h);
    loop.requestDrain('manual');
    await loop.settle();

    const event = h.surface.events.at(-1);
    expect(event?.persistentlyFailing).toBe(true);
    expect(event?.autoRetryExempt).toBe(false); // still retrying (03 §4.1)
    const row = await readStatus(h.db, 'm-11');
    expect(row.uploadAttempts).toBe(5);
    expect(row.nextAttemptAt).toBe(h.clock.now() + 300_000); // capped, still scheduled
  });
});

describe('api/03 §8 per-code client behavior', () => {
  it('CHUNKS_MISSING is the normal resume path: send the listed chunks and retry complete', async () => {
    const bytes = jpegBytes(2 * WIRE_CHUNK_SIZE);
    await givenCapture(h, 'm-12', bytes);
    // The server reports it holds everything (a lie), so the drain sends nothing and calls
    // complete — which answers CHUNKS_MISSING with the true list.
    h.server.faults.lieAboutReceivedChunks = [0, 1];

    const loop = loopFor(h);
    loop.requestDrain('manual');
    await loop.settle();

    expect((await readStatus(h.db, 'm-12')).uploadStatus).toBe('uploaded');
    // It recovered by sending exactly what `missingChunks` named.
    expect(h.server.putLog.map((p) => p.index).sort()).toEqual([0, 1]);
  });

  it('DEVICE_REVOKED halts the WHOLE drain, not just the current item', async () => {
    await givenCapture(h, 'a-1', jpegBytes(50), { capturedAt: 1_000 });
    await givenCapture(h, 'a-2', jpegBytes(50), { capturedAt: 2_000 });
    h.server.faults.failNextWith = { method: 'init', code: 'DEVICE_REVOKED', status: 401 };

    const loop = loopFor(h);
    loop.requestDrain('manual');
    await loop.settle();

    expect(loop.isHalted).toBe(true);
    expect((await readStatus(h.db, 'a-1')).lastErrorCode).toBe('DEVICE_REVOKED');
    // The second item was never attempted — the halt is drain-wide.
    expect((await readStatus(h.db, 'a-2')).uploadStatus).toBe('pending');
  });

  it('a halted loop ignores further triggers — there is no automatic exit', async () => {
    await givenCapture(h, 'a-3', jpegBytes(50));
    h.server.faults.failNextWith = { method: 'init', code: 'DEVICE_REVOKED', status: 401 };
    const loop = loopFor(h);
    loop.requestDrain('manual');
    await loop.settle();
    h.server.putLog.length = 0;

    loop.requestDrain('connectivity');
    await loop.settle();
    expect(h.server.putLog).toEqual([]);
  });

  // EXACTLY the four codes task 18's acceptance and api/03 §8 exempt: the two whose column says
  // "no auto-retry" verbatim, plus the two their owning specs exempt by name (06 §5.1, §8).
  it.each([
    ['INIT_MISMATCH', 409],
    ['MIME_MISMATCH', 422],
  ])('%s is flagged individually and exempt from auto-retry', async (code, status) => {
    const harness = await openMediaHarness();
    await givenCapture(harness, 'x-1', jpegBytes(50));
    harness.server.faults.failNextWith = { method: 'init', code, status };
    const loop = loopFor(harness);
    loop.requestDrain('manual');
    await loop.settle();

    const row = await readStatus(harness.db, 'x-1');
    expect(row.uploadStatus).toBe('failed');
    expect(row.lastErrorCode).toBe(code);
    // No auto-retry: nextAttemptAt is null AND a subsequent automatic trigger skips it.
    expect(row.nextAttemptAt).toBeNull();
    expect(harness.surface.events.at(-1)?.autoRetryExempt).toBe(true);

    harness.server.putLog.length = 0;
    loop.requestDrain('periodic');
    await loop.settle();
    expect(harness.server.putLog).toEqual([]);
  });

  // 03 §4.1: "retries continue at the 5-min cap forever — surfacing escalates visibility, never
  // stops retrying." §8's "Bug; surface" rows (MIME_UNSUPPORTED, CHUNK_SIZE_INVALID,
  // MEDIA_TOO_LARGE...) say SURFACE, not STOP — so they keep retrying while being loud. Sweeping
  // them into the exempt set contradicts 03 §4.1 and permanently strands evidence.
  it.each([
    ['RATE_LIMITED', 429],
    ['STORAGE_ERROR', 500],
    ['MEDIA_NOT_FOUND', 404],
    ['MIME_UNSUPPORTED', 422],
    ['CHUNK_SIZE_INVALID', 422],
    ['MEDIA_TOO_LARGE', 413],
  ])('%s is retryable under backoff', async (code, status) => {
    const harness = await openMediaHarness();
    await givenCapture(harness, 'r-1', jpegBytes(50));
    harness.server.faults.failNextWith = { method: 'init', code, status };
    const loop = loopFor(harness);
    loop.requestDrain('manual');
    await loop.settle();

    const row = await readStatus(harness.db, 'r-1');
    expect(row.lastErrorCode).toBe(code);
    expect(row.nextAttemptAt).toBe(harness.clock.now() + 5_000);
    expect(harness.surface.events.at(-1)?.autoRetryExempt).toBe(false);
  });

  it('an UNKNOWN server code is surfaced and treated as non-retryable, never dropped (api/00 §4)', async () => {
    await givenCapture(h, 'u-1', jpegBytes(50));
    h.server.faults.failNextWith = { method: 'init', code: 'SOME_FUTURE_CODE', status: 418 };
    const loop = loopFor(h);
    loop.requestDrain('manual');
    await loop.settle();

    const row = await readStatus(h.db, 'u-1');
    expect(row.lastErrorCode).toBe('SOME_FUTURE_CODE');
    // The key is DERIVED, so a code this client has never heard of still surfaces (07-i18n §4.3).
    expect(h.surface.events.at(-1)?.labelKey).toBe('core.errors.SOME_FUTURE_CODE');
    // It retries under the capped backoff rather than being stranded: the only mechanism that can
    // say "never" is the closed exempt list, and an unknown code is not on it. Backing off costs
    // one request per 5 min; exempting would silently strand evidence over a new server code.
    expect(row.nextAttemptAt).toBe(h.clock.now() + 5_000);
  });

  it('a dropped connection (no response, no code) is retryable — not a protocol error', async () => {
    const bytes = jpegBytes(2 * WIRE_CHUNK_SIZE);
    await givenCapture(h, 'n-1', bytes);
    h.server.faults.dropAtChunkIndex = 1;
    const loop = loopFor(h);
    loop.requestDrain('manual');
    await loop.settle();

    const row = await readStatus(h.db, 'n-1');
    expect(row.uploadStatus).toBe('failed');
    expect(row.lastErrorCode).toBe('NETWORK');
    expect(row.nextAttemptAt).toBe(h.clock.now() + 5_000);
  });
});

describe('HASH_MISMATCH — the fork where our own bytes are the suspect (06 §5.1)', () => {
  it('local file still matches the signed hash => retry from chunk 0 under normal backoff', async () => {
    const bytes = jpegBytes(2 * WIRE_CHUNK_SIZE);
    await givenCapture(h, 'hm-1', bytes);
    // Inject the CAUSE, not the symptom: the server stores chunk 1 corrupted, so ITS OWN §3.4
    // assembly hashes wrong, returns HASH_MISMATCH, and performs the real chunk purge. Injecting
    // the error code directly would skip the purge and prove nothing about resume (T-13).
    h.server.faults.corruptStoredChunk = 1;

    const loop = loopFor(h);
    loop.requestDrain('manual');
    await loop.settle();

    const row = await readStatus(h.db, 'hm-1');
    // The transfer was at fault, not the file: retryable, and NOT flagged LOCAL_CORRUPT.
    expect(row.lastErrorCode).toBe('HASH_MISMATCH');
    expect(row.nextAttemptAt).toBe(h.clock.now() + 5_000);
    // The purge really happened — the precondition for the restart below (T-14b: assert the
    // fixture, don't infer it from the absence of chunks).
    expect((await h.server.status('hm-1')).receivedChunks).toEqual([]);

    // And the retry genuinely restarts from chunk 0, because the server purged its chunks.
    h.clock.advance(5_000);
    h.server.putLog.length = 0;
    loop.requestDrain('periodic');
    await loop.settle();
    expect(h.server.putLog.map((p) => p.index)).toEqual([0, 1]);
    expect((await readStatus(h.db, 'hm-1')).uploadStatus).toBe('uploaded');
  });

  it('local file no longer matches => LOCAL_CORRUPT, no auto-retry, surfaced (FR-819)', async () => {
    const bytes = jpegBytes(WIRE_CHUNK_SIZE);
    const path = await givenCapture(h, 'hm-2', bytes);
    // A bit-flip AFTER capture — 06 §10's "tampered local file" case. The row's `sha256` still
    // pins the ORIGINAL bytes, which is precisely what makes this unrecoverable as evidence.
    const rotted = flipByte(new Uint8Array(bytes), 5_000);
    h.files.write(path, rotted);
    h.server.faults.failNextWith = { method: 'complete', code: 'HASH_MISMATCH', status: 422 };

    const loop = loopFor(h);
    loop.requestDrain('manual');
    await loop.settle();

    const row = await readStatus(h.db, 'hm-2');
    expect(row.lastErrorCode).toBe('LOCAL_CORRUPT');
    expect(row.nextAttemptAt).toBeNull();
    expect(h.surface.events.at(-1)?.autoRetryExempt).toBe(true);
    expect(h.surface.events.at(-1)?.labelKey).toBe('core.errors.LOCAL_CORRUPT');

    // No retry loop (06 §10: "no retry loop, surfaced").
    h.server.putLog.length = 0;
    loop.requestDrain('periodic');
    await loop.settle();
    expect(h.server.putLog).toEqual([]);
  });
});

describe('MEDIA_IMMUTABLE — attach-then-replace is refused, and success is never assumed', () => {
  it('our sha256 == the servers => treat as success, item is uploaded (api/03 §8)', async () => {
    const bytes = jpegBytes(WIRE_CHUNK_SIZE);
    await givenCapture(h, 'im-1', bytes);
    // Drive a full upload, then re-seed the row as pending: the crash-after-complete shape.
    const loop = loopFor(h);
    loop.requestDrain('manual');
    await loop.settle();
    expect((await readStatus(h.db, 'im-1')).uploadStatus).toBe('uploaded');

    await h.db
      .updateTable('mediaItems')
      .set({ uploadStatus: 'pending', uploadedAt: null } as never)
      .where('id', '=', 'im-1' as never)
      .execute();

    loop.requestDrain('manual');
    await loop.settle();
    // init returned 409 MEDIA_IMMUTABLE; the hash matched; the item converged to uploaded.
    expect((await readStatus(h.db, 'im-1')).uploadStatus).toBe('uploaded');
  });

  // The "our sha256 != the server's" leg lives in adversarial.test.ts ('a server holding
  // DIFFERENT bytes under our id never causes an overwrite attempt'), not here — and the reason is
  // worth recording. The version that lived here constructed its fixture by UPDATEing the row's
  // `sha256`, which `bolusi/no-media-column-update` correctly refused. That refusal was right on
  // the merits, not a lint technicality: `sha256` is frozen at capture (06 §4), so "our row's hash
  // changed" is a state production CANNOT reach, and the test was proving the client's response to
  // an impossible input by violating the very invariant under test. The adversarial version builds
  // the REACHABLE version of the same scenario — a server holding different bytes under our id —
  // with no mutation at all, which is why this rule needs no allowlist anywhere in the repo.
  it('MEDIA_IMMUTABLE with an unconfirmable hash FAILS CLOSED — never assumes success', async () => {
    // The dangerous shape: if this returned `uploaded`, the pruning pass would delete the local
    // file 7 days later (06 §7) and the evidence would be gone for good.
    const bytes = jpegBytes(WIRE_CHUNK_SIZE);
    await givenCapture(h, 'im-3', bytes);
    const loop = loopFor(h);
    loop.requestDrain('manual');
    await loop.settle();

    await h.db
      .updateTable('mediaItems')
      .set({ uploadStatus: 'pending', uploadedAt: null } as never)
      .where('id', '=', 'im-3' as never)
      .execute();
    // The server answers MEDIA_IMMUTABLE but the hash question cannot be answered.
    h.server.faults.failNextWith = { method: 'download', code: 'MEDIA_NOT_FOUND', status: 404 };
    const original = h.server.matchesServerHash.bind(h.server);
    h.server.matchesServerHash = async () => {
      throw new Error('unreachable');
    };

    loop.requestDrain('manual');
    await loop.settle();
    h.server.matchesServerHash = original;

    const row = await readStatus(h.db, 'im-3');
    expect(row.uploadStatus).toBe('failed');
    expect(row.lastErrorCode).toBe('LOCAL_CORRUPT');
  });
});

describe('selection (06 §5.1)', () => {
  it('processes oldest capturedAt first — oldest evidence wins the uplink', async () => {
    await givenCapture(h, 'o-newest', jpegBytes(50), { capturedAt: 9_000 });
    await givenCapture(h, 'o-oldest', jpegBytes(50), { capturedAt: 1_000 });
    await givenCapture(h, 'o-middle', jpegBytes(50), { capturedAt: 5_000 });

    const loop = loopFor(h);
    loop.requestDrain('manual');
    await loop.settle();

    expect(h.server.putLog.map((p) => p.mediaId)).toEqual(['o-oldest', 'o-middle', 'o-newest']);
  });

  it('ORPHANS never upload — an unattached capture has no signed claim behind it', async () => {
    // Positive control (T-17) first: an ATTACHED sibling proves the drain is actually running,
    // so "the orphan did not upload" cannot be satisfied by a drain that did nothing.
    await givenCapture(h, 'orphan', jpegBytes(50), { attachedToOperationId: null });
    await givenCapture(h, 'attached', jpegBytes(50), { attachedToOperationId: 'op-9' });

    const loop = loopFor(h);
    loop.requestDrain('manual');
    await loop.settle();

    expect(h.server.putLog.map((p) => p.mediaId)).toEqual(['attached']);
    expect((await readStatus(h.db, 'attached')).uploadStatus).toBe('uploaded');
    expect((await readStatus(h.db, 'orphan')).uploadStatus).toBe('pending');
    expect(h.server.media.has('orphan')).toBe(false);
  });

  it('an uploaded item is never re-selected (uploaded is terminal)', async () => {
    await givenCapture(h, 'done', jpegBytes(50), {
      uploadStatus: 'uploaded',
      uploadedAt: 500,
    });
    const loop = loopFor(h);
    loop.requestDrain('manual');
    await loop.settle();
    expect(h.server.putLog).toEqual([]);
  });
});

describe('single-flight (06 §5.2: triggers coalesce into exactly one re-run)', () => {
  it('N triggers during a run produce exactly ONE re-run — a flag, not a counter', async () => {
    await givenCapture(h, 's-1', jpegBytes(50));
    let passes = 0;
    const loop = loopFor(h);
    const server = h.server;
    const originalInit = server.init.bind(server);
    server.init = async (id, req) => {
      passes += 1;
      // Fire five more triggers WHILE the first pass is in flight.
      for (let i = 0; i < 5; i += 1) loop.requestDrain('periodic');
      return originalInit(id, req);
    };

    loop.requestDrain('capture');
    await loop.settle();

    // Pass 1 uploads the item; the coalesced re-run finds nothing left to do. Without
    // coalescing this would be 6. The item being `uploaded` after pass 1 is what makes the
    // re-run a no-op rather than a second upload.
    expect(passes).toBe(1);
    expect((await readStatus(h.db, 's-1')).uploadStatus).toBe('uploaded');
  });

  it('a trigger during a run re-runs once, picking up work that arrived mid-pass', async () => {
    await givenCapture(h, 's-2', jpegBytes(50), { capturedAt: 1_000 });
    const loop = loopFor(h);
    const server = h.server;
    const originalComplete = server.complete.bind(server);
    let injected = false;
    server.complete = async (id) => {
      const result = await originalComplete(id);
      if (!injected) {
        injected = true;
        // A capture lands while the pass is still running.
        await givenCapture(h, 's-3', jpegBytes(50), { capturedAt: 2_000 });
        loop.requestDrain('capture');
      }
      return result;
    };

    loop.requestDrain('capture');
    await loop.settle();

    // The coalesced re-run picked it up — no trigger was lost.
    expect((await readStatus(h.db, 's-3')).uploadStatus).toBe('uploaded');
  });
});
