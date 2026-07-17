// Wire schemas for the media surface (api/03-media §3). Kept LOCAL to @bolusi/server rather than
// in the CONTENDED @bolusi/schemas package: task 02 shipped no media DTOs, and touching that
// shared package needs serialization (CLAUDE.md §4). These are the SERVER wire DTOs
// (zMediaInitBody etc.); the shared payload fragment zMediaRef already lives in @bolusi/schemas
// (task 18, packages/schemas/src/media.ts). Lifting these server DTOs into @bolusi/schemas for
// client + RPC reuse is an untracked follow-up (NOT task 31 — that shipped the SEC-META ownership
// gate); the server validates and infers response types from here today.
//
// Deliberate split of concerns with the ERROR CODES: `mime` and `sizeBytes` upper bound are NOT
// enforced here — a bad mime must be `422 MIME_UNSUPPORTED` and an oversize `413 MEDIA_TOO_LARGE`
// (media codes), not the generic `422 VALIDATION_FAILED` Zod would emit. So `mime` is `z.string()`
// (allowlist checked in the handler) and `sizeBytes` only carries its LOWER bound (≥ 1) here; the
// 10 MiB cap is a handler check. `:index` likewise accepts any integer text so that −1 /
// totalChunks / 2^31 reach the handler's range check as `422 CHUNK_INDEX_INVALID`, not a param
// 422 (api/03-media §3.2; acceptance).
import { zValidator } from '@hono/zod-validator';
import type { Context } from 'hono';
import { z, type ZodType } from 'zod';

import {
  zLocation,
  zMsEpoch,
  zSha256Hex,
  zUuid,
  zUuidV7,
  type ValidationIssue,
} from '@bolusi/schemas';

import type { AppEnv } from '../env.js';
import { respondError } from '../errors.js';

/** 10 MiB cap (api/03-media §3.1) — v0 headroom over the ≤ 300 KiB photo contract. */
export const MEDIA_MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10,485,760

/** Server-dictated chunk size, pinned (api/03-media §4). */
export const MEDIA_CHUNK_SIZE = 262_144; // 256 KiB

/** Media object types (10-db-schema §8 CHECK; api/03-media §3.1). */
export const zMediaType = z.enum(['image', 'signature', 'video']);

/** Init metadata (api/03-media §3.1). Strict: unknown keys reject, keeping the idempotency
 *  comparison total. `userId`/`deviceId` existence is validated against the directory in the
 *  handler (→ 422 VALIDATION_FAILED for unknown), not here. */
export const zMediaInitMetadata = z.strictObject({
  capturedAt: zMsEpoch,
  location: zLocation.nullable(),
  userId: zUuid,
  deviceId: zUuid,
});

/** `POST /v1/media/:id/init` body (api/03-media §3.1). */
export const zMediaInitBody = z.strictObject({
  sizeBytes: z.number().int().min(1),
  sha256: zSha256Hex,
  mime: z.string(), // allowlist enforced in handler → MIME_UNSUPPORTED (not VALIDATION_FAILED)
  type: zMediaType,
  metadata: zMediaInitMetadata,
});
export type MediaInitBody = z.infer<typeof zMediaInitBody>;

/** `:id` path param — media ids are UUIDv7 (api/03-media §3). A traversal/non-UUID `:id`
 *  (`../../etc/passwd`) fails here → 422 VALIDATION_FAILED (SEC-MEDIA-04). */
export const zMediaIdParam = z.strictObject({ id: zUuidV7 });

/** `:id` + `:index` path params. `:index` is any integer text (optionally negative) — the range
 *  check `0 ≤ index < totalChunks` is the handler's, emitting CHUNK_INDEX_INVALID (api/03 §3.2). */
export const zMediaChunkParam = z.strictObject({
  id: zUuidV7,
  index: z
    .string()
    .regex(/^-?\d+$/)
    .transform((s) => Number(s))
    .refine((n) => Number.isSafeInteger(n)),
});

/** `zValidator('param', schema)` wired to the shared 422 VALIDATION_FAILED hook — the param analogue
 *  of task 12's `zJson`. Never bare `zValidator` (its default is a raw-Zod 400). */
export function zMediaParam<T extends ZodType>(schema: T) {
  return zValidator('param', schema, (result, c) => {
    if (result.success) return undefined;
    const issues: ValidationIssue[] = result.error.issues.map((issue) => ({
      path: issue.path.map((seg) => (typeof seg === 'number' ? seg : String(seg))),
      code: issue.code,
      message: issue.message,
    }));
    return respondError(c as unknown as Context<AppEnv>, 'VALIDATION_FAILED', { issues });
  });
}
