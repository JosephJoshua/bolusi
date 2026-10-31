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

/** v0 blob store: server-local disk rooted at `MEDIA_STORAGE_DIR` (api/03-media §6). Directories
 *  are created 0700 and blobs 0600 (media is customer evidence), and every path is resolved through
 *  the filesystem's real path so a symlink planted inside the root cannot redirect a read or write. */
export class LocalDiskBlobStore implements BlobStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = path.resolve(root);
  }

  /** The resolved storage root — the fs assertion in SEC-MEDIA-04 checks blobs live only here. */
  get root(): string {
    return this.#root;
  }

  /** The real path of an existing `target`, refused unless it sits under the root's real path.
   *  `resolveWithinRoot` only compares text; this follows symlinks. Rejects ENOENT if absent. */
  async #realWithinRoot(target: string, key: string): Promise<string> {
    const realRoot = await fs.realpath(this.#root);
    const real = await fs.realpath(target);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
      throw new UnsafeBlobKeyError(key);
    }
    return real;
  }

  /** Creates `key`'s parent directories 0700 one level at a time, refusing any level that is not a
   *  real directory (a planted symlink), so `mkdir -p` never builds through a link. */
  async #ensureParentDirs(key: string): Promise<void> {
    await fs.mkdir(this.#root, { recursive: true, mode: 0o700 });
    let dir = this.#root;
    for (const segment of key.split('/').slice(0, -1)) {
      dir = path.join(dir, segment);
      try {
        await fs.mkdir(dir, { mode: 0o700 });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      if (!(await fs.lstat(dir)).isDirectory()) throw new UnsafeBlobKeyError(key);
    }
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    const target = resolveWithinRoot(this.#root, key);
    await this.#ensureParentDirs(key);
    const dir = await this.#realWithinRoot(path.dirname(target), key);
    const finalPath = path.join(dir, path.basename(target));
    // Atomic publish: write a unique temp file in the same directory, then rename over the key.
    // rename(2) within a directory is atomic, so a reader never observes a partial object and a
    // crash mid-write leaves either the old object or none — never a torn one (§6 "no partial
    // writes visible"). The temp name is server-generated; no client input touches it. `wx`
    // refuses to follow anything already at that name.
    const tmp = `${finalPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await fs.writeFile(tmp, data, { mode: 0o600, flag: 'wx' });
    await fs.rename(tmp, finalPath);
  }

  async getStream(key: string): Promise<ReadableStream<Uint8Array>> {
    // Surface a missing object as a rejected promise so the download handler maps it to
    // STORAGE_ERROR rather than streaming an empty body under a complete media row.
    const real = await this.#realWithinRoot(resolveWithinRoot(this.#root, key), key);
    return Readable.toWeb(createReadStream(real)) as ReadableStream<Uint8Array>;
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.#realWithinRoot(resolveWithinRoot(this.#root, key), key);
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    const target = resolveWithinRoot(this.#root, key);
    try {
      const dir = await this.#realWithinRoot(path.dirname(target), key);
      await fs.rm(path.join(dir, path.basename(target)));
    } catch (err) {
      // Absent is fine (idempotent delete); anything else propagates.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}
