// Sync push/pull DTOs (api/01-sync §3–4.1). Direction split per api/00 §2.1/§4:
// request schemas are strict (unknown keys → 422); response schemas are tolerant
// (unknown keys stripped — clients ignore fields newer than this build).
import { z } from 'zod';

import { zSignedOperation } from './envelope.js';
import { zBase64, zMsEpoch, zUuid, zUuidV7 } from './primitives.js';

/** Batch cap (api/01 §3): ≤ 500 ops (and ≤ 1 MiB gzipped, enforced at transport). */
export const MAX_PUSH_OPS = 500;

/** Pull page cap and per-endpoint default (api/01 §4; api/00 §10). */
export const MAX_PULL_LIMIT = 500;

/**
 * POST /v1/sync/push body (api/01 §3). Ops ascend by per-device seq — ordering
 * and chain continuity are validated server-side (05 §8–9), not by this schema.
 */
export const zPushRequest = z.strictObject({
  deviceId: zUuid,
  ops: z.array(zSignedOperation).max(MAX_PUSH_OPS),
});
export type PushRequest = z.infer<typeof zPushRequest>;

export const PUSH_RESULT_STATUSES = ['accepted', 'duplicate', 'rejected'] as const;
export const zPushResultStatus = z.enum(PUSH_RESULT_STATUSES);
export type PushResultStatus = z.infer<typeof zPushResultStatus>;

/**
 * Per-op push result (api/01 §3). `code` stays an open string: the client marks
 * and surfaces codes newer than this build (api/00 §4); the known set is
 * REJECTION_CODES (./rejection-codes.ts).
 */
export const zPushResult = z.object({
  id: zUuidV7,
  status: zPushResultStatus,
  serverSeq: z.number().int().min(1).optional(),
  code: z.string().optional(),
  reason: z.string().optional(),
});
export type PushResult = z.infer<typeof zPushResult>;

export const zPushResponse = z.object({
  results: z.array(zPushResult),
  serverTime: zMsEpoch,
});
export type PushResponse = z.infer<typeof zPushResponse>;

/**
 * POST /v1/sync/pull body (api/01 §4). `cursor` 0 = never synced;
 * `devicesDirectoryVersion` 0 = no directory held. `limit` defaults to the
 * endpoint default when absent (api/00 §10).
 */
/** Bounds for read sets on the wire: far above the read permissions any build declares. */
export const MAX_READ_SET = 256;
const MAX_READ_PERMISSION_LENGTH = 128;

export const zPullRequest = z.strictObject({
  cursor: z.number().int().min(0),
  limit: z.number().int().min(1).max(MAX_PULL_LIMIT).default(MAX_PULL_LIMIT),
  devicesDirectoryVersion: z.number().int().min(0),
  /**
   * A catch-up pull (permission-scoped sync): only the ops read with these permissions, from
   * `cursor` up to `through`. A device asks for it when its read set grew, for the older ops it was
   * not sent before. The server still limits it to the device's current read set.
   */
  backfill: z
    .strictObject({
      reads: z.array(z.string().min(1).max(MAX_READ_PERMISSION_LENGTH)).min(1).max(MAX_READ_SET),
      through: z.number().int().min(0),
    })
    .optional(),
  /**
   * A person pull (least-privilege sync): what the person signed in may read beyond what this
   * device holds, for their session only. Sent with the `X-Person-Session` token the server issued
   * after checking their PIN; the response's `readSet` is that extra, never the device's own.
   */
  person: z.literal(true).optional(),
});
export type PullRequest = z.infer<typeof zPullRequest>;

/** Header carrying a person session token (`bps_…`) on a person pull. */
export const PERSON_SESSION_HEADER = 'X-Person-Session';

/** `POST /v1/sync/person-session`: the person's PIN, checked by the server itself. */
export const zPersonSessionRequest = z.strictObject({
  userId: z.string().uuid(),
  pin: z.string().regex(/^[0-9]{6}$/),
});
export type PersonSessionRequest = z.infer<typeof zPersonSessionRequest>;

export const zPersonSessionResponse = z.object({
  token: z.string().min(1),
  expiresAt: z.number().int(),
  /** What the person may read here beyond the device; empty means nothing to fetch. */
  readSet: z.array(z.string().min(1).max(MAX_READ_PERMISSION_LENGTH)).max(MAX_READ_SET),
});
export type PersonSessionResponse = z.infer<typeof zPersonSessionResponse>;

export const DEVICE_KINDS = ['member', 'system'] as const;
export const zDeviceKind = z.enum(DEVICE_KINDS);
export type DeviceKind = z.infer<typeof zDeviceKind>;

/** Device.status machine values (03-state-machines §5): terminal `revoked`, no un-revoke. */
export const DEVICE_STATUSES = ['active', 'revoked'] as const;
export const zDeviceStatus = z.enum(DEVICE_STATUSES);
export type DeviceStatus = z.infer<typeof zDeviceStatus>;

/**
 * Devices sidecar row (api/01 §4.1) — full snapshot of the device's pull scope.
 * Revoked devices remain listed (their historical signatures must stay
 * verifiable); `revokedAt` is nullable-present. `storeId` is null for
 * tenant-scoped (system) devices.
 */
export const zDeviceInfo = z.object({
  id: zUuid,
  storeId: zUuid.nullable(),
  kind: zDeviceKind,
  signingKeyPublic: zBase64,
  status: zDeviceStatus,
  revokedAt: zMsEpoch.nullable(),
});
export type DeviceInfo = z.infer<typeof zDeviceInfo>;

/**
 * Pull response (api/01 §4). Tolerant at the top level, but `ops` items stay
 * STRICT zSignedOperation — the quarantine path verifies pulled cores exactly
 * (api/01 §4.2); stripping unknown core keys would silently break verification.
 */
export const zPullResponse = z.object({
  ops: z.array(zSignedOperation),
  nextCursor: z.number().int().min(0),
  hasMore: z.boolean(),
  serverTime: zMsEpoch,
  devices: z.array(zDeviceInfo).optional(),
  devicesDirectoryVersion: z.number().int().min(0).optional(),
  /**
   * The read permissions this page was filtered by, sorted (permission-scoped sync). The device
   * compares it with the set it holds: it drops ops it may no longer read and catches up on ops it
   * newly may. Absent from a server that does not scope pulls.
   */
  readSet: z.array(z.string().min(1).max(MAX_READ_PERMISSION_LENGTH)).max(MAX_READ_SET).optional(),
});
export type PullResponse = z.infer<typeof zPullResponse>;
