// Media sub-router — the api/03-media wire protocol (task 19). init → PUT chunks → status →
// complete → download, plus assembly, whole-file SHA-256, magic-byte mime check, and the §5
// immutability 409s. This is a SECURITY SURFACE (upload/download + access control): SEC-MEDIA-01..06
// ship with it (security-guide §7.2), before review.
//
// Middleware: bearerAuth + the tenant transaction come from task 12 and are REUSED (deps.forTenant,
// the tenant helper). Media routes are excluded from the app-level gzip-decompress + body caps +
// per-device rate limiter (app.ts, `isMedia`) and carry their OWN per-route chain here (api/03 §7):
// no decompression (encoded bodies → 415), init/complete bodyLimit 16 KiB, chunk bodyLimit 262144,
// chunk-PUT rate limit 600/min/device, others 120/min/device.
import { bodyLimit } from 'hono/body-limit';
import { Hono, type Context, type MiddlewareHandler } from 'hono';

import type { ServerDeps } from '../deps.js';
import type { AppEnv } from '../env.js';
import { ApiError, respondError } from '../errors.js';
import { assembleChunks, isAllowedMime, magicBytesMatch } from '../media/assemble.js';
import { LocalDiskBlobStore, mediaStorageKey, type BlobStore } from '../media/blob-store.js';
import { MEDIA_CHUNK_RATE_PER_MINUTE, resolveMediaStorageDir } from '../media/config.js';
import { renderMediaError } from '../media/errors.js';
import {
  MEDIA_CHUNK_SIZE,
  MEDIA_MAX_SIZE_BYTES,
  zMediaChunkParam,
  zMediaIdParam,
  zMediaInitBody,
  zMediaParam,
} from '../media/schemas.js';
import { enforceBucket, type RateLimitStore } from '../middleware/rate-limit.js';
import { zJson } from '../middleware/validator-hook.js';
import { createWithTenant } from '../tenant.js';

/** Init/complete-body byte cap (api/03-media §7). Small JSON envelope — a large one is a bug. */
const MEDIA_JSON_BODY_LIMIT = 16 * 1024; // 16 KiB

/** The last chunk is short (`sizeBytes − (totalChunks−1)·chunkSize`); every other chunk is exactly
 *  `chunkSize` (api/03-media §3.2). */
function expectedChunkSize(
  sizeBytes: number,
  chunkSize: number,
  totalChunks: number,
  index: number,
): number {
  return index === totalChunks - 1 ? sizeBytes - (totalChunks - 1) * chunkSize : chunkSize;
}

type LocationValue = { lat: number; lng: number; accuracyMeters: number } | null;

/** Deep-equality for the init `location` (idempotency comparison). jsonb round-trips to an object
 *  or null; key order is irrelevant since only three known fields exist. */
function locationEqual(a: unknown, b: LocationValue): boolean {
  if (a === null || a === undefined) return b === null;
  if (b === null) return false;
  const l = a as Record<string, unknown>;
  return l['lat'] === b.lat && l['lng'] === b.lng && l['accuracyMeters'] === b.accuracyMeters;
}

/** Coerce a bytea read (Buffer on pg, Uint8Array on PGlite) to a plain Uint8Array. */
function toUint8(value: unknown): Uint8Array {
  return value instanceof Uint8Array ? value : Uint8Array.from(value as ArrayLike<number>);
}

/** Consume a blob stream into bytes. v0 media is ≤ 300 KiB, so buffering the download body is
 *  bounded; the streaming BlobStore interface is kept for the v1 S3/MinIO backend + video. */
async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Reject any request-body content encoding (api/03-media §7): the sync gzip middleware is not
 *  mounted on media routes, so an encoded body is refused outright — nothing is read or stored. */
const rejectContentEncoding: MiddlewareHandler<AppEnv> = async (c, next) => {
  const raw = c.req.raw.headers.get('Content-Encoding');
  const normalized = raw?.trim().toLowerCase();
  if (normalized !== undefined && normalized !== '' && normalized !== 'identity') {
    throw new ApiError('UNSUPPORTED_ENCODING');
  }
  await next();
};

/** Per-device media rate limiter (reuses task 12's token-bucket store + enforceBucket). Chunk PUT
 *  uses a dedicated 600/min bucket; other media endpoints inherit the 120/min default (api/03 §8). */
function mediaRateLimit(
  store: RateLimitStore,
  capacityPerMinute: number,
  keyPrefix: string,
  now: () => number,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const device = c.get('device');
    enforceBucket(store, `${keyPrefix}:${device.deviceId}`, capacityPerMinute, now());
    await next();
  };
}

interface CompleteOutcome {
  kind:
    | 'not_found'
    | 'already'
    | 'chunks_missing'
    | 'hash_mismatch'
    | 'mime_mismatch'
    | 'storage_error'
    | 'ok';
  missing?: number[];
}

export function createMediaRouter(deps: ServerDeps) {
  const blobStore: BlobStore = new LocalDiskBlobStore(resolveMediaStorageDir());
  const withTenant = createWithTenant(deps.forTenant);

  const routeLimit = mediaRateLimit(
    deps.perDeviceStore,
    deps.deviceRateLimits.perRoutePerMinute,
    'media:route',
    deps.now,
  );
  const chunkLimit = mediaRateLimit(
    deps.perDeviceStore,
    MEDIA_CHUNK_RATE_PER_MINUTE,
    'media:chunk',
    deps.now,
  );

  const jsonBodyLimit = bodyLimit({
    maxSize: MEDIA_JSON_BODY_LIMIT,
    onError: (c) =>
      respondError(c as unknown as Context<AppEnv>, 'BODY_TOO_LARGE', {
        limitBytes: MEDIA_JSON_BODY_LIMIT,
      }),
  });
  const chunkBodyLimit = bodyLimit({
    maxSize: MEDIA_CHUNK_SIZE,
    onError: (c) =>
      renderMediaError(c as unknown as Context<AppEnv>, 'CHUNK_TOO_LARGE', {
        limitBytes: MEDIA_CHUNK_SIZE,
      }),
  });

  /** Server-authoritative received chunk indexes, ascending (api/03-media §3.3). */
  const receivedChunks = (
    db: Parameters<Parameters<typeof withTenant>[1]>[0],
    mediaId: string,
  ): Promise<number[]> =>
    db
      .selectFrom('mediaChunks')
      .select('chunkIndex')
      .where('mediaId', '=', mediaId)
      .orderBy('chunkIndex', 'asc')
      .execute()
      .then((rows) => rows.map((r) => r.chunkIndex));

  // Media codes are RETURNED as the §6 envelope (renderMediaError) directly from handlers — a
  // sub-app mounted via app.route() sends a THROWN error to the top-level app.onError, which maps a
  // non-ApiError to 500, so media codes must never travel as exceptions. Transport-level failures
  // (UNSUPPORTED_ENCODING, RATE_LIMITED, BODY_TOO_LARGE) DO throw ApiError from the shared middleware
  // and are handled by app.onError (task 12), keeping their codes/messages single-sourced.
  return (
    new Hono<AppEnv>()
      // ── POST /:id/init ────────────────────────────────────────────────────────────────────────
      .post(
        '/:id/init',
        rejectContentEncoding,
        routeLimit,
        jsonBodyLimit,
        zMediaParam(zMediaIdParam),
        zJson(zMediaInitBody),
        async (c) => {
          const device = c.get('device');
          const { id } = c.req.valid('param');
          const body = c.req.valid('json');

          // Media-code semantic checks (NOT VALIDATION_FAILED): allowlist + size cap (api/03 §3.1).
          if (!isAllowedMime(body.mime)) return renderMediaError(c, 'MIME_UNSUPPORTED');
          if (body.sizeBytes > MEDIA_MAX_SIZE_BYTES) return renderMediaError(c, 'MEDIA_TOO_LARGE');

          return withTenant(c, async (db) => {
            const existing = await db
              .selectFrom('media')
              .select([
                'deviceId',
                'status',
                'byteSize',
                'sha256',
                'mimeType',
                'type',
                'capturedAt',
                'location',
                'capturedByUserId',
                'chunksTotal',
              ])
              .where('id', '=', id)
              .executeTakeFirst();

            if (existing !== undefined) {
              // Uploader binding (api/03 §2): another device's row is invisible → 404, never a
              // mismatch/immutable leak.
              if (existing.deviceId !== device.deviceId)
                return renderMediaError(c, 'MEDIA_NOT_FOUND');
              // Completed media is immutable, always (api/03 §3.1).
              if (existing.status === 'complete') return renderMediaError(c, 'MEDIA_IMMUTABLE');
              // Receiving + same device: byte-identical body → idempotent 200 (crash-resume);
              // any differing field → 409 INIT_MISMATCH.
              const identical =
                Number(existing.byteSize) === body.sizeBytes &&
                existing.sha256 === body.sha256 &&
                existing.mimeType === body.mime &&
                existing.type === body.type &&
                Number(existing.capturedAt) === body.metadata.capturedAt &&
                existing.capturedByUserId === body.metadata.userId &&
                locationEqual(existing.location, body.metadata.location);
              if (!identical) return renderMediaError(c, 'INIT_MISMATCH');
              return c.json({
                chunkSize: MEDIA_CHUNK_SIZE,
                totalChunks: existing.chunksTotal,
                receivedChunks: await receivedChunks(db, id),
                status: existing.status as 'receiving' | 'complete',
              });
            }

            // New media: metadata.userId/deviceId must be enrolled in this tenant (RLS-scoped
            // reads) — else 422 VALIDATION_FAILED (api/03 §3.1).
            const [enrolledUser, enrolledDevice] = await Promise.all([
              db
                .selectFrom('users')
                .select('id')
                .where('id', '=', body.metadata.userId)
                .executeTakeFirst(),
              db
                .selectFrom('devices')
                .select('id')
                .where('id', '=', body.metadata.deviceId)
                .executeTakeFirst(),
            ]);
            if (enrolledUser === undefined || enrolledDevice === undefined) {
              return respondError(c, 'VALIDATION_FAILED', {
                issues: [
                  {
                    path: ['metadata'],
                    code: 'custom',
                    message: 'metadata.userId and metadata.deviceId must be enrolled in the tenant',
                  },
                ],
              });
            }

            const totalChunks = Math.ceil(body.sizeBytes / MEDIA_CHUNK_SIZE);
            await db
              .insertInto('media')
              .values({
                id,
                tenantId: device.tenantId,
                storeId: device.storeId, // the device's store at init; null for store-less devices
                capturedByUserId: body.metadata.userId,
                deviceId: device.deviceId, // uploader binding = the authenticated device (api/03 §2)
                type: body.type,
                mimeType: body.mime,
                byteSize: body.sizeBytes,
                sha256: body.sha256,
                capturedAt: body.metadata.capturedAt,
                location: body.metadata.location,
                chunkSize: MEDIA_CHUNK_SIZE,
                chunksTotal: totalChunks,
                storageKey: null,
                status: 'receiving',
                createdAt: deps.now(),
              })
              .execute();

            return c.json({
              chunkSize: MEDIA_CHUNK_SIZE,
              totalChunks,
              receivedChunks: [] as number[],
              status: 'receiving' as const,
            });
          });
        },
      )

      // ── PUT /:id/chunks/:index ────────────────────────────────────────────────────────────────
      .put(
        '/:id/chunks/:index',
        rejectContentEncoding,
        chunkLimit,
        chunkBodyLimit,
        zMediaParam(zMediaChunkParam),
        async (c) => {
          const device = c.get('device');
          const { id, index } = c.req.valid('param');

          return withTenant(c, async (db) => {
            const media = await db
              .selectFrom('media')
              .select(['deviceId', 'status', 'byteSize', 'chunkSize', 'chunksTotal'])
              .where('id', '=', id)
              .executeTakeFirst();
            if (media === undefined || media.deviceId !== device.deviceId) {
              return renderMediaError(c, 'MEDIA_NOT_FOUND');
            }
            if (media.status === 'complete') return renderMediaError(c, 'MEDIA_IMMUTABLE');
            if (index < 0 || index >= media.chunksTotal) {
              return renderMediaError(c, 'CHUNK_INDEX_INVALID');
            }

            const bytes = new Uint8Array(await c.req.arrayBuffer());
            const expected = expectedChunkSize(
              Number(media.byteSize),
              media.chunkSize,
              media.chunksTotal,
              index,
            );
            if (bytes.byteLength !== expected) return renderMediaError(c, 'CHUNK_SIZE_INVALID');

            // Idempotent: re-PUT overwrites (final integrity rests on the whole-file hash, §3.2).
            await db
              .insertInto('mediaChunks')
              .values({
                mediaId: id,
                chunkIndex: index,
                tenantId: device.tenantId,
                byteSize: bytes.byteLength,
                bytes: Buffer.from(bytes),
                receivedAt: deps.now(),
              })
              .onConflict((oc) =>
                oc.columns(['mediaId', 'chunkIndex']).doUpdateSet({
                  bytes: Buffer.from(bytes),
                  byteSize: bytes.byteLength,
                  receivedAt: deps.now(),
                }),
              )
              .execute();

            return c.json({ receivedChunks: await receivedChunks(db, id) });
          });
        },
      )

      // ── GET /:id/status ───────────────────────────────────────────────────────────────────────
      .get('/:id/status', routeLimit, zMediaParam(zMediaIdParam), async (c) => {
        const device = c.get('device');
        const { id } = c.req.valid('param');
        return withTenant(c, async (db) => {
          const media = await db
            .selectFrom('media')
            .select(['deviceId', 'status', 'byteSize', 'chunkSize', 'chunksTotal'])
            .where('id', '=', id)
            .executeTakeFirst();
          if (media === undefined || media.deviceId !== device.deviceId) {
            return renderMediaError(c, 'MEDIA_NOT_FOUND');
          }
          return c.json({
            status: media.status as 'receiving' | 'complete',
            sizeBytes: Number(media.byteSize),
            chunkSize: media.chunkSize,
            totalChunks: media.chunksTotal,
            receivedChunks: await receivedChunks(db, id),
          });
        });
      })

      // ── POST /:id/complete ────────────────────────────────────────────────────────────────────
      .post(
        '/:id/complete',
        rejectContentEncoding,
        routeLimit,
        jsonBodyLimit,
        zMediaParam(zMediaIdParam),
        async (c) => {
          const device = c.get('device');
          const { id } = c.req.valid('param');

          const outcome = await withTenant(c, async (db): Promise<CompleteOutcome> => {
            const media = await db
              .selectFrom('media')
              .select(['deviceId', 'status', 'sha256', 'mimeType', 'chunksTotal'])
              .where('id', '=', id)
              .forUpdate() // serialize concurrent completes on the media row
              .executeTakeFirst();
            if (media === undefined || media.deviceId !== device.deviceId) {
              return { kind: 'not_found' };
            }
            if (media.status === 'complete') return { kind: 'already' }; // idempotent

            const chunkRows = await db
              .selectFrom('mediaChunks')
              .select(['chunkIndex', 'bytes'])
              .where('mediaId', '=', id)
              .orderBy('chunkIndex', 'asc')
              .execute();

            const present = new Set(chunkRows.map((r) => r.chunkIndex));
            const missing: number[] = [];
            for (let i = 0; i < media.chunksTotal; i += 1) {
              if (!present.has(i)) missing.push(i);
            }
            if (missing.length > 0) return { kind: 'chunks_missing', missing };

            // chunkRows are ascending and gap-free (checked above) → index order.
            const assembled = assembleChunks(chunkRows.map((r) => toUint8(r.bytes)));

            const purgeChunks = () =>
              db.deleteFrom('mediaChunks').where('mediaId', '=', id).execute();

            if (assembled.sha256 !== media.sha256) {
              await purgeChunks(); // corrupt transfer's chunks are worthless (§3.4 step 3)
              return { kind: 'hash_mismatch' };
            }
            if (
              !isAllowedMime(media.mimeType) ||
              !magicBytesMatch(assembled.bytes, media.mimeType)
            ) {
              await purgeChunks(); // declared mime ≠ file contents (§3.4 step 4; SEC-MEDIA-05)
              return { kind: 'mime_mismatch' };
            }

            // Blob write BEFORE marking complete (§3.4 step 6): a crash after the write but before
            // commit leaves status 'receiving' + chunks intact; retried complete re-assembles and
            // put() overwrites the same key idempotently.
            const key = mediaStorageKey(device.tenantId, id);
            try {
              await blobStore.put(key, assembled.bytes);
            } catch {
              return { kind: 'storage_error' };
            }
            await db
              .updateTable('media')
              .set({ status: 'complete', storageKey: key, completedAt: deps.now() })
              .where('id', '=', id)
              .execute();
            await purgeChunks();
            return { kind: 'ok' };
          });

          switch (outcome.kind) {
            case 'not_found':
              return renderMediaError(c, 'MEDIA_NOT_FOUND');
            case 'chunks_missing':
              return renderMediaError(c, 'CHUNKS_MISSING', {
                missingChunks: outcome.missing ?? [],
              });
            case 'hash_mismatch':
              return renderMediaError(c, 'HASH_MISMATCH');
            case 'mime_mismatch':
              return renderMediaError(c, 'MIME_MISMATCH');
            case 'storage_error':
              return renderMediaError(c, 'STORAGE_ERROR');
            case 'already':
            case 'ok':
              return c.json({ status: 'complete' as const });
          }
        },
      )

      // ── GET /:id (download) ───────────────────────────────────────────────────────────────────
      .get('/:id', routeLimit, zMediaParam(zMediaIdParam), async (c) => {
        const device = c.get('device');
        const { id } = c.req.valid('param');

        // Scope = the sync pull rule (api/03 §2 = api/01-sync §4.1): tenant (RLS) AND
        // (store match OR store null). Out-of-scope / incomplete / nonexistent are all one 404.
        const found = await withTenant(c, async (db) => {
          const media = await db
            .selectFrom('media')
            .select(['storeId', 'status', 'mimeType', 'byteSize', 'sha256', 'storageKey'])
            .where('id', '=', id)
            .executeTakeFirst();
          if (media === undefined || media.status !== 'complete' || media.storageKey === null) {
            return null;
          }
          if (media.storeId !== null && media.storeId !== device.storeId) return null;
          return media;
        });
        if (found === null) return renderMediaError(c, 'MEDIA_NOT_FOUND');

        const etag = `"${found.sha256}"`;
        c.header('ETag', etag);
        c.header('Cache-Control', 'private, max-age=31536000, immutable');
        if (c.req.header('If-None-Match') === etag) return c.body(null, 304);

        let bytes: Uint8Array;
        try {
          bytes = await streamToBytes(await blobStore.getStream(found.storageKey as string));
        } catch {
          return renderMediaError(c, 'STORAGE_ERROR');
        }
        c.header('Content-Type', found.mimeType);
        c.header('Content-Length', String(Number(found.byteSize)));
        // streamToBytes returns a fresh, exact-size Uint8Array, so its backing buffer IS the file
        // bytes (c.body takes ArrayBuffer, not a view).
        return c.body(bytes.buffer as ArrayBuffer);
      })
  );
}
