// CHAOS-09 — media upload interruption at every chunk boundary (testing-guide §3.6 / api/03-media).
//
// A MediaItem of `4·chunkSize + 3` bytes (an uneven final chunk of 3 bytes) is captured with a
// client-side SHA-256, then drained through the REAL `@bolusi/core` `MediaDrainLoop` (never
// re-implemented, T-7) over `HarnessMediaTransport` → `FaultFetch` → the REAL `@bolusi/server` media
// router on PGlite. At every chunk boundary k and each of F1/F2/F3 the transfer is interrupted, then
// the foreground drain loop resumes; plus one mid-chunk WIRE truncation (a partial chunk body).
//
// PASS (§3.6, all asserted): the upload completes; the server-assembled bytes' SHA-256 == the
// client's recorded hash (proved by downloading and re-hashing); the server never stores a chunk
// twice (asserted on the SERVER inventory — `media_chunks` — not a client counter); the truncated
// chunk is rejected (`CHUNK_SIZE_INVALID`) and re-sent cleanly; `uploadStatus` walks only legal
// `03-state-machines §4` transitions ending at the terminal `uploaded`; and the op referencing the
// media synced independently of media completion (FR-1138 / api/01 §8).
//
// THE FAULT MODEL, HONESTLY:
//   F1 (never reached) / F2 (server processed, response lost) are TRANSPORT faults at the FaultFetch
//     boundary — `putChunk` rejects with `MediaTransportError{code:null}`, the drain marks the item
//     `failed`, and connectivity-regained resumes it (06 §5.2(a)). F2 is the sharp one: the server
//     STORED the chunk, so the server-authoritative resume (06 §5.1 step 2 — `receivedChunks` is
//     ground truth) must NOT re-send it, which is exactly how "never stored twice" holds.
//   F3 (response received, crash before persisting the outcome, §3.5) is a CLIENT crash the scenario
//     models: chunk progress is DISPLAY-ONLY and never persisted (06 §5.1), so the only persisted
//     state at a chunk boundary is `uploadStatus = 'uploading'`. The crash aborts the drain cycle;
//     the reopen runs `recoverInterruptedUploads` (walks `uploading → pending`, the machine's
//     `recover` arm) and a fresh loop resumes. The server already holds the chunk (F3 = response
//     received), so — like F2 — it is not re-sent.
//
// POSITIVE CONTROL (T-17 / §2.11): a final hash match is ALSO what a zero-fault happy path produces,
// so every fault case additionally asserts the fault ACTUALLY FIRED and the mechanism ran — the
// server's inventory was genuinely PARTIAL at the interruption, a `media_failed`/crash was observed,
// and a re-PUT did (F1, truncation) or deliberately did NOT (F2, F3 — server-authoritative dedup)
// occur. Without those, "converged/uploaded" is equally true of a run whose fault never fired.
//
// FALSIFICATION (§2.11, reported in the task write-up): (1) breaking the server's chunk overwrite
// (`onConflict doNothing`) reddens the dedup test's assembled-hash assertion; (2) neutering the
// client resume (`missingChunks → []`) reddens every fault case's "uploaded" assertion.
import {
  MEDIA_UPLOAD_STATUS_MACHINE,
  MediaDrainLoop,
  MediaTransportError,
  findMediaItem,
  recoverInterruptedUploads,
  type ClockPort,
  type MediaChunkResponse,
  type MediaCompleteResponse,
  type MediaFilePort,
  type MediaInitRequest,
  type MediaInitResponse,
  type MediaStatusResponse,
  type MediaSurfacePort,
  type MediaSurfacing,
  type MediaTransportPort,
  type MediaUploadStatus,
} from '@bolusi/core';
import type { ClientDatabase } from '@bolusi/db-client';
import { FakeClock, makeIdSource, mulberry32, noblePort } from '@bolusi/test-support';
import { sql } from 'kysely';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';

import { VirtualDevice, type DeviceIdentity } from '../src/device.js';
import { FaultFetch, type FaultPoint } from '../src/fault-fetch.js';
import { HarnessServer } from '../src/server.js';
import { HarnessMediaTransport } from '../src/media-transport.js';
import { mintIdentities } from '../src/identities.js';
import { HttpTransport } from '../src/transport.js';
import { resolveSeeds, withSeed } from '../src/index.js';

const CLOCK_BASE = 1_726_100_000_000;
/** JPEG magic (api/03-media §3.4): the assembled file's leading bytes must match the declared mime,
 *  or `complete` returns `MIME_MISMATCH`. A real capture is a real JPEG; the PRNG fill starts here. */
const JPEG_MAGIC = [0xff, 0xd8, 0xff] as const;

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

/** The server's authoritative chunk inventory (api/03 §3.3) — read DIRECTLY (owner handle, T-17's
 *  "assert the server's inventory, not a client counter"). Ascending, one row per stored index. */
async function serverReceived(server: HarnessServer, mediaId: string): Promise<number[]> {
  const rows = await sql<{ chunkIndex: number }>`
    SELECT chunk_index AS "chunkIndex" FROM media_chunks WHERE media_id = ${mediaId}
    ORDER BY chunk_index ASC
  `.execute(server.db);
  return rows.rows.map((r) => Number(r.chunkIndex));
}

/** Row count vs distinct-index count for a media's chunks — the DIRECT "never stored twice" probe. */
async function serverChunkStats(
  server: HarnessServer,
  mediaId: string,
): Promise<{ total: number; distinct: number }> {
  const rows = await sql<{ total: string; distinct: string }>`
    SELECT COUNT(*) AS total, COUNT(DISTINCT chunk_index) AS distinct
    FROM media_chunks WHERE media_id = ${mediaId}
  `.execute(server.db);
  return { total: Number(rows.rows[0]?.total ?? 0), distinct: Number(rows.rows[0]?.distinct ?? 0) };
}

/** The server's media row status (`receiving`|`complete`), or null when no row exists. */
async function serverMediaStatus(server: HarnessServer, mediaId: string): Promise<string | null> {
  const rows = await sql<{ status: string }>`
    SELECT status FROM media WHERE id = ${mediaId}
  `.execute(server.db);
  return rows.rows[0]?.status ?? null;
}

/** A capturing `MediaSurfacePort` (T-4): records surfacings so a case asserts the CODE, never copy. */
class CaptureMediaSurface implements MediaSurfacePort {
  readonly events: MediaSurfacing[] = [];
  emit(event: MediaSurfacing): void {
    this.events.push(event);
  }
  codes(): string[] {
    return this.events.map((e) => e.code);
  }
}

/**
 * An in-memory `MediaFilePort` over a single captured buffer (06 §2.2 step 6 / §5.5). `readChunk` is
 * random-access (never loads the whole file).
 */
class InMemoryMediaFile implements MediaFilePort {
  constructor(private readonly bytes: Uint8Array) {}
  async readChunk(_path: string, offset: number, length: number): Promise<Uint8Array> {
    return Promise.resolve(this.bytes.subarray(offset, offset + length));
  }
  async hashFile(): Promise<string> {
    return Promise.resolve(hex(noblePort.sha256(this.bytes)));
  }
  async sizeOf(): Promise<number> {
    return Promise.resolve(this.bytes.byteLength);
  }
  async exists(): Promise<boolean> {
    return Promise.resolve(true);
  }
  async deleteFile(): Promise<void> {
    return Promise.resolve();
  }
}

/** A client "crash" (F3): NOT a `MediaTransportError`, so the drain's `classify` rethrows it and the
 *  whole cycle unwinds — the process dying mid-loop with the chunk's outcome unpersisted. */
class ClientCrashError extends Error {
  override readonly name = 'ClientCrashError';
}

/**
 * A scenario-local decorator over the pure `HarnessMediaTransport` that injects the two faults the
 * FaultFetch boundary cannot express, and records the PUT log (the re-send positive control):
 *  - `armTruncation(index, toBytes)`: a ONE-SHOT wire truncation — the next PUT of `index` sends a
 *    partial body (`toBytes < chunkSize`), which the server rejects `CHUNK_SIZE_INVALID`. The resend
 *    is full (the file read is always full; only the wire dropped bytes).
 *  - `armCrashOnF3()`: after a PUT whose FaultFetch request fired F3 (server processed it, response
 *    received), throw `ClientCrashError` to model the client crashing before it acts on the outcome.
 * F1/F2 need no decorator — they throw at the FaultFetch boundary through the pure transport.
 */
class FaultyMediaTransport implements MediaTransportPort {
  readonly putLog: number[] = [];
  private truncate: { index: number; toBytes: number } | null = null;
  private crashOnF3 = false;

  constructor(
    private readonly inner: MediaTransportPort,
    private readonly faultFetch: FaultFetch,
    /**
     * Observe the media row's `uploadStatus` before every wire call — the drain calls `status()`
     * right AFTER `markUploading`, so this captures the transient `uploading` on EVERY pass, even
     * one that reads no chunks (an F3 resume where the server already holds them all). That gap is
     * exactly what an earlier readChunk-only hook missed, leaving an illegal `pending → uploaded`.
     */
    private readonly observe: () => Promise<void>,
  ) {}

  armTruncation(index: number, toBytes: number): void {
    this.truncate = { index, toBytes };
  }
  armCrashOnF3(): void {
    this.crashOnF3 = true;
  }
  disarmCrash(): void {
    this.crashOnF3 = false;
  }

  async init(mediaId: string, request: MediaInitRequest): Promise<MediaInitResponse> {
    await this.observe();
    return this.inner.init(mediaId, request);
  }
  async status(mediaId: string): Promise<MediaStatusResponse> {
    await this.observe();
    return this.inner.status(mediaId);
  }
  async complete(mediaId: string): Promise<MediaCompleteResponse> {
    await this.observe();
    return this.inner.complete(mediaId);
  }
  download(mediaId: string): Promise<Uint8Array> {
    return this.inner.download(mediaId);
  }
  matchesServerHash(mediaId: string, sha256: string): Promise<boolean> {
    return this.inner.matchesServerHash(mediaId, sha256);
  }

  async putChunk(mediaId: string, index: number, bytes: Uint8Array): Promise<MediaChunkResponse> {
    await this.observe();
    this.putLog.push(index);
    if (this.truncate !== null && this.truncate.index === index) {
      const partial = bytes.slice(0, this.truncate.toBytes);
      this.truncate = null; // one-shot: the resend is clean/full
      return this.inner.putChunk(mediaId, index, partial);
    }
    const crashesBefore = this.faultFetch.firedClientCrashes.length;
    const response = await this.inner.putChunk(mediaId, index, bytes);
    if (this.crashOnF3) {
      const fresh = this.faultFetch.firedClientCrashes.slice(crashesBefore);
      if (fresh.some((c) => c.point === 'F3'))
        throw new ClientCrashError('F3 crash after chunk PUT');
    }
    return response;
  }
}

/** Records the ORDERED, consecutive-deduplicated `uploadStatus` walk of one media row. */
class StatusWalk {
  readonly steps: MediaUploadStatus[] = [];
  constructor(
    private readonly db: VirtualDevice['db'],
    private readonly mediaId: string,
  ) {}
  async observe(): Promise<void> {
    const item = await findMediaItem(this.db, this.mediaId);
    if (item === null) return;
    if (this.steps[this.steps.length - 1] !== item.uploadStatus) this.steps.push(item.uploadStatus);
  }
}

/** Is `from → to` a legal transition of the media upload-status machine (03 §4)? */
function isLegalTransition(from: MediaUploadStatus, to: MediaUploadStatus): boolean {
  const outs = MEDIA_UPLOAD_STATUS_MACHINE.transitions[from];
  return outs !== undefined && Object.values(outs).includes(to);
}

/** Assert the observed walk stays inside the machine, starts `pending`, ends at terminal `uploaded`,
 *  and never leaves `uploaded` — the §3.6 "walks only … `uploaded` terminal (03-state-machines)". */
function assertLegalWalk(steps: readonly MediaUploadStatus[]): void {
  expect(steps.length).toBeGreaterThan(1);
  expect(steps[0]).toBe('pending');
  expect(steps[steps.length - 1]).toBe('uploaded');
  for (let i = 1; i < steps.length; i += 1) {
    expect(steps[i - 1]).not.toBe('uploaded'); // terminal — nothing follows it
    expect(isLegalTransition(steps[i - 1]!, steps[i]!)).toBe(true);
  }
}

interface MediaWorld {
  readonly server: HarnessServer;
  readonly device: VirtualDevice;
  readonly identity: DeviceIdentity;
  readonly auth: string;
  readonly mediaId: string;
  /** The op-id linking the media to a note op — proves capture predates upload (attach binding). */
  readonly attachedOpId: string;
  readonly content: Uint8Array;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly noteId: string;
  close(): Promise<void>;
}

/** JPEG-magic-prefixed, PRNG-filled content of `4·chunkSize + 3` bytes + its client-capture SHA-256. */
function captureContent(
  seed: number,
  chunkSize: number,
): { content: Uint8Array; sizeBytes: number } {
  const sizeBytes = 4 * chunkSize + 3;
  const prng = mulberry32(seed ^ 0x09_09);
  const content = new Uint8Array(sizeBytes);
  for (let i = 0; i < sizeBytes; i += 1) content[i] = Math.floor(prng() * 256);
  for (let i = 0; i < JPEG_MAGIC.length; i += 1) content[i] = JPEG_MAGIC[i]!;
  return { content, sizeBytes };
}

/**
 * Build the CHAOS-09 world with an ISOLATED blob store (a per-test tmp dir — the server's default is
 * a SHARED `os.tmpdir()/bolusi-media-v0`, a T-14d/T-18 provenance hazard on this shared /tmp). Seeds a
 * device, captures the media, authors a real note op referencing its `mediaId` (the attach binding),
 * and seeds the `media_items` row (`pending`). Media is NOT inited on the server yet.
 */
async function buildWorld(seed: number, chunkSize: number): Promise<MediaWorld> {
  const storageDir = mkdtempSync(join(tmpdir(), 'chaos09-media-'));
  const prevStorageDir = process.env.MEDIA_STORAGE_DIR;
  process.env.MEDIA_STORAGE_DIR = storageDir;

  const restoreEnv = (): void => {
    if (prevStorageDir === undefined) delete process.env.MEDIA_STORAGE_DIR;
    else process.env.MEDIA_STORAGE_DIR = prevStorageDir;
  };

  let server: HarnessServer;
  try {
    server = await HarnessServer.boot();
  } catch (error) {
    restoreEnv();
    rmSync(storageDir, { recursive: true, force: true });
    throw error;
  }

  const identity = mintIdentities(seed, 1).devices[0]!;
  const seeded = await server.seedDevice(identity);
  const clock = new FakeClock(CLOCK_BASE);
  const device = await VirtualDevice.open({ identity, clock, prng: mulberry32(seed) });

  const { content, sizeBytes } = captureContent(seed, chunkSize);
  const sha256 = hex(noblePort.sha256(content));
  const mediaId = makeIdSource(clock, mulberry32(seed ^ 0x0d_0d))();

  // A real note op referencing the media (FR-1138: the op carries the mediaId and syncs
  // independently of the file). The op id becomes the attach binding.
  const noteId = await device.createNote({ title: `n-${seed}`, body: `b-${seed}`, mediaId });
  const opRows = await sql<{ id: string }>`
    SELECT id FROM operations WHERE entity_id = ${noteId} AND type = 'notes.note_created'
    ORDER BY seq DESC LIMIT 1
  `.execute(device.db);
  const attachedOpId = opRows.rows[0]?.id ?? noteId;

  await sql`
    INSERT INTO media_items (
      id, tenant_id, store_id, captured_by_user_id, device_id, type, mime_type,
      byte_size, sha256, captured_at, location, local_path, attached_to_operation_id,
      upload_status, upload_attempts
    ) VALUES (
      ${mediaId}, ${identity.tenantId}, ${identity.storeId}, ${identity.userId}, ${identity.deviceId},
      ${'image'}, ${'image/jpeg'}, ${sizeBytes}, ${sha256}, ${clock.now()}, ${null},
      ${`doc://media/${mediaId}.jpg`}, ${attachedOpId}, ${'pending'}, ${0}
    )
  `.execute(device.db);

  return {
    server,
    device,
    identity,
    auth: seeded.auth,
    mediaId,
    attachedOpId,
    content,
    sizeBytes,
    sha256,
    noteId,
    close: async () => {
      await device.close();
      await server.close();
      restoreEnv();
      rmSync(storageDir, { recursive: true, force: true });
    },
  };
}

/** Wire the REAL drain loop + a fault-injecting transport + a status-walk recorder for one world. */
function buildDrain(
  world: MediaWorld,
  faultFetch: FaultFetch,
): {
  loop: MediaDrainLoop<ClientDatabase>;
  transport: FaultyMediaTransport;
  surface: CaptureMediaSurface;
  walk: StatusWalk;
} {
  const clock: ClockPort = { now: () => world.device.clock.now() };
  const walk = new StatusWalk(world.device.db, world.mediaId);
  const pure = new HarnessMediaTransport(faultFetch.fetch, world.auth);
  const transport = new FaultyMediaTransport(pure, faultFetch, () => walk.observe());
  const files = new InMemoryMediaFile(world.content);
  const surface = new CaptureMediaSurface();
  const loop = new MediaDrainLoop({ db: world.device.db, transport, files, clock, surface });
  return { loop, transport, surface, walk };
}

/** After completion: the upload finished, the assembled bytes hash-match, no chunk was double-stored. */
async function assertUploadedAndVerified(world: MediaWorld): Promise<void> {
  const item = await findMediaItem(world.device.db, world.mediaId);
  expect(item?.uploadStatus).toBe('uploaded');
  expect(await serverMediaStatus(world.server, world.mediaId)).toBe('complete');
  // Chunks are purged at complete (api/03 §3.4 step 5) — the inventory is empty afterwards.
  expect((await serverChunkStats(world.server, world.mediaId)).total).toBe(0);
  // server-assembled bytes' SHA-256 == the client's recorded SHA-256 (download + re-hash).
  const downloader = new HarnessMediaTransport(world.server.fetch, world.auth);
  const downloaded = await downloader.download(world.mediaId);
  expect(downloaded.byteLength).toBe(world.sizeBytes);
  expect(hex(noblePort.sha256(downloaded))).toBe(world.sha256);
}

/** The server-dictated `chunkSize` (api/03 §4) — DERIVED from a real `init`, never hardcoded. */
let CHUNK_SIZE = 0;

async function probeChunkSize(): Promise<number> {
  const storageDir = mkdtempSync(join(tmpdir(), 'chaos09-probe-'));
  const prev = process.env.MEDIA_STORAGE_DIR;
  process.env.MEDIA_STORAGE_DIR = storageDir;
  const server = await HarnessServer.boot();
  try {
    const identity = mintIdentities(9_990_001, 1).devices[0]!;
    const seeded = await server.seedDevice(identity);
    const clock = new FakeClock(CLOCK_BASE);
    const mediaId = makeIdSource(clock, mulberry32(1))();
    const transport = new HarnessMediaTransport(server.fetch, seeded.auth);
    const init = await transport.init(mediaId, {
      sizeBytes: 1,
      sha256: '0'.repeat(64),
      mime: 'image/jpeg',
      type: 'image',
      metadata: {
        capturedAt: clock.now(),
        location: null,
        userId: identity.userId,
        deviceId: identity.deviceId,
      },
    });
    return init.chunkSize;
  } finally {
    await server.close();
    if (prev === undefined) delete process.env.MEDIA_STORAGE_DIR;
    else process.env.MEDIA_STORAGE_DIR = prev;
    rmSync(storageDir, { recursive: true, force: true });
  }
}

/** The request ordinal (0-based, within one FaultFetch) of the PUT for chunk `k`: init, status, then
 *  one PUT per chunk. `2 + k`. */
const putChunkRequestIndex = (k: number): number => 2 + k;

function chaos09Seeds(env: NodeJS.ProcessEnv = process.env): number[] {
  const seeds = resolveSeeds(env);
  const explicit = env.CHAOS_SEEDS !== undefined && env.CHAOS_SEEDS !== '';
  if (explicit || env.CHAOS_NIGHTLY === '1') return seeds;
  return seeds.slice(0, 1);
}

describe('CHAOS-09 media upload interruption at every chunk boundary', () => {
  beforeAll(async () => {
    CHUNK_SIZE = await probeChunkSize();
    expect(CHUNK_SIZE).toBeGreaterThan(0);
  });

  for (const seed of chaos09Seeds()) {
    // 5 chunks: 0..3 full (`chunkSize`), 4 short (3 bytes). Every boundary k ∈ [0, 4].
    const boundaries = [0, 1, 2, 3, 4] as const;

    // ── F1 / F2 at every chunk boundary ─────────────────────────────────────────────────────────
    for (const point of ['F1', 'F2'] as const) {
      for (const k of boundaries) {
        test(`CHAOS-09 ${point} interrupting chunk ${k} → resume completes, hash matches [seed ${seed}]`, async () => {
          await withSeed(
            seed,
            async () => {
              const world = await buildWorld(seed, CHUNK_SIZE);
              try {
                const faultFetch = new FaultFetch(world.server.fetch, [
                  { atIndex: putChunkRequestIndex(k), point: point as FaultPoint },
                ]);
                const { loop, transport, surface, walk } = buildDrain(world, faultFetch);

                await walk.observe(); // pending
                loop.requestDrain('capture');
                await loop.settle(); // interrupted → item failed
                await walk.observe(); // failed

                // POSITIVE CONTROL: the fault genuinely fired and interrupted mid-transfer.
                expect(faultFetch.requestCount).toBeGreaterThan(putChunkRequestIndex(k));
                expect(surface.codes()).toContain('NETWORK'); // classify(code:null) → NETWORK failed
                const failedItem = await findMediaItem(world.device.db, world.mediaId);
                expect(failedItem?.uploadStatus).toBe('failed');

                // The SERVER inventory was genuinely PARTIAL. F1: chunk k never reached (0..k-1).
                // F2: the server processed the request FULLY before losing the response (0..k).
                const receivedAtInterrupt = await serverReceived(world.server, world.mediaId);
                const expectedPartial =
                  point === 'F1'
                    ? boundaries.slice(0, k) // {0..k-1}
                    : boundaries.slice(0, k + 1); // {0..k}
                expect(receivedAtInterrupt).toEqual([...expectedPartial]);
                // Never stored twice — one row per index, even at the interruption point.
                const stats = await serverChunkStats(world.server, world.mediaId);
                expect(stats.total).toBe(stats.distinct);

                // Resume via connectivity regained (06 §5.2(a)); the loop drains to completion.
                await loop.onConnectivityRegained();
                await loop.settle();
                await walk.observe(); // uploaded

                // Re-PUT positive control: F1 lost chunk k → it IS re-sent (log has it twice); F2
                // stored chunk k → the server-authoritative resume must NOT re-send it (log once).
                const putsOfK = transport.putLog.filter((i) => i === k).length;
                expect(putsOfK).toBe(point === 'F1' ? 2 : 1);

                await assertUploadedAndVerified(world);
                // pending → uploading → failed → uploading → uploaded.
                assertLegalWalk(walk.steps);
                expect(walk.steps).toContain('failed');
              } finally {
                await world.close();
              }
            },
            'CHAOS-09',
          );
        });
      }
    }

    // ── F3 (client crash) at every chunk boundary ───────────────────────────────────────────────
    for (const k of boundaries) {
      test(`CHAOS-09 F3 crash after chunk ${k} → recover, resume completes, hash matches [seed ${seed}]`, async () => {
        await withSeed(
          seed,
          async () => {
            const world = await buildWorld(seed, CHUNK_SIZE);
            try {
              const faultFetch = new FaultFetch(world.server.fetch, [
                { atIndex: putChunkRequestIndex(k), point: 'F3' as FaultPoint },
              ]);
              const { loop, transport, surface, walk } = buildDrain(world, faultFetch);
              transport.armCrashOnF3();

              await walk.observe(); // pending
              loop.requestDrain('capture');
              await expect(loop.settle()).rejects.toBeInstanceOf(ClientCrashError);
              await walk.observe(); // still uploading (outcome unpersisted)

              // POSITIVE CONTROL: F3 fired (response received → server HAS chunk k), the crash left
              // the item mid-flight, and nothing was double-stored.
              expect(faultFetch.firedClientCrashes.some((c) => c.point === 'F3')).toBe(true);
              const crashedItem = await findMediaItem(world.device.db, world.mediaId);
              expect(crashedItem?.uploadStatus).toBe('uploading');
              expect(await serverReceived(world.server, world.mediaId)).toEqual([
                ...boundaries.slice(0, k + 1),
              ]);
              expect(surface.events).toHaveLength(0); // a crash is not a surfaced failure

              // Reopen: recover walks `uploading → pending` (the machine's `recover` arm), then a
              // FRESH loop resumes from the server's inventory.
              const recovered = await recoverInterruptedUploads(world.device.db);
              expect(recovered).toBe(1);
              await walk.observe(); // pending

              transport.disarmCrash();
              const { loop: loop2, walk: walk2 } = buildDrain2(world, faultFetch, transport, walk);
              loop2.requestDrain('capture');
              await loop2.settle();
              await walk2.observe(); // uploaded

              // The server already held chunk k (F3), so the resume did NOT re-send it.
              expect(transport.putLog.filter((i) => i === k).length).toBe(1);

              await assertUploadedAndVerified(world);
              // pending → uploading → pending (recover) → uploading → uploaded.
              assertLegalWalk(walk.steps);
              expect(walk.steps.indexOf('pending', 1)).toBeGreaterThan(0); // the recover walk
            } finally {
              await world.close();
            }
          },
          'CHAOS-09',
        );
      });
    }

    // ── Mid-chunk WIRE truncation (a partial chunk body) ────────────────────────────────────────
    test(`CHAOS-09 truncated chunk body → rejected CHUNK_SIZE_INVALID, re-sent cleanly [seed ${seed}]`, async () => {
      await withSeed(
        seed,
        async () => {
          const world = await buildWorld(seed, CHUNK_SIZE);
          try {
            const faultFetch = new FaultFetch(world.server.fetch, []); // no boundary fault
            const { loop, transport, surface, walk } = buildDrain(world, faultFetch);
            const truncatedIndex = 1;
            transport.armTruncation(truncatedIndex, CHUNK_SIZE - 7); // partial body

            await walk.observe(); // pending
            loop.requestDrain('capture');
            await loop.settle(); // truncated PUT rejected → item failed
            await walk.observe(); // failed

            // POSITIVE CONTROL: the server rejected the short body; nothing of chunk 1 was stored.
            expect(surface.codes()).toContain('CHUNK_SIZE_INVALID');
            const failedItem = await findMediaItem(world.device.db, world.mediaId);
            expect(failedItem?.uploadStatus).toBe('failed');
            expect(await serverReceived(world.server, world.mediaId)).toEqual([0]);

            await loop.onConnectivityRegained();
            await loop.settle();
            await walk.observe(); // uploaded

            // The truncated chunk was re-sent (log has index 1 twice) and now at full size.
            expect(transport.putLog.filter((i) => i === truncatedIndex).length).toBe(2);

            await assertUploadedAndVerified(world);
            assertLegalWalk(walk.steps);
            expect(walk.steps).toContain('failed');
          } finally {
            await world.close();
          }
        },
        'CHAOS-09',
      );
    });

    // ── Server dedup / overwrite (the "never stored twice" mechanism, DIRECTLY) ──────────────────
    test(`CHAOS-09 a re-PUT of an already-received index overwrites and does not double-store [seed ${seed}]`, async () => {
      await withSeed(
        seed,
        async () => {
          const world = await buildWorld(seed, CHUNK_SIZE);
          try {
            const transport = new HarnessMediaTransport(world.server.fetch, world.auth);
            const totalChunks = 5;
            const init = await transport.init(world.mediaId, {
              sizeBytes: world.sizeBytes,
              sha256: world.sha256,
              mime: 'image/jpeg',
              type: 'image',
              metadata: {
                capturedAt: world.device.clock.now(),
                location: null,
                userId: world.identity.userId,
                deviceId: world.identity.deviceId,
              },
            });
            expect(init.totalChunks).toBe(totalChunks);
            const chunkOf = (k: number): Uint8Array =>
              world.content.subarray(
                k * CHUNK_SIZE,
                Math.min((k + 1) * CHUNK_SIZE, world.sizeBytes),
              );

            // PUT chunk 0 with WRONG bytes first (same length), then re-PUT it CORRECT — the overwrite
            // is what makes the final hash match. A broken `onConflict` (doNothing) leaves the wrong
            // bytes and `complete` fails HASH_MISMATCH. This is falsification #1's target.
            const wrongChunk0 = new Uint8Array(chunkOf(0).length); // all zeros, correct length
            await transport.putChunk(world.mediaId, 0, wrongChunk0);
            expect(await serverReceived(world.server, world.mediaId)).toEqual([0]);
            await transport.putChunk(world.mediaId, 0, chunkOf(0)); // overwrite, same index

            // Never stored twice: still exactly one row for index 0.
            const afterReput = await serverChunkStats(world.server, world.mediaId);
            expect(afterReput.total).toBe(1);
            expect(afterReput.distinct).toBe(1);
            expect(await serverReceived(world.server, world.mediaId)).toEqual([0]);

            for (let k = 1; k < totalChunks; k += 1)
              await transport.putChunk(world.mediaId, k, chunkOf(k));
            // Re-PUT one already-present index once more for good measure — inventory stays 5 rows.
            await transport.putChunk(world.mediaId, 2, chunkOf(2));
            const beforeComplete = await serverChunkStats(world.server, world.mediaId);
            expect(beforeComplete.total).toBe(totalChunks);
            expect(beforeComplete.distinct).toBe(totalChunks);

            const done = await transport.complete(world.mediaId);
            expect(done.status).toBe('complete');
            const downloaded = await transport.download(world.mediaId);
            expect(hex(noblePort.sha256(downloaded))).toBe(world.sha256);
          } finally {
            await world.close();
          }
        },
        'CHAOS-09',
      );
    });

    // ── FR-1138 / api/01 §8: the op referencing the media syncs independently of completion ──────
    test(`CHAOS-09 the op referencing the media syncs while the media is NOT uploaded [seed ${seed}]`, async () => {
      await withSeed(
        seed,
        async () => {
          const world = await buildWorld(seed, CHUNK_SIZE);
          try {
            // The media has never been inited on the server (no `media` row).
            expect(await serverMediaStatus(world.server, world.mediaId)).toBeNull();

            const opTransport = new HttpTransport(world.server.fetch, world.auth);
            const ops = await world.device.wireOps();
            const noteOp = ops.find(
              (op) => op.type === 'notes.note_created' && op.entityId === world.noteId,
            );
            expect(noteOp).toBeDefined();
            const pushRes = await opTransport.push({ deviceId: world.identity.deviceId, ops });
            // Every op accepted — the server never cross-validates the mediaId against a media row.
            expect(pushRes.results.every((r) => r.status === 'accepted')).toBe(true);
            // The media is STILL not present/complete on the server: op sync did not require it.
            expect(await serverMediaStatus(world.server, world.mediaId)).toBeNull();
          } finally {
            await world.close();
          }
        },
        'CHAOS-09',
      );
    });

    // ── Positive control: a NO-FAULT drain completes (the resume target) ─────────────────────────
    test(`CHAOS-09 positive control: a no-fault drain completes with no failure and matching hash [seed ${seed}]`, async () => {
      await withSeed(
        seed,
        async () => {
          const world = await buildWorld(seed, CHUNK_SIZE);
          try {
            const faultFetch = new FaultFetch(world.server.fetch, []);
            const { loop, transport, surface, walk } = buildDrain(world, faultFetch);
            await walk.observe(); // pending
            loop.requestDrain('capture');
            await loop.settle();
            await walk.observe(); // uploaded
            // A fault-free run never fails, never crashes, and sends each chunk exactly once. This is
            // what makes every fault case's failure/re-send attributable to the injected fault (§2.11).
            expect(surface.events).toHaveLength(0);
            expect(faultFetch.firedClientCrashes).toHaveLength(0);
            expect(transport.putLog).toEqual([0, 1, 2, 3, 4]);
            await assertUploadedAndVerified(world);
            expect(walk.steps).toEqual(['pending', 'uploading', 'uploaded']);
          } finally {
            await world.close();
          }
        },
        'CHAOS-09',
      );
    });
  }
});

/** The F3 reopen: a FRESH drain loop (new in-memory state) over the SAME device DB, transport (with
 *  its PUT log) and status walk — modelling the process restart §3.5 requires. */
function buildDrain2(
  world: MediaWorld,
  _faultFetch: FaultFetch,
  transport: FaultyMediaTransport,
  walk: StatusWalk,
): { loop: MediaDrainLoop<ClientDatabase>; walk: StatusWalk } {
  const clock: ClockPort = { now: () => world.device.clock.now() };
  const files = new InMemoryMediaFile(world.content);
  const surface = new CaptureMediaSurface();
  const loop = new MediaDrainLoop({ db: world.device.db, transport, files, clock, surface });
  return { loop, walk };
}
