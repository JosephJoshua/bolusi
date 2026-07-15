// Server-side crypto (08-stack §3.3: apps/server binds its own thin noble adapter over the same
// pins — @noble is a direct dependency here, not injected, because the server is not a
// platform-free package). This surface owns exactly what the identity control plane needs:
//
//   - token / session / verifier HASHING at rest (SHA-256, api/02-auth §8) — node:crypto;
//   - CSPRNG token + one-time-password generation (api/02-auth §2, §4.3, §8) — node:crypto;
//   - the server-side PASSWORD verifier (argon2id; the rare, rate-limited login path, api/02-auth
//     §2/§5.3). PIN verifiers are computed ON THE DEVICE (D8) — the server only stores them; it
//     never runs the PIN KDF.
//
// Constant-time comparison (`timingSafeEqual`) is used for every secret compare (SEC-AUTH-09
// spirit; the server leg).
import { argon2idAsync } from '@noble/hashes/argon2.js';
import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto';

/** SHA-256 of a string, lowercase hex. The at-rest form of every bearer token (api/02-auth §8). */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** `<prefix>` + base64url(32 CSPRNG bytes) — the `bdt_`/`bcs_` token format (api/02-auth §4.3, §8). */
export function mintToken(prefix: 'bdt_' | 'bcs_'): string {
  return `${prefix}${nodeRandomBytes(32).toString('base64url')}`;
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * A CSPRNG base58 string of `length` chars (api/02-auth §2: the 24-char one-time owner password).
 * Rejection-sampled so the alphabet is uniform (no modulo bias).
 */
export function randomBase58(length: number): string {
  let out = '';
  while (out.length < length) {
    for (const byte of nodeRandomBytes(length * 2)) {
      if (byte < 232) {
        // 232 = 58 * 4 — the largest multiple of 58 ≤ 256; bytes ≥ 232 are rejected (unbiased).
        out += BASE58[byte % 58];
        if (out.length === length) break;
      }
    }
  }
  return out;
}

// ============ password verifier (argon2id, server-side only) ============

/**
 * Server password-KDF profile — the api/02-auth §5.3 default parameter profile (the doc says the
 * server uses "the same parameter profile as §5.3"). Self-describing: the params travel in the
 * verifier record so verification never guesses (api/02-auth §5.3).
 */
export const PASSWORD_KDF = { mKiB: 32768, t: 3, p: 1, outputLen: 32 } as const;

/** A stored password verifier — self-describing argon2id record (mirrors the PIN verifier shape). */
export interface PasswordVerifier {
  readonly algorithm: 'argon2id';
  readonly saltB64: string; // 16 CSPRNG bytes
  readonly mKiB: number;
  readonly t: number;
  readonly p: number;
  readonly hashB64: string; // 32 bytes
}

async function argon2(
  password: string,
  salt: Uint8Array,
  mKiB: number,
  t: number,
  p: number,
): Promise<Uint8Array> {
  return argon2idAsync(new TextEncoder().encode(password), salt, {
    m: mKiB,
    t,
    p,
    dkLen: PASSWORD_KDF.outputLen,
  });
}

/** Compute a fresh password verifier (new random salt every time — no reuse). */
export async function createPasswordVerifier(password: string): Promise<string> {
  const salt = nodeRandomBytes(16);
  const hash = await argon2(password, salt, PASSWORD_KDF.mKiB, PASSWORD_KDF.t, PASSWORD_KDF.p);
  const verifier: PasswordVerifier = {
    algorithm: 'argon2id',
    saltB64: Buffer.from(salt).toString('base64'),
    mKiB: PASSWORD_KDF.mKiB,
    t: PASSWORD_KDF.t,
    p: PASSWORD_KDF.p,
    hashB64: Buffer.from(hash).toString('base64'),
  };
  return JSON.stringify(verifier);
}

/** Parse a stored verifier, tolerating malformed JSON (returns null → treated as no credential). */
function parseVerifier(verifierJson: string): PasswordVerifier | null {
  try {
    const v = JSON.parse(verifierJson) as PasswordVerifier;
    if (
      v.algorithm !== 'argon2id' ||
      typeof v.saltB64 !== 'string' ||
      typeof v.hashB64 !== 'string'
    ) {
      return null;
    }
    return v;
  } catch {
    return null;
  }
}

/** Constant-time verify a password against a stored verifier JSON (api/02-auth §4.2). */
export async function verifyPassword(password: string, verifierJson: string): Promise<boolean> {
  const v = parseVerifier(verifierJson);
  if (v === null) return false;
  const salt = Buffer.from(v.saltB64, 'base64');
  const expected = Buffer.from(v.hashB64, 'base64');
  const actual = Buffer.from(await argon2(password, salt, v.mKiB, v.t, v.p));
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

// A fixed dummy verifier: real argon2id params, an unknowable hash. Login runs THIS for an
// unknown identifier so "no such user" and "wrong password" take statistically identical time —
// no enumeration oracle (api/02-auth §4.2).
const DUMMY_SALT = Buffer.alloc(16, 7);

/** Run the password KDF and discard the result — the anti-enumeration dummy path (api/02-auth §4.2). */
export async function runDummyPasswordKdf(password: string): Promise<void> {
  await argon2(password, DUMMY_SALT, PASSWORD_KDF.mKiB, PASSWORD_KDF.t, PASSWORD_KDF.p);
}

/**
 * The password-KDF seam. Injected via ServerDeps so login is (a) testable — a spy proves the
 * dummy KDF runs for an unknown identifier (no enumeration oracle) — and (b) fast in the suite
 * (the real argon2id at 32 MiB is deliberately slow). Production and the CLI use `noblePasswordKdf`.
 */
export interface PasswordKdf {
  createVerifier(password: string): Promise<string>;
  verify(password: string, verifierJson: string): Promise<boolean>;
  runDummy(password: string): Promise<void>;
}

export const noblePasswordKdf: PasswordKdf = {
  createVerifier: createPasswordVerifier,
  verify: verifyPassword,
  runDummy: runDummyPasswordKdf,
};
