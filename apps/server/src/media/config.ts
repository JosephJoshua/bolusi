// Media surface runtime knobs.
//
// FLAGGED DEVIATION (security-guide §10): the boot config module (`src/config.ts`, task 12) is the
// single Zod-validated env reader and is out of this task's edit scope (owned by task 12; touching
// it risks a parallel-agent conflict). So `MEDIA_STORAGE_DIR` is read HERE, once, at media-router
// construction. `.env.example` lists it as required; production MUST set it (media is evidence and
// must persist). The tmpdir fallback is a DEV/TEST safety net only — wiring MEDIA_STORAGE_DIR into
// loadConfig()'s boot validation is a coordinated follow-up (noted for task 31).
import os from 'node:os';
import path from 'node:path';

/** Chunk-PUT rate limit — 600 / min / device (api/03-media §8). Other media endpoints inherit the
 *  api/00 §11 default (deps.deviceRateLimits.perRoutePerMinute). */
export const MEDIA_CHUNK_RATE_PER_MINUTE = 600;

/** Resolve the blob storage root (api/03-media §6). Dev/test fallback under the OS temp dir. */
export function resolveMediaStorageDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env['MEDIA_STORAGE_DIR'];
  if (dir !== undefined && dir !== '') return dir;
  return path.join(os.tmpdir(), 'bolusi-media-v0');
}
