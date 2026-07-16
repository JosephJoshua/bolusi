// ADVERSARIAL — media upload/download is a security surface, so these ship BEFORE review
// (CLAUDE.md §2.5; testing-guide T-9). CHAOS-10 (gzip) style is the floor, not the ceiling.
//
// THE THREAT MODEL THESE ENCODE. The client cannot assume the thing it is talking to is our
// server. A device on a shop's wifi behind a hostile proxy, a MITM with a trusted-store cert, or
// simply a buggy deploy can return: a resume offset that lies in either direction, a
// `receivedChunks` full of nonsense, bytes that are not what was signed, a `MEDIA_IMMUTABLE` for
// media it does not hold. None of those may corrupt local state, and none may cause EVIDENCE to be
// marked uploaded when it is not — because 06 §7 deletes the local file 7 days after `uploadedAt`,
// so a false `uploaded` is not a display bug, it is destroyed evidence on a timer.
//
// Scope (D16 clause 3): these prove the CLIENT's resistance. They say nothing about the server —
// SEC-MEDIA-01..06 are api/03 §9's server-endpoint tests and ship with task 19. No SEC-* id is
// claimed here (task 18's brief is explicit: "No SEC-* id may be marked done by this task").
import { beforeEach, describe, expect, it } from 'vitest';

import { MediaDrainLoop, fetchAndVerifyMedia, missingChunks } from '../../src/index.js';
import { noblePort } from '@bolusi/test-support';
import {
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

async function givenCapture(harness: MediaHarness, id: string, bytes: Uint8Array): Promise<void> {
  harness.files.write(`/doc/media/${id}.jpg`, bytes);
  await seedMediaItem(harness.db, {
    id,
    sizeBytes: bytes.byteLength,
    sha256: sha256Hex(bytes),
    capturedAt: 1_000,
    localPath: `/doc/media/${id}.jpg`,
  });
}

describe('a LYING server cannot corrupt local state', () => {
  it('receivedChunks containing out-of-range indices cannot shrink the set we send', async () => {
    // The attack: convince the client chunks are already there so it uploads a PARTIAL file and
    // calls complete — or, worse, so it skips a chunk that the attacker then supplies.
    const bytes = jpegBytes(3 * WIRE_CHUNK_SIZE);
    await givenCapture(h, 'adv-1', bytes);
    h.server.faults.lieAboutReceivedChunks = [0, 1, 2, 99, -1, 2 ** 31];

    const loop = loopFor(h);
    loop.requestDrain('manual');
    await loop.settle();

    // The client sent nothing on the strength of the lie, complete answered CHUNKS_MISSING with
    // the TRUTH, and the client recovered by sending exactly the real missing set.
    expect(h.server.putLog.map((p) => p.index).sort((a, b) => a - b)).toEqual([0, 1, 2]);
    expect((await readStatus(h.db, 'adv-1')).uploadStatus).toBe('uploaded');
    // And the stored file is the real one, entire.
    expect(sha256Hex(await h.server.download('adv-1'))).toBe(sha256Hex(bytes));
  });

  it('missingChunks is derived from OUR totalChunks — a hostile list cannot widen or corrupt it', () => {
    // Unit-level, because this is the arithmetic everything above rests on. A server claiming to
    // hold chunk 99 of a 3-chunk file must not make us skip a real one; claiming -1 must not
    // corrupt the walk.
    expect(missingChunks(3, [99, -1, 2 ** 31, 1.5])).toEqual([0, 1, 2]);
    expect(missingChunks(3, [0, 1, 2])).toEqual([]);
    expect(missingChunks(3, [])).toEqual([0, 1, 2]);
    // A server reporting a duplicate does not double-subtract.
    expect(missingChunks(3, [1, 1, 1])).toEqual([0, 2]);
  });

  it('a server that always claims chunks are missing cannot spin the client forever', async () => {
    const bytes = jpegBytes(WIRE_CHUNK_SIZE);
    await givenCapture(h, 'adv-2', bytes);
    // Perpetual liar: complete always says chunk 0 is missing, even after we send it.
    const server = h.server;
    server.complete = async () => {
      const { MediaTransportError } = await import('../../src/media/ports.js');
      throw new MediaTransportError('always missing', {
        code: 'CHUNKS_MISSING',
        status: 422,
        missingChunks: [0],
      });
    };

    const loop = loopFor(h);
    loop.requestDrain('manual');
    await loop.settle();

    // Bounded: the client gave up, recorded a retryable failure, and did NOT loop forever. The
    // test completing at all is half the assertion.
    const row = await readStatus(h.db, 'adv-2');
    expect(row.uploadStatus).toBe('failed');
    expect(row.lastErrorCode).toBe('CHUNKS_MISSING');
    // It re-sent chunk 0 at most twice (the bounded retry), not indefinitely.
    expect(h.server.putLog.length).toBeLessThanOrEqual(2);
  });

  it('a server claiming MEDIA_IMMUTABLE for media it does not hold cannot mark evidence uploaded', async () => {
    // The nastiest lie available: "you already uploaded this". Believing it marks the item
    // `uploaded`, and 06 §7 then deletes the local file after 7 days — evidence gone.
    const bytes = jpegBytes(WIRE_CHUNK_SIZE);
    await givenCapture(h, 'adv-3', bytes);
    h.server.faults.failNextWith = { method: 'init', code: 'MEDIA_IMMUTABLE', status: 409 };

    const loop = loopFor(h);
    loop.requestDrain('manual');
    await loop.settle();

    // The hash could not be confirmed (the server holds nothing) ⇒ fails CLOSED.
    const row = await readStatus(h.db, 'adv-3');
    expect(row.uploadStatus).not.toBe('uploaded');
    expect(row.uploadStatus).toBe('failed');
    expect(row.lastErrorCode).toBe('LOCAL_CORRUPT');
    expect(row.uploadedAt).toBeNull(); // the prune clock never started
  });

  it('a server holding DIFFERENT bytes under our id never causes an overwrite attempt', async () => {
    const ours = jpegBytes(WIRE_CHUNK_SIZE, 3);
    const theirs = jpegBytes(WIRE_CHUNK_SIZE, 77);
    await givenCapture(h, 'adv-4', ours);
    // Pre-complete the id with someone else's bytes.
    await h.server.init('adv-4', {
      sizeBytes: theirs.byteLength,
      sha256: sha256Hex(theirs),
      mime: 'image/jpeg',
      type: 'image',
      metadata: { capturedAt: 1, location: null, userId: 'u-1', deviceId: 'd-1' },
    });
    await h.server.putChunk('adv-4', 0, theirs);
    await h.server.complete('adv-4');
    h.server.putLog.length = 0;

    const loop = loopFor(h);
    loop.requestDrain('manual');
    await loop.settle();

    const row = await readStatus(h.db, 'adv-4');
    expect(row.lastErrorCode).toBe('LOCAL_CORRUPT');
    expect(row.uploadStatus).toBe('failed');
    // NEVER OVERWRITE (api/03 §8): not one chunk was PUT at the immutable id.
    expect(h.server.putLog).toEqual([]);
    expect(sha256Hex(await h.server.download('adv-4'))).toBe(sha256Hex(theirs));
  });
});

describe('download hash verification actually rejects tampered bytes (06 §6)', () => {
  it('a tampered download is discarded and never returned for display', async () => {
    const bytes = jpegBytes(WIRE_CHUNK_SIZE);
    await givenCapture(h, 'dl-1', bytes);
    const loop = loopFor(h);
    loop.requestDrain('manual');
    await loop.settle();

    // POSITIVE CONTROL (T-17): the untampered fetch verifies, so a later `mismatch` cannot be
    // satisfied by a download that simply never worked.
    const clean = await fetchAndVerifyMedia(
      { transport: h.server, crypto: noblePort },
      'dl-1',
      sha256Hex(bytes),
    );
    expect(clean.kind).toBe('ok');

    // Now flip one bit in flight. The stored blob is untouched; only the response is corrupted.
    h.server.faults.tamperDownload = (b) => {
      return flipByte(new Uint8Array(b), 500);
    };
    const result = await fetchAndVerifyMedia(
      { transport: h.server, crypto: noblePort },
      'dl-1',
      sha256Hex(bytes),
    );

    expect(result.kind).toBe('mismatch');
    if (result.kind === 'mismatch') {
      expect(result.expected).toBe(sha256Hex(bytes));
      expect(result.actual).not.toBe(sha256Hex(bytes));
    }
  });

  it('a single transient corruption is recovered by the ONE refetch (06 §6)', async () => {
    const bytes = jpegBytes(1_000);
    await givenCapture(h, 'dl-2', bytes);
    const loop = loopFor(h);
    loop.requestDrain('manual');
    await loop.settle();

    let calls = 0;
    h.server.faults.tamperDownload = (b) => {
      calls += 1;
      if (calls > 1) return b; // only the first fetch is corrupted
      return flipByte(new Uint8Array(b), 10);
    };

    const result = await fetchAndVerifyMedia(
      { transport: h.server, crypto: noblePort },
      'dl-2',
      sha256Hex(bytes),
    );
    expect(result.kind).toBe('ok');
    expect(calls).toBe(2); // discarded once, refetched once — exactly 06 §6's rule
  });

  it('persistent corruption surfaces after exactly one refetch — it does not hammer the server', async () => {
    const bytes = jpegBytes(1_000);
    await givenCapture(h, 'dl-3', bytes);
    const loop = loopFor(h);
    loop.requestDrain('manual');
    await loop.settle();

    let calls = 0;
    h.server.faults.tamperDownload = (b) => {
      calls += 1;
      return flipByte(new Uint8Array(b), 10);
    };
    const result = await fetchAndVerifyMedia(
      { transport: h.server, crypto: noblePort },
      'dl-3',
      sha256Hex(bytes),
    );
    expect(result.kind).toBe('mismatch');
    expect(calls).toBe(2); // "refetch ONCE, then surface" — not a loop
  });

  it('a truncated download is rejected — a short body is not a valid image', async () => {
    const bytes = jpegBytes(2_000);
    await givenCapture(h, 'dl-4', bytes);
    const loop = loopFor(h);
    loop.requestDrain('manual');
    await loop.settle();

    h.server.faults.tamperDownload = (b) => b.subarray(0, 100);
    const result = await fetchAndVerifyMedia(
      { transport: h.server, crypto: noblePort },
      'dl-4',
      sha256Hex(bytes),
    );
    expect(result.kind).toBe('mismatch');
  });

  it('an absent media id is `unavailable`, not a mismatch — the op may precede the media', async () => {
    const result = await fetchAndVerifyMedia(
      { transport: h.server, crypto: noblePort },
      'never-uploaded',
      'a'.repeat(64),
    );
    expect(result.kind).toBe('unavailable');
    if (result.kind === 'unavailable') expect(result.code).toBe('MEDIA_NOT_FOUND');
  });
});

describe('truncated / oversized chunks fail closed', () => {
  it('a locally truncated file is caught BEFORE the wire and named LOCAL_CORRUPT', async () => {
    const bytes = jpegBytes(2 * WIRE_CHUNK_SIZE);
    await givenCapture(h, 'tr-1', bytes);
    // The row claims the full size; the file on disk is short (a partial write, a purged cache,
    // a truncating filesystem). Reading chunk 1 returns fewer bytes than the protocol demands.
    h.files.write('/doc/media/tr-1.jpg', bytes.subarray(0, WIRE_CHUNK_SIZE + 10));

    const loop = loopFor(h);
    loop.requestDrain('manual');
    await loop.settle();

    const row = await readStatus(h.db, 'tr-1');
    expect(row.uploadStatus).toBe('failed');
    // Named for what it IS. Sending the short body would have earned a CHUNK_SIZE_INVALID, whose
    // "Bug; surface" copy tells the user nothing about their rotted file.
    expect(row.lastErrorCode).toBe('LOCAL_CORRUPT');
    expect(row.nextAttemptAt).toBeNull();
    // The short chunk never reached the server.
    expect(h.server.putLog.map((p) => p.index)).toEqual([0]);
  });

  it('the server rejects a wrong-sized chunk and nothing is stored (api/03 §3.2 exact-match)', async () => {
    const bytes = jpegBytes(WIRE_CHUNK_SIZE);
    await h.server.init('sz-1', {
      sizeBytes: bytes.byteLength,
      sha256: sha256Hex(bytes),
      mime: 'image/jpeg',
      type: 'image',
      metadata: { capturedAt: 1, location: null, userId: 'u-1', deviceId: 'd-1' },
    });

    // +1, -1 and empty — the api/03 §9 fuzz row, client-side.
    let rejected = 0;
    for (const body of [
      new Uint8Array(WIRE_CHUNK_SIZE + 1),
      new Uint8Array(WIRE_CHUNK_SIZE - 1),
      new Uint8Array(0),
    ]) {
      await expect(h.server.putChunk('sz-1', 0, body)).rejects.toMatchObject({
        code: 'CHUNK_SIZE_INVALID',
      });
      rejected += 1;
    }
    expect(rejected).toBe(3); // denominator
    // Nothing was stored — the fence, with the rejection above as its positive control.
    expect((await h.server.status('sz-1')).receivedChunks).toEqual([]);
  });

  it('an out-of-range chunk index is rejected and stores nothing', async () => {
    const bytes = jpegBytes(WIRE_CHUNK_SIZE);
    await h.server.init('ix-1', {
      sizeBytes: bytes.byteLength,
      sha256: sha256Hex(bytes),
      mime: 'image/jpeg',
      type: 'image',
      metadata: { capturedAt: 1, location: null, userId: 'u-1', deviceId: 'd-1' },
    });
    for (const index of [-1, 1, 2 ** 31, 1.5]) {
      await expect(h.server.putChunk('ix-1', index, bytes)).rejects.toMatchObject({
        code: 'CHUNK_INDEX_INVALID',
      });
    }
    expect((await h.server.status('ix-1')).receivedChunks).toEqual([]);
  });
});

describe('CHAOS-09 (client half) — interruption at every chunk boundary and mid-chunk', () => {
  // testing-guide's "media upload interruption at every chunk boundary". The fixture is
  // 4*chunkSize + 3 bytes, PRNG-filled, per task 18's acceptance. Built to be reusable by the
  // real-server harness run (task 26, fault points F1-F3).
  const SIZE = 4 * WIRE_CHUNK_SIZE + 3;
  const TOTAL_CHUNKS = 5; // ceil((4*262144+3)/262144)

  it('interrupting at EVERY chunk boundary still converges, resending no held chunk', async () => {
    let boundariesTested = 0;

    for (let boundary = 0; boundary < TOTAL_CHUNKS; boundary += 1) {
      const harness = await openMediaHarness();
      const bytes = jpegBytes(SIZE, 1_000 + boundary);
      await givenCapture(harness, 'chaos', bytes);
      const loop = loopFor(harness);

      // Drop the connection at this boundary.
      harness.server.faults.dropAtChunkIndex = boundary;
      loop.requestDrain('manual');
      await loop.settle();

      // It failed retryably and kept whatever the server had.
      const afterDrop = await readStatus(harness.db, 'chaos');
      expect(afterDrop.uploadStatus, `boundary ${boundary}`).toBe('failed');
      const heldAfterDrop = (await harness.server.status('chaos')).receivedChunks;
      expect(heldAfterDrop, `boundary ${boundary} kept 0..${boundary - 1}`).toEqual([
        ...Array(boundary).keys(),
      ]);

      // Resume via the REAL drain loop (not a hand-rolled resend).
      harness.clock.advance(5_000);
      harness.server.putLog.length = 0;
      loop.requestDrain('periodic');
      await loop.settle();

      expect((await readStatus(harness.db, 'chaos')).uploadStatus, `boundary ${boundary}`).toBe(
        'uploaded',
      );
      // NO chunk the server already held was re-sent (FR-1139).
      const resent = harness.server.putLog.map((p) => p.index);
      expect(resent, `boundary ${boundary} resent only the missing tail`).toEqual(
        [...Array(TOTAL_CHUNKS).keys()].slice(boundary),
      );
      // The final assembled hash equals the capture hash.
      expect(sha256Hex(await harness.server.download('chaos'))).toBe(sha256Hex(bytes));
      boundariesTested += 1;
    }

    // Denominator (T-14): EVERY boundary, not "some". A loop that silently ran zero iterations
    // is this repo's signature failure.
    expect(boundariesTested).toBe(TOTAL_CHUNKS);
  });

  it('a truncated body mid-chunk is rejected and re-sent cleanly', async () => {
    const bytes = jpegBytes(SIZE, 4_242);
    await givenCapture(h, 'chaos-mid', bytes);

    // Mid-chunk truncation: the server receives a short body for chunk 2 and rejects it per
    // §3.2's exact-match rule. Nothing is stored for that index.
    const server = h.server;
    const realPut = server.putChunk.bind(server);
    let truncatedOnce = false;
    server.putChunk = async (id, index, body) => {
      if (index === 2 && !truncatedOnce) {
        truncatedOnce = true;
        return realPut(id, index, body.subarray(0, body.byteLength - 17));
      }
      return realPut(id, index, body);
    };

    const loop = loopFor(h);
    loop.requestDrain('manual');
    await loop.settle();

    // The truncated PUT earned CHUNK_SIZE_INVALID — a non-retryable "Bug; surface" code.
    const row = await readStatus(h.db, 'chaos-mid');
    expect(row.lastErrorCode).toBe('CHUNK_SIZE_INVALID');
    expect(truncatedOnce).toBe(true);
    // Chunks 0-1 survived; chunk 2 was NOT stored (the fence), and 0-1 existing is its positive
    // control — the upload really was in progress when the truncation hit.
    expect((await h.server.status('chaos-mid')).receivedChunks).toEqual([0, 1]);

    // A manual retry now sends a well-formed chunk 2 and converges without resending 0-1.
    h.server.putLog.length = 0;
    loop.requestDrain('manual');
    await loop.settle();
    expect((await readStatus(h.db, 'chaos-mid')).uploadStatus).toBe('uploaded');
    expect(h.server.putLog.map((p) => p.index)).toEqual([2, 3, 4]);
    expect(sha256Hex(await h.server.download('chaos-mid'))).toBe(sha256Hex(bytes));
  });

  it('uploadStatus only ever walks pending -> uploading -> (failed -> uploading)* -> uploaded', async () => {
    const bytes = jpegBytes(SIZE, 5);
    await givenCapture(h, 'walk', bytes);
    const seen: string[] = [];
    const record = async (): Promise<void> => {
      seen.push((await readStatus(h.db, 'walk')).uploadStatus);
    };

    const loop = loopFor(h);
    await record(); // pending
    h.server.faults.dropAtChunkIndex = 2;
    loop.requestDrain('manual');
    await loop.settle();
    await record(); // failed
    h.clock.advance(5_000);
    loop.requestDrain('periodic');
    await loop.settle();
    await record(); // uploaded

    expect(seen).toEqual(['pending', 'failed', 'uploaded']);
    // Every observed value is a legal member of 03 §4's enum — no invented status strings.
    for (const s of seen) expect(['pending', 'uploading', 'uploaded', 'failed']).toContain(s);
  });
});
