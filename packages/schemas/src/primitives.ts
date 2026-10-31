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

/**
 * Whether a string holds text Postgres cannot store: U+0000, or a UTF-16 surrogate without its
 * pair (text cut mid-emoji). Code units are scanned directly; `isWellFormed` is not on every
 * engine the phone runs.
 */
function isUnstorableString(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit === 0) return true;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : -1;
      if (next < 0xdc00 || next > 0xdfff) return true;
      i++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/**
 * Whether any string in a JSON value, object keys included, holds U+0000 or an unpaired surrogate.
 * Postgres refuses both in `text` and `jsonb`, so an op carrying one can never be stored: the device
 * refuses it before signing, and the server refuses it per op instead of failing the whole batch.
 */
export function containsUnstorableText(value: unknown): boolean {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const next = pending.pop();
    if (typeof next === 'string') {
      if (isUnstorableString(next)) return true;
    } else if (typeof next === 'object' && next !== null) {
      for (const [key, child] of Object.entries(next)) {
        if (isUnstorableString(key)) return true;
        pending.push(child);
      }
    }
  }
  return false;
}
