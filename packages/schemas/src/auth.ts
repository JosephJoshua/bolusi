// Request/response DTOs for the identity control plane (api/02-auth §4–§5, §7).
//
// THE SINGLE SOURCE (api/00 §14; CLAUDE.md §2.8). api/00 §14 says request/response Zod schemas "live
// in the shared schemas package (@bolusi/schemas)". Task 13 built these in `apps/server` as a stopgap
// because this package had no auth DTOs and was off-limits to it; task 14 (the client) then mirrored
// the same bounds by hand and carried structural `CanonicalRef` / `PinVerifier` stopgaps in
// `@bolusi/core` (verifier.ts) flagged "delete in favour of @bolusi/schemas when task 33 lands". Task
// 33 lands them here — one shape the server validates with and the client can pre-send-validate
// against, instead of two encodings that drift.
//
// PLATFORM-FREE (08 §3.3): this file imports only `zod`. The PIN-verifier byte-length checks compute
// the decoded length ARITHMETICALLY (b64ByteLength below) rather than via Node's `Buffer`, which does
// not exist on Hermes/RN — the server's stopgap used `Buffer.from(s,'base64').length`, but for the
// accept case (a well-formed padded base64 string, RFC 4648 §4, which `bytesToBase64` and every client
// produce) the arithmetic is byte-identical, and both reject everything else.
import { z } from 'zod';

/** Lowercase canonical UUID that ALSO accepts the nil UUID (control-plane CanonicalRef, api/02-auth §5.2). */
const zUuidOrNil = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

/** Lowercase canonical UUID (rejects the nil UUID — a real entity id). */
const zId = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f][0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  .refine((v) => v !== '00000000-0000-0000-0000-000000000000', 'must not be the nil UUID');

/**
 * Decoded byte length of a standard padded base64 string (RFC 4648 §4), platform-free — no `Buffer`,
 * no `atob` (08 §3.3). Exact for well-formed padded base64 (length a multiple of 4); a malformed
 * string yields a non-integer or wrong count and so never equals a required length, matching the
 * accept/reject decision of the server stopgap's `Buffer.from(s,'base64').length`.
 */
function b64ByteLength(s: string): number {
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  return (s.length / 4) * 3 - pad;
}

/** A point in canonical order (05 §4); nil-device + seq 0 for control-plane writes (api/02-auth §5.2). */
export const CanonicalRefSchema = z
  .object({
    timestamp: z.number().int(),
    deviceId: zUuidOrNil,
    seq: z.number().int().min(0),
  })
  .strict();
export type CanonicalRef = z.infer<typeof CanonicalRefSchema>;

/**
 * A PIN verifier as it enters the server (api/02-auth §5.3). Bounds are Zod-enforced everywhere a
 * verifier enters the system — this is the DoS guard (SEC-AUTH-01's server leg): a hostile verifier
 * declaring `mKiB = 1048576` must never reach a verifying device, and cannot, because verifiers
 * enter only through these server-validated doors.
 */
export const PinVerifierSchema = z
  .object({
    algorithm: z.literal('argon2id'),
    saltB64: z
      .string()
      .refine((s) => b64ByteLength(s) === 16, 'salt must decode to exactly 16 bytes'),
    mKiB: z.number().int().min(19456).max(65536),
    t: z.number().int().min(2).max(4),
    p: z.literal(1),
    hashB64: z
      .string()
      .refine((s) => b64ByteLength(s) === 32, 'hash must decode to exactly 32 bytes'),
    asOf: CanonicalRefSchema,
  })
  .strict();
export type PinVerifier = z.infer<typeof PinVerifierSchema>;

// ============ POST /v1/auth/login (§4.2) ============
export const LoginReq = z
  .object({
    loginIdentifier: z.string().min(1).max(64),
    password: z.string().min(10).max(128),
  })
  .strict();
export type LoginReq = z.infer<typeof LoginReq>;

export interface LoginRes {
  controlSession: string;
  expiresAt: number;
  tenantId: string;
  /** The tenant's display name — the enrollment CONFIRM step renders it (api/02-auth §4.2). */
  tenantName: string;
  user: { id: string; name: string };
  stores: Array<{ id: string; name: string }>;
}

// ============ POST /v1/auth/password (§5.4) ============
export const PasswordChangeReq = z
  .object({
    currentPassword: z.string().min(1).max(128),
    newPassword: z.string().min(10).max(128),
  })
  .strict();
export type PasswordChangeReq = z.infer<typeof PasswordChangeReq>;

// ============ POST /v1/devices/enroll (§4.3) ============
export const EnrollReq = z
  .object({
    deviceId: zId,
    devicePublicKeyB64: z
      .string()
      .refine((s) => b64ByteLength(s) === 32, 'public key must decode to exactly 32 bytes'),
    storeId: zId,
    deviceName: z.string().min(1).max(64),
    platform: z.enum(['android', 'ios']),
    appVersion: z.string().max(32),
  })
  .strict();
export type EnrollReq = z.infer<typeof EnrollReq>;

// ============ device bundle (§5.2) ============
export interface TenantSettings {
  idleLockSeconds: number;
}

export interface BundleUser {
  id: string;
  name: string;
  photoMediaId: string | null;
  status: 'active' | 'deactivated';
  grants: Array<{ roleId: string; storeId: string | null }>;
  pinVerifier: PinVerifier | null;
}

export interface DeviceBundle {
  tenant: { id: string; name: string };
  store: { id: string; name: string };
  settings: TenantSettings;
  users: BundleUser[];
  rolesSnapshot: Array<{
    id: string;
    name: string;
    scopeType: 'tenant' | 'store';
    isSystemDefault: boolean;
    permissionIds: string[];
  }>;
  permissionsSnapshot: Array<{
    id: string;
    module: string;
    action: string;
    scope: 'tenant' | 'store';
    isDangerous: boolean;
    description: string;
  }>;
}

export interface EnrollRes {
  deviceId: string;
  deviceToken: string;
  tenant: { id: string; name: string };
  store: { id: string; name: string };
  settings: TenantSettings;
  bundle: DeviceBundle;
  bundleEtag: string;
  serverTime: number;
}

// ============ users (§5.4) ============
export const CreateUserReq = z
  .object({
    name: z.string().min(1).max(64),
    loginIdentifier: z.string().min(1).max(64).nullable(),
    password: z.string().min(10).max(128).nullable(),
    storeIds: z.array(zId).min(1),
    roleIds: z.array(zId).min(1),
    pinVerifier: PinVerifierSchema.nullable(),
  })
  .strict()
  // password requires loginIdentifier (api/02-auth §5.4).
  .refine((v) => v.password === null || v.loginIdentifier !== null, {
    message: 'password requires a loginIdentifier',
    path: ['password'],
  });
export type CreateUserReq = z.infer<typeof CreateUserReq>;

export const UpdateUserReq = z
  .object({
    name: z.string().min(1).max(64).optional(),
    storeIds: z.array(zId).min(1).optional(),
    photoMediaId: zId.nullable().optional(),
  })
  .strict();
export type UpdateUserReq = z.infer<typeof UpdateUserReq>;

export const PutPinVerifierReq = z
  .object({
    verifierRef: zId,
    verifier: PinVerifierSchema,
  })
  .strict();
export type PutPinVerifierReq = z.infer<typeof PutPinVerifierReq>;

// ============ PATCH /v1/tenant/settings (§6.4) ============
export const TenantSettingsReq = z
  .object({
    idleLockSeconds: z.number().int(),
  })
  .strict();
export type TenantSettingsReq = z.infer<typeof TenantSettingsReq>;

export const IDLE_LOCK_MIN = 60;
export const IDLE_LOCK_MAX = 3600;
export const IDLE_LOCK_DEFAULT = 300;

/** Clamp idleLockSeconds to [60, 3600] (api/02-auth §6.4). */
export function clampIdleLock(seconds: number): number {
  return Math.max(IDLE_LOCK_MIN, Math.min(IDLE_LOCK_MAX, Math.trunc(seconds)));
}
