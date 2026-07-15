// Shared primitive guards (05-operation-log §2.1–2.2, §3; api/00-conventions §2.1).
import { z } from 'zod';

/** UUID string (any RFC 9562 version) — tenant/store/user/device ids (05 §2.1). */
export const zUuid = z.uuid();

/** UUIDv7 string — client-generated op and entity ids (05 §2.1). */
export const zUuidV7 = z.uuidv7();

/** 64-char lowercase hex — SHA-256 `hash` / `previousHash` links (05 §2.1–2.2). */
export const zSha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

/** base64 string — Ed25519 signatures and public keys (05 §2.2, api/01 §4.1). */
export const zBase64 = z.base64();

/** Integer ms-epoch timestamp — never ISO strings, never seconds (api/00 §2.1). */
export const zMsEpoch = z.number().int();

/** Money is ALWAYS integer IDR — floats never (05 §3; 08 §3.2: z.number().int() always). */
export const zMoneyIdr = z.number().int();

/**
 * Canonical decimal string (05 §3): optional sign, no leading zeros, optional
 * fraction. No exponents, no bare points — the JCS hash preimage must be stable.
 */
export const zDecimalString = z.string().regex(/^-?(0|[1-9]\d*)(\.\d+)?$/);

/** Payload numbers: integers or decimal strings — float literals never (05 §3). */
export const zPayloadNumber = z.union([z.number().int(), zDecimalString]);
