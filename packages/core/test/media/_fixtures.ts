// Media engine test fixtures: a real client SQLite DB, a FakeClock, and a protocol-faithful
// in-memory media server.
//
// ============================ WHAT THIS FAKE PROVES, AND WHAT IT DOES NOT ====================
// D16 (2026-07-16) requires integration tests to run against REAL dependencies and requires every
// substitute to state its scope in the gate (T-14f rule 3: "when a gate's name says Postgres,
// write down WHICH Postgres and over WHICH client"). This fake is a sanctioned substitute under
// D16 clause 3, and here is the honest accounting.
//
// PROVES: that the CLIENT drain loop implements api/03-media §3's protocol correctly — that it
// resumes from the server's `receivedChunks` rather than its own bookkeeping, sends exactly the
// missing set, handles each §8 code as the "Client behavior" column dictates, and never re-sends a
// chunk the server already holds. Those are all facts about OUR code, and this fake exercises the
// real `MediaDrainLoop`, the real state machine, the real backoff, over a REAL SQLite engine
// (better-sqlite3 — the production client family; D16: "Client SQLite is already real").
//
// DOES NOT PROVE: that apps/server behaves this way. Nothing here is evidence about the server —
// the server's own conformance is task 19's integration suite, which drives the real `createApp`.
// If this fake and the real server disagree, THIS FILE IS WRONG and the tests below are green for
// the wrong reason. That risk is mitigated only by transcribing api/03 §3 faithfully (below, with
// section citations per branch) and is NOT eliminated. A cross-check that drives the real server
// through the real client is the chaos harness's job (task 26, fault points F1–F3), and 06 §10's
// checklist assigns it there.
//
// WHY A FAKE AT ALL, RATHER THAN THE REAL SERVER. Because the adversarial cases REQUIRE a server
// that lies: a resume offset that contradicts reality, a download whose bytes do not match their
// hash, a `receivedChunks` containing out-of-range indices. A correct server cannot be made to
// emit those, and they are exactly the inputs a hostile network can produce. A test that can only
// ask "does the client work against a correct server" cannot answer "can a lying server corrupt
// local state" — which is the security question on this surface (§2.5).
// =============================================================================================
import { CamelCasePlugin, Kysely } from 'kysely';

import { createClientDialect, runClientMigrations, type ClientDatabase } from '@bolusi/db-client';
import { noblePort } from '@bolusi/test-support';

import { bytesToHex } from '../../src/crypto/bytes.js';
import {
  MediaTransportError,
  type MediaChunkResponse,
  type MediaCompleteResponse,
  type MediaFilePort,
  type MediaInitRequest,
  type MediaInitResponse,
  type MediaStatusResponse,
  type MediaTransportPort,
  type MediaWireStatus,
} from '../../src/media/ports.js';
import { openMemoryDriver } from '../projection/better-sqlite3-driver.js';

/** api/03-media §4 — pinned, server-dictated. The client must never assume it; the fake dictates it. */
export const WIRE_CHUNK_SIZE = 262_144;

export class FakeClock {
  constructor(private current = 1_726_000_000_000) {}
  now(): number {
    return this.current;
  }
  set(at: number): void {
    this.current = at;
  }
  advance(ms: number): void {
    this.current += ms;
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(noblePort.sha256(bytes));
}

/**
 * Flip every bit of one byte, in place, and return the array. A test helper because
 * `bytes[i] ^= 0xff` reads `bytes[i]` as `number | undefined` under `noUncheckedIndexedAccess`
 * (the per-package `tsc --noEmit` lane — NOT the `tsc -b` build lane, which excludes tests; the
 * two lanes disagreeing is T-14c's shape, so both must pass). Named so the corruption is obvious.
 */
export function flipByte(bytes: Uint8Array, index: number): Uint8Array {
  bytes[index] = (bytes[index] ?? 0) ^ 0xff;
  return bytes;
}

/** A valid JPEG magic-byte prefix (api/03 §3.4 step 4: `FF D8 FF`). */
export function jpegBytes(length: number, seed = 7): Uint8Array {
  const out = new Uint8Array(length);
  out[0] = 0xff;
  out[1] = 0xd8;
  out[2] = 0xff;
  // Deterministic filler — T-6: no real RNG. A seeded PRNG makes a 4-chunk fixture reproducible
  // and makes "the assembled hash equals the capture hash" a real claim rather than one about zeros.
  let state = seed >>> 0;
  for (let i = 3; i < length; i += 1) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    out[i] = state & 0xff;
  }
  return out;
}

interface FakeMedia {
  init: MediaInitRequest;
  chunks: Map<number, Uint8Array>;
  status: MediaWireStatus;
  totalChunks: number;
  /** The assembled bytes, once `complete` succeeded. Write-once (api/03 §5: blob keys written once). */
  blob: Uint8Array | null;
}

/** Fault injection — the reason this is a fake and not the real server. */
export interface FakeServerFaults {
  /** Throw this code on the next call to the named method, then clear. */
  failNextWith?: {
    method: 'init' | 'putChunk' | 'status' | 'complete' | 'download';
    code: string;
    status: number;
  };
  /** Override what `status`/`init` REPORT as received, without changing what the server holds. */
  lieAboutReceivedChunks?: readonly number[];
  /** Corrupt the bytes `download` returns, leaving the stored blob intact. */
  tamperDownload?: (bytes: Uint8Array) => Uint8Array;
  /** Drop the connection at this chunk index (a network failure, not an HTTP error). */
  dropAtChunkIndex?: number;
  /**
   * Store this chunk index's bytes CORRUPTED, so the server's own assembly genuinely fails its
   * hash check at `complete` — producing a REAL `HASH_MISMATCH` and, critically, the REAL chunk
   * purge of api/03 §3.4 step 3.
   *
   * Exists because `failNextWith: {method:'complete', code:'HASH_MISMATCH'}` is a WEAKER ORACLE
   * (T-13): it throws before the handler runs, so the chunks are never purged — and a test using
   * it to assert "the retry restarts from chunk 0" passes for the wrong reason (the retry sends
   * nothing, because the server still holds every chunk) or fails for the wrong reason. That
   * mistake was made here and caught by this test going red. Injecting the CAUSE and letting the
   * server produce the effect keeps the fake's own §3.4 logic in the loop.
   */
  corruptStoredChunk?: number;
}

/**
 * api/03-media §3, transcribed. Each branch cites the clause it implements so a reviewer can
 * diff this against the spec rather than against their memory of it.
 */
export class FakeMediaServer implements MediaTransportPort {
  readonly media = new Map<string, FakeMedia>();
  faults: FakeServerFaults = {};
  /** Every chunk index ever accepted, per media id — the oracle for "no chunk was re-sent". */
  readonly putLog: { mediaId: string; index: number }[] = [];

  private checkFault(method: 'init' | 'putChunk' | 'status' | 'complete' | 'download'): void {
    const f = this.faults.failNextWith;
    if (f !== undefined && f.method === method) {
      delete this.faults.failNextWith;
      throw new MediaTransportError(`injected ${f.code}`, { code: f.code, status: f.status });
    }
  }

  private reported(m: FakeMedia): readonly number[] {
    if (this.faults.lieAboutReceivedChunks !== undefined) return this.faults.lieAboutReceivedChunks;
    return [...m.chunks.keys()].sort((a, b) => a - b);
  }

  async init(mediaId: string, request: MediaInitRequest): Promise<MediaInitResponse> {
    this.checkFault('init');
    const existing = this.media.get(mediaId);
    const totalChunks = Math.ceil(request.sizeBytes / WIRE_CHUNK_SIZE);

    if (existing !== undefined) {
      // §3.1: "Re-init of a `complete` id ⇒ 409 MEDIA_IMMUTABLE, always." Checked BEFORE the
      // field comparison — matching apps/server/src/routes/media.ts:215, where the `complete`
      // guard returns before the `identical` branch. So a complete id yields MEDIA_IMMUTABLE even
      // when the body is byte-identical, which is exactly why the client cannot infer a hash match
      // from the code alone (see MediaTransportPort.matchesServerHash).
      if (existing.status === 'complete') {
        throw new MediaTransportError('media is complete', {
          code: 'MEDIA_IMMUTABLE',
          status: 409,
        });
      }
      // §3.1: "Re-init with any differing field for an existing `receiving` id ⇒ 409 INIT_MISMATCH."
      const identical =
        existing.init.sizeBytes === request.sizeBytes &&
        existing.init.sha256 === request.sha256 &&
        existing.init.mime === request.mime &&
        existing.init.type === request.type &&
        JSON.stringify(existing.init.metadata) === JSON.stringify(request.metadata);
      if (!identical) {
        throw new MediaTransportError('init differs', { code: 'INIT_MISMATCH', status: 409 });
      }
      // §3.1: "re-init with a byte-identical body returns 200 with current receivedChunks (this is
      // also the crash-resume path)".
      return {
        chunkSize: WIRE_CHUNK_SIZE,
        totalChunks: existing.totalChunks,
        receivedChunks: this.reported(existing),
        status: existing.status,
      };
    }

    // §3.1 validation: mime allowlist, size cap.
    if (request.mime !== 'image/jpeg' && request.mime !== 'image/png') {
      throw new MediaTransportError('bad mime', { code: 'MIME_UNSUPPORTED', status: 422 });
    }
    if (request.sizeBytes < 1 || request.sizeBytes > 10 * 1024 * 1024) {
      throw new MediaTransportError('too large', { code: 'MEDIA_TOO_LARGE', status: 413 });
    }

    this.media.set(mediaId, {
      init: request,
      chunks: new Map(),
      status: 'receiving',
      totalChunks,
      blob: null,
    });
    return { chunkSize: WIRE_CHUNK_SIZE, totalChunks, receivedChunks: [], status: 'receiving' };
  }

  async putChunk(mediaId: string, index: number, bytes: Uint8Array): Promise<MediaChunkResponse> {
    this.checkFault('putChunk');
    if (this.faults.dropAtChunkIndex === index) {
      delete this.faults.dropAtChunkIndex;
      // A NETWORK failure: no response, hence no code (api/00 §7 has no envelope for a dropped
      // socket). The client must treat this as retryable, not as a protocol error.
      throw new MediaTransportError('connection dropped', { code: null, status: null });
    }
    const m = this.media.get(mediaId);
    // §3.2: "Unknown id (no init) ⇒ 404 MEDIA_NOT_FOUND."
    if (m === undefined) {
      throw new MediaTransportError('no such media', { code: 'MEDIA_NOT_FOUND', status: 404 });
    }
    // §3.2: "Chunks against a `complete` media ⇒ 409 MEDIA_IMMUTABLE."
    if (m.status === 'complete') {
      throw new MediaTransportError('media is complete', { code: 'MEDIA_IMMUTABLE', status: 409 });
    }
    // §3.2: "index outside [0, totalChunks) ⇒ 422 CHUNK_INDEX_INVALID."
    if (!Number.isInteger(index) || index < 0 || index >= m.totalChunks) {
      throw new MediaTransportError('bad index', { code: 'CHUNK_INDEX_INVALID', status: 422 });
    }
    // §3.2: "Size check is exact: every chunk must be exactly chunkSize bytes except the last."
    const expected =
      index === m.totalChunks - 1
        ? m.init.sizeBytes - (m.totalChunks - 1) * WIRE_CHUNK_SIZE
        : WIRE_CHUNK_SIZE;
    if (bytes.byteLength !== expected) {
      throw new MediaTransportError('bad chunk size', { code: 'CHUNK_SIZE_INVALID', status: 422 });
    }
    // §3.2: "Idempotent: re-PUT of an already-received index overwrites the stored bytes."
    const stored = new Uint8Array(bytes);
    if (this.faults.corruptStoredChunk === index) {
      delete this.faults.corruptStoredChunk;
      flipByte(stored, 0); // the server now holds bytes that will not hash to the declared sha256
    }
    m.chunks.set(index, stored);
    this.putLog.push({ mediaId, index });
    return { receivedChunks: this.reported(m) };
  }

  async status(mediaId: string): Promise<MediaStatusResponse> {
    this.checkFault('status');
    const m = this.media.get(mediaId);
    if (m === undefined) {
      throw new MediaTransportError('no such media', { code: 'MEDIA_NOT_FOUND', status: 404 });
    }
    return {
      status: m.status,
      sizeBytes: m.init.sizeBytes,
      chunkSize: WIRE_CHUNK_SIZE,
      totalChunks: m.totalChunks,
      receivedChunks: this.reported(m),
    };
  }

  async complete(mediaId: string): Promise<MediaCompleteResponse> {
    this.checkFault('complete');
    const m = this.media.get(mediaId);
    if (m === undefined) {
      throw new MediaTransportError('no such media', { code: 'MEDIA_NOT_FOUND', status: 404 });
    }
    // §3.4: "Idempotent: complete on an already-complete id ⇒ 200."
    if (m.status === 'complete') return { status: 'complete' };

    // §3.4 step 1: all chunks present? Else 422 CHUNKS_MISSING with missingChunks listed.
    const missing: number[] = [];
    for (let i = 0; i < m.totalChunks; i += 1) if (!m.chunks.has(i)) missing.push(i);
    if (missing.length > 0) {
      throw new MediaTransportError('chunks missing', {
        code: 'CHUNKS_MISSING',
        status: 422,
        missingChunks: missing,
      });
    }

    // §3.4 step 2: assemble in index order, streaming SHA-256.
    const assembled = concat(
      [...Array(m.totalChunks).keys()].map((i) => m.chunks.get(i) as Uint8Array),
    );

    // §3.4 step 3: hash ≠ init sha256 ⇒ 422 HASH_MISMATCH, and the server DELETES ALL STORED
    // CHUNKS. The purge is the part clients must survive: the next attempt starts from chunk 0.
    if (sha256Hex(assembled) !== m.init.sha256) {
      m.chunks.clear();
      throw new MediaTransportError('hash mismatch', { code: 'HASH_MISMATCH', status: 422 });
    }
    // §3.4 step 4: magic-byte mime check; mismatch ⇒ 422 MIME_MISMATCH, chunks deleted, blob
    // untouched.
    if (!magicBytesMatch(assembled, m.init.mime)) {
      m.chunks.clear();
      throw new MediaTransportError('mime mismatch', { code: 'MIME_MISMATCH', status: 422 });
    }
    // §3.4 step 5: write blob, mark complete, delete chunk rows.
    m.blob = assembled;
    m.status = 'complete';
    m.chunks.clear();
    return { status: 'complete' };
  }

  async download(mediaId: string): Promise<Uint8Array> {
    this.checkFault('download');
    const m = this.media.get(mediaId);
    // §3.5: "Only `complete` media is downloadable; a `receiving` id ⇒ 404 MEDIA_NOT_FOUND
    // (indistinguishable from absent)."
    if (m === undefined || m.status !== 'complete' || m.blob === null) {
      throw new MediaTransportError('no such media', { code: 'MEDIA_NOT_FOUND', status: 404 });
    }
    const bytes = m.blob;
    return this.faults.tamperDownload === undefined ? bytes : this.faults.tamperDownload(bytes);
  }

  /** §3.5's `ETag: "<sha256>"` + `If-None-Match ⇒ 304`, as the question the client asks. */
  async matchesServerHash(mediaId: string, sha256: string): Promise<boolean> {
    const m = this.media.get(mediaId);
    if (m === undefined || m.status !== 'complete' || m.blob === null) {
      throw new MediaTransportError('no such media', { code: 'MEDIA_NOT_FOUND', status: 404 });
    }
    return sha256Hex(m.blob) === sha256;
  }
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/** api/03 §3.4 step 4's v0 allowlist, verbatim: jpeg `FF D8 FF`, png `89 50 4E 47 0D 0A 1A 0A`. */
function magicBytesMatch(bytes: Uint8Array, mime: string): boolean {
  if (mime === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === 'image/png') {
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return sig.every((b, i) => bytes[i] === b);
  }
  return false;
}

/**
 * An in-memory `MediaFilePort`. A FAKE AT THE I/O BOUNDARY ONLY (T-7): it stores bytes and serves
 * random-access reads. The real adapter's `FileHandle` behaviour is apps/mobile's to prove — this
 * cannot and does not speak to it.
 */
export class FakeFiles implements MediaFilePort {
  readonly files = new Map<string, Uint8Array>();

  write(path: string, bytes: Uint8Array): void {
    this.files.set(path, bytes);
  }

  async readChunk(path: string, offset: number, length: number): Promise<Uint8Array> {
    const f = this.files.get(path);
    if (f === undefined) throw new Error(`ENOENT ${path}`);
    return f.subarray(offset, Math.min(offset + length, f.byteLength));
  }

  async hashFile(path: string): Promise<string> {
    const f = this.files.get(path);
    if (f === undefined) throw new Error(`ENOENT ${path}`);
    return sha256Hex(f);
  }

  async sizeOf(path: string): Promise<number> {
    const f = this.files.get(path);
    if (f === undefined) throw new Error(`ENOENT ${path}`);
    return f.byteLength;
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async deleteFile(path: string): Promise<void> {
    this.files.delete(path);
  }
}

export class RecordingSurface {
  readonly events: {
    mediaId: string;
    code: string;
    labelKey: string;
    persistentlyFailing: boolean;
    autoRetryExempt: boolean;
  }[] = [];
  emit(event: {
    mediaId: string;
    code: string;
    labelKey: string;
    persistentlyFailing: boolean;
    autoRetryExempt: boolean;
  }): void {
    this.events.push(event);
  }
}

export interface MediaHarness {
  readonly db: Kysely<ClientDatabase>;
  readonly server: FakeMediaServer;
  readonly files: FakeFiles;
  readonly clock: FakeClock;
  readonly surface: RecordingSurface;
}

/** A REAL SQLite engine (better-sqlite3) running the REAL client migrations — not a fake DB. */
export async function openMediaHarness(): Promise<MediaHarness> {
  const driver = openMemoryDriver();
  await runClientMigrations(driver, { now: () => 1 });
  const db = new Kysely<ClientDatabase>({
    dialect: createClientDialect(driver),
    plugins: [new CamelCasePlugin({ underscoreBetweenUppercaseLetters: true })],
  });
  return {
    db,
    server: new FakeMediaServer(),
    files: new FakeFiles(),
    clock: new FakeClock(),
    surface: new RecordingSurface(),
  };
}

export interface SeedMediaOptions {
  readonly id: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly capturedAt: number;
  readonly attachedToOperationId?: string | null;
  readonly uploadStatus?: string;
  readonly localPath?: string | null;
  readonly uploadAttempts?: number;
  readonly nextAttemptAt?: number | null;
  readonly lastErrorCode?: string | null;
  readonly uploadedAt?: number | null;
  readonly mime?: string;
  readonly type?: string;
}

export async function seedMediaItem(
  db: Kysely<ClientDatabase>,
  o: SeedMediaOptions,
): Promise<void> {
  await db
    .insertInto('mediaItems')
    .values({
      id: o.id,
      tenantId: 't-1',
      storeId: null,
      capturedByUserId: 'u-1',
      deviceId: 'd-1',
      type: o.type ?? 'image',
      mimeType: o.mime ?? 'image/jpeg',
      byteSize: o.sizeBytes,
      sha256: o.sha256,
      capturedAt: o.capturedAt,
      location: null,
      localPath: o.localPath === undefined ? `/doc/media/${o.id}.jpg` : o.localPath,
      attachedToOperationId:
        o.attachedToOperationId === undefined ? 'op-1' : o.attachedToOperationId,
      uploadStatus: o.uploadStatus ?? 'pending',
      chunkSize: null,
      chunksTotal: null,
      uploadAttempts: o.uploadAttempts ?? 0,
      nextAttemptAt: o.nextAttemptAt ?? null,
      lastErrorCode: o.lastErrorCode ?? null,
      lastErrorMessage: null,
      uploadedAt: o.uploadedAt ?? null,
    } as never)
    .execute();
}

export async function readStatus(
  db: Kysely<ClientDatabase>,
  id: string,
): Promise<{
  uploadStatus: string;
  uploadAttempts: number;
  nextAttemptAt: number | null;
  lastErrorCode: string | null;
  uploadedAt: number | null;
  localPath: string | null;
}> {
  const row = await db
    .selectFrom('mediaItems')
    .select([
      'uploadStatus',
      'uploadAttempts',
      'nextAttemptAt',
      'lastErrorCode',
      'uploadedAt',
      'localPath',
    ])
    .where('id', '=', id as never)
    .executeTakeFirstOrThrow();
  return row as never;
}
