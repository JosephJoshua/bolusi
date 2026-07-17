// Media integration harness: a temp blob dir, a real PostgreSQL 16 DB (cloned per test) with
// RLS-aware forTenant, the
// real production `createApp` wired to them, plus deterministic fixtures/seeders and request
// builders. Fixtures are seeded through the OWNER handle (bypasses RLS) so a probe can then fail to
// reach them under `SET LOCAL ROLE bolusi_app` — the non-vacuous pattern (testing-guide §2.5).
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Kysely } from 'kysely';

import type { DB } from '@bolusi/db-server';

import { LocalDiskBlobStore, mediaStorageKey } from '../../src/media/blob-store.js';
import { MEDIA_CHUNK_SIZE } from '../../src/media/schemas.js';
import { enrollDevice, makeTestApp, type TestHarness } from './app.js';
import { makeMediaTestDb, type MediaTestDb } from './media-db.js';

// ── deterministic ids + bytes (testing-guide T-3/T-6: per-seed values, no RNG) ──────────────────

function seedBytes(seed: string): Buffer {
  return createHash('sha256').update(seed).digest();
}

/** A valid lowercase UUIDv7 (version 7, RFC 4122 variant) derived from `seed`. Media ids MUST be
 *  v7 (zMediaIdParam / z.uuidv7). */
export function detUuidV7(seed: string): string {
  const b = Buffer.from(seedBytes(seed).subarray(0, 16));
  b.writeUInt8((b.readUInt8(6) & 0x0f) | 0x70, 6); // version 7
  b.writeUInt8((b.readUInt8(8) & 0x3f) | 0x80, 8); // variant 10
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A valid RFC 4122 v4 UUID from `seed` (for tenant/store/device/user ids — any version accepted). */
export function detUuid(seed: string): string {
  const b = Buffer.from(seedBytes(seed).subarray(0, 16));
  b.writeUInt8((b.readUInt8(6) & 0x0f) | 0x40, 6); // version 4
  b.writeUInt8((b.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The server-generated blob key for (tenant, media) — for fs/blob assertions in tests. */
export function mediaStorageKeyForTest(tenantId: string, mediaId: string): string {
  return mediaStorageKey(tenantId, mediaId);
}

const MAGIC: Record<'image/jpeg' | 'image/png', number[]> = {
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
};

/** A `size`-byte "image" with the correct magic prefix for `mime`, filled deterministically from
 *  `seed`. Body content is arbitrary — only the leading magic bytes are checked at complete. */
export function buildImage(
  size: number,
  mime: 'image/jpeg' | 'image/png',
  seed = 'img',
): Uint8Array {
  const bytes = new Uint8Array(size);
  const magic = MAGIC[mime];
  for (let i = 0; i < size; i += 1)
    bytes[i] = (seedBytes(`${seed}:${i & 1023}`)[i % 32] ?? 0) & 0xff;
  for (let i = 0; i < magic.length && i < size; i += 1) bytes[i] = magic[i] as number;
  return bytes;
}

/** Split `bytes` into 262144-byte chunks (last is short). */
export function chunkize(bytes: Uint8Array, chunkSize = MEDIA_CHUNK_SIZE): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let off = 0; off < bytes.length; off += chunkSize) {
    chunks.push(bytes.subarray(off, Math.min(off + chunkSize, bytes.length)));
  }
  return chunks.length === 0 ? [new Uint8Array(0)] : chunks;
}

// ── harness ─────────────────────────────────────────────────────────────────────────────────────

export interface DeviceContext {
  readonly tenantId: string;
  readonly storeId: string | null;
  readonly deviceId: string;
  readonly userId: string;
  readonly token: string;
  readonly auth: string;
}

export interface MediaHarness extends TestHarness {
  readonly storageDir: string;
  readonly blobStore: LocalDiskBlobStore;
  readonly db: Kysely<DB>;
  readonly testDb: MediaTestDb;
  /** Seed a tenant + store + device + user through the owner handle, and enroll the device token. */
  seedDevice(seed: string, opts?: { storeId?: string | null }): Promise<DeviceContext>;
  /** Seed a SECOND device (+ its own user) into an EXISTING tenant/store, and enroll its token.
   *  For uploader-binding tests: two devices, one tenant. */
  seedDeviceInTenant(
    seed: string,
    tenant: { tenantId: string; storeId: string | null },
  ): Promise<DeviceContext>;
  /** Seed a store owned by a tenant (owner handle). */
  seedStore(tenantId: string, seed: string): Promise<string>;
  /** Seed a COMPLETE media row + write its blob (for download-scope tests). Returns id + sha. */
  seedCompleteMedia(spec: {
    tenantId: string;
    storeId: string | null;
    deviceId: string;
    userId: string;
    bytes: Uint8Array;
    mime?: 'image/jpeg' | 'image/png';
    seed: string;
  }): Promise<{ mediaId: string; sha256: string; storageKey: string }>;
  /** Read a blob's bytes from the store (fs assertions / immutability checks). */
  readBlob(key: string): Promise<Uint8Array>;
  close(): Promise<void>;
}

export async function makeMediaHarness(): Promise<MediaHarness> {
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bolusi-media-test-'));
  process.env['MEDIA_STORAGE_DIR'] = storageDir; // read by createMediaRouter at construction
  const testDb = await makeMediaTestDb();
  const harness = makeTestApp({ forTenant: testDb.appForTenant });
  const blobStore = new LocalDiskBlobStore(storageDir);

  async function seedStore(tenantId: string, seed: string): Promise<string> {
    const storeId = detUuid(`${seed}:store`);
    await testDb.db
      .insertInto('stores')
      .values({ id: storeId, tenantId, name: `store-${seed}`, createdAt: 1 })
      .execute();
    return storeId;
  }

  async function seedDevice(
    seed: string,
    opts: { storeId?: string | null } = {},
  ): Promise<DeviceContext> {
    const tenantId = detUuid(`${seed}:tenant`);
    const storeId = opts.storeId === undefined ? detUuid(`${seed}:store`) : opts.storeId;
    const deviceId = detUuid(`${seed}:device`);
    const userId = detUuid(`${seed}:user`);
    const token = `bdt_${seedBytes(`${seed}:tok`).toString('hex')}`;

    await testDb.db
      .insertInto('tenants')
      .values({ id: tenantId, name: `tenant-${seed}`, createdAt: 1 })
      .execute();
    if (storeId !== null) {
      await testDb.db
        .insertInto('stores')
        .values({ id: storeId, tenantId, name: `store-${seed}`, createdAt: 1 })
        .execute();
    }
    await testDb.db
      .insertInto('devices')
      .values({
        id: deviceId,
        tenantId,
        storeId,
        kind: storeId === null ? 'system' : 'member',
        signingKeyPublic: `pub-${seed}`,
        enrolledAt: 1,
      })
      .execute();
    await testDb.db
      .insertInto('users')
      .values({ id: userId, tenantId, name: `user-${seed}`, createdAt: 1 })
      .execute();

    const auth = enrollDevice(harness, { deviceId, tenantId, storeId, token });
    return { tenantId, storeId, deviceId, userId, token, auth };
  }

  async function seedDeviceInTenant(
    seed: string,
    tenant: { tenantId: string; storeId: string | null },
  ): Promise<DeviceContext> {
    const deviceId = detUuid(`${seed}:device`);
    const userId = detUuid(`${seed}:user`);
    const token = `bdt_${seedBytes(`${seed}:tok`).toString('hex')}`;
    await testDb.db
      .insertInto('devices')
      .values({
        id: deviceId,
        tenantId: tenant.tenantId,
        storeId: tenant.storeId,
        kind: tenant.storeId === null ? 'system' : 'member',
        signingKeyPublic: `pub-${seed}`,
        enrolledAt: 1,
      })
      .execute();
    await testDb.db
      .insertInto('users')
      .values({ id: userId, tenantId: tenant.tenantId, name: `user-${seed}`, createdAt: 1 })
      .execute();
    const auth = enrollDevice(harness, {
      deviceId,
      tenantId: tenant.tenantId,
      storeId: tenant.storeId,
      token,
    });
    return { tenantId: tenant.tenantId, storeId: tenant.storeId, deviceId, userId, token, auth };
  }

  async function seedCompleteMedia(spec: {
    tenantId: string;
    storeId: string | null;
    deviceId: string;
    userId: string;
    bytes: Uint8Array;
    mime?: 'image/jpeg' | 'image/png';
    seed: string;
  }): Promise<{ mediaId: string; sha256: string; storageKey: string }> {
    const mediaId = detUuidV7(`${spec.seed}:media`);
    const sha = sha256Hex(spec.bytes);
    const storageKey = mediaStorageKey(spec.tenantId, mediaId);
    const totalChunks = Math.max(1, Math.ceil(spec.bytes.length / MEDIA_CHUNK_SIZE));
    await testDb.db
      .insertInto('media')
      .values({
        id: mediaId,
        tenantId: spec.tenantId,
        storeId: spec.storeId,
        capturedByUserId: spec.userId,
        deviceId: spec.deviceId,
        type: 'image',
        mimeType: spec.mime ?? 'image/jpeg',
        byteSize: spec.bytes.length,
        sha256: sha,
        capturedAt: 1,
        location: null,
        chunkSize: MEDIA_CHUNK_SIZE,
        chunksTotal: totalChunks,
        storageKey,
        status: 'complete',
        completedAt: 2,
        createdAt: 1,
      })
      .execute();
    await blobStore.put(storageKey, spec.bytes);
    return { mediaId, sha256: sha, storageKey };
  }

  return {
    ...harness,
    storageDir,
    blobStore,
    db: testDb.db,
    testDb,
    seedDevice,
    seedDeviceInTenant,
    seedStore,
    seedCompleteMedia,
    async readBlob(key: string): Promise<Uint8Array> {
      const reader = (await blobStore.getStream(key)).getReader();
      const parts: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
      }
      return new Uint8Array(Buffer.concat(parts.map((p) => Buffer.from(p))));
    },
    async close() {
      await testDb.close();
      await fs.rm(storageDir, { recursive: true, force: true });
      delete process.env['MEDIA_STORAGE_DIR'];
    },
  };
}

// ── request builders ────────────────────────────────────────────────────────────────────────────

const BASE = 'http://media.test';

export interface InitBody {
  sizeBytes: number;
  sha256: string;
  mime: string;
  type: 'image' | 'signature' | 'video';
  metadata: {
    capturedAt: number;
    location: { lat: number; lng: number; accuracyMeters: number } | null;
    userId: string;
    deviceId: string;
  };
}

/** An init body for a full file captured by `ctx` (sha over the whole file). */
export function initBodyFor(
  ctx: DeviceContext,
  bytes: Uint8Array,
  mime: 'image/jpeg' | 'image/png',
): InitBody {
  return {
    sizeBytes: bytes.length,
    sha256: sha256Hex(bytes),
    mime,
    type: 'image',
    metadata: {
      capturedAt: 1_700_000_000_000,
      location: null,
      userId: ctx.userId,
      deviceId: ctx.deviceId,
    },
  };
}

export function initReq(id: string, body: unknown, auth: string): Request {
  return new Request(`${BASE}/v1/media/${id}/init`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function chunkReq(
  id: string,
  index: number | string,
  bytes: Uint8Array,
  auth: string,
  extraHeaders: Record<string, string> = {},
): Request {
  return new Request(`${BASE}/v1/media/${id}/chunks/${index}`, {
    method: 'PUT',
    headers: { Authorization: auth, 'Content-Type': 'application/octet-stream', ...extraHeaders },
    body: bytes,
  });
}

export function statusReq(id: string, auth: string): Request {
  return new Request(`${BASE}/v1/media/${id}/status`, { headers: { Authorization: auth } });
}

export function completeReq(id: string, auth: string): Request {
  return new Request(`${BASE}/v1/media/${id}/complete`, {
    method: 'POST',
    headers: { Authorization: auth },
  });
}

export function downloadReq(
  id: string,
  auth: string,
  extraHeaders: Record<string, string> = {},
): Request {
  return new Request(`${BASE}/v1/media/${id}`, {
    headers: { Authorization: auth, ...extraHeaders },
  });
}

/** Drive a full upload (init → all chunks → complete) and return the media id + file bytes. */
export async function uploadFull(
  h: MediaHarness,
  ctx: DeviceContext,
  bytes: Uint8Array,
  mime: 'image/jpeg' | 'image/png',
  seed: string,
): Promise<{ mediaId: string }> {
  const mediaId = detUuidV7(`${seed}:media`);
  const initRes = await h.app.request(initReq(mediaId, initBodyFor(ctx, bytes, mime), ctx.auth));
  if (initRes.status !== 200)
    throw new Error(`init failed ${initRes.status}: ${await initRes.text()}`);
  const chunks = chunkize(bytes);
  for (let i = 0; i < chunks.length; i += 1) {
    const put = await h.app.request(chunkReq(mediaId, i, chunks[i] as Uint8Array, ctx.auth));
    if (put.status !== 200) throw new Error(`chunk ${i} failed ${put.status}: ${await put.text()}`);
  }
  const done = await h.app.request(completeReq(mediaId, ctx.auth));
  if (done.status !== 200) throw new Error(`complete failed ${done.status}: ${await done.text()}`);
  return { mediaId };
}
