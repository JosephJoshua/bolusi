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
export const zPullRequest = z.strictObject({
  cursor: z.number().int().min(0),
  limit: z.number().int().min(1).max(MAX_PULL_LIMIT).default(MAX_PULL_LIMIT),
  devicesDirectoryVersion: z.number().int().min(0),
});
export type PullRequest = z.infer<typeof zPullRequest>;

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
});
export type PullResponse = z.infer<typeof zPullResponse>;
