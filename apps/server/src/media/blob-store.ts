// Blob storage for assembled media (api/03-media §6). The `BlobStore` interface is the seam an
// S3/MinIO backend drops behind in v1 (roadmap); v0 ships `LocalDiskBlobStore` — server-local
// disk under `MEDIA_STORAGE_DIR`, keys server-generated as `t/{tenantId}/m/{mediaId}` (§6). No
// client input ever reaches a filesystem path: the only client-controlled path parts are the
// UUID-validated `:id` and the range-checked `:index`, and neither is concatenated into a key
// (security-guide §7.1). This class ALSO refuses a traversing key defensively — the write-once
// key discipline is enforced here, not merely assumed upstream (SEC-MEDIA-04 fs assertion).
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

/** Write-once object storage (api/03-media §6). Keys are opaque server-generated strings. */
export interface BlobStore {
  /** Write `data` at `key`. Idempotent: re-putting the same key with identical bytes overwrites
   *  atomically (no partial write ever visible). Crash-safety of `complete` rests on this (§3.4). */
  put(key: string, data: Uint8Array): Promise<void>;
  /** Read `key` as a stream. Rejects if the key is absent (a completed media whose blob vanished
   *  is a server fault, surfaced as STORAGE_ERROR by the caller). */
  getStream(key: string): Promise<ReadableStream<Uint8Array>>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}

/** The server-generated key for a media object (api/03-media §6). tenantId/mediaId are UUIDs
 *  validated at the boundary; this function never sees client path input. */
export function mediaStorageKey(tenantId: string, mediaId: string): string {
  return `t/${tenantId}/m/${mediaId}`;
}

/** A key that escaped the storage root, or carried a traversal/absolute/NUL segment. */
export class UnsafeBlobKeyError extends Error {
  constructor(key: string) {
    super(`unsafe blob key rejected: ${JSON.stringify(key)}`);
    this.name = 'UnsafeBlobKeyError';
  }
}

/**
 * Resolve `key` to an absolute path strictly inside `root`.
 *
 * Defense in depth (SEC-MEDIA-04): even though production keys are built from validated UUIDs,
 * a key containing `..`, an absolute segment, a backslash, or a NUL byte is rejected outright,
 * and the resolved path is asserted to sit under `root`. A traversal can therefore never reach a
 * filesystem path even if a future caller forgets to validate its inputs.
 */
function resolveWithinRoot(root: string, key: string): string {
  if (key === '' || key.includes('\0') || key.includes('\\')) {
    throw new UnsafeBlobKeyError(key);
  }
  const segments = key.split('/');
  for (const segment of segments) {
    // Empty (leading/trailing/double slash), current-dir, parent-dir, or an absolute Windows
    // drive segment — all forbidden. A well-formed key is `t/<uuid>/m/<uuid>`.
    if (segment === '' || segment === '.' || segment === '..' || /^[A-Za-z]:$/.test(segment)) {
      throw new UnsafeBlobKeyError(key);
    }
  }
  const absoluteRoot = path.resolve(root);
  const target = path.resolve(absoluteRoot, key);
  if (target !== absoluteRoot && !target.startsWith(absoluteRoot + path.sep)) {
    throw new UnsafeBlobKeyError(key);
  }
  return target;
}

/** v0 blob store: server-local disk rooted at `MEDIA_STORAGE_DIR` (api/03-media §6). */
export class LocalDiskBlobStore implements BlobStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = path.resolve(root);
  }

  /** The resolved storage root — the fs assertion in SEC-MEDIA-04 checks blobs live only here. */
  get root(): string {
    return this.#root;
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    const target = resolveWithinRoot(this.#root, key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    // Atomic publish: write a unique temp file in the same directory, then rename over the key.
    // rename(2) within a directory is atomic, so a reader never observes a partial object and a
    // crash mid-write leaves either the old object or none — never a torn one (§6 "no partial
    // writes visible"). The temp name is server-generated; no client input touches it.
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, target);
  }

  async getStream(key: string): Promise<ReadableStream<Uint8Array>> {
    const target = resolveWithinRoot(this.#root, key);
    // Surface a missing object as a rejected promise so the download handler maps it to
    // STORAGE_ERROR rather than streaming an empty body under a complete media row.
    await fs.access(target);
    return Readable.toWeb(createReadStream(target)) as ReadableStream<Uint8Array>;
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(resolveWithinRoot(this.#root, key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await fs.rm(resolveWithinRoot(this.#root, key));
    } catch (err) {
      // Absent is fine (idempotent delete); anything else propagates.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}
