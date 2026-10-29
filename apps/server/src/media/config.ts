// Media surface runtime knobs.
//
// `MEDIA_STORAGE_DIR` is read HERE, once, at media-router construction. It is REQUIRED for a running
// server: main.ts refuses to boot without it (`requireMediaStorageDir`), because media is evidence
// and must persist. An app built without main.ts (tests, the harness lane) gets a fresh private
// temp directory instead, never a fixed shared path another local user could create first.
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

/** Chunk-PUT rate limit — 600 / min / device (api/03-media §8). Other media endpoints inherit the
 *  api/00 §11 default (deps.deviceRateLimits.perRoutePerMinute). */
export const MEDIA_CHUNK_RATE_PER_MINUTE = 600;

/** Resolve the blob storage root (api/03-media §6). Unset (tests only, see `requireMediaStorageDir`)
 *  ⇒ an unguessable path under the OS temp dir, which the blob store creates 0700 on first write. */
export function resolveMediaStorageDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env['MEDIA_STORAGE_DIR'];
  if (dir !== undefined && dir !== '') return dir;
  return path.join(os.tmpdir(), `bolusi-media-${randomUUID()}`);
}

/** Boot check (main.ts): a running server must keep media on a configured, persistent path. */
export function requireMediaStorageDir(env: NodeJS.ProcessEnv = process.env): void {
  const dir = env['MEDIA_STORAGE_DIR'];
  if (dir === undefined || dir === '') {
    throw new Error(
      'MEDIA_STORAGE_DIR is not set — refusing to boot without a persistent media directory ' +
        '(api/03-media §6). Set it to a backed-up path only the server user can access.',
    );
  }
}
