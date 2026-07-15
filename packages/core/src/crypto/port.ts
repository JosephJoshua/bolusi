// CryptoPort — the single crypto seam of @bolusi/core (08-stack-and-repo §3.2).
//
// core is PLATFORM-FREE: it never imports a crypto provider. Implementations are
// injected — `@bolusi/test-support` binds noble (Node/CI/harness), `apps/mobile`
// binds react-native-quick-crypto (the sole on-device provider, D8), `apps/server`
// binds its own thin noble adapter over the same pins (08 §3.3).
//
// Sync vs async: SHA-256 / Ed25519 are synchronous because quick-crypto's OpenSSL
// path is sub-millisecond (08 §2.2). `kdf` is the deliberate exception — argon2id at
// D8 params targets ~300 ms, which must never block the JS thread; a synchronous
// provider simply resolves immediately.

/** An Ed25519 keypair. `secretKey` is the RFC 8032 32-byte seed, never the expanded key. */
export interface Ed25519KeyPair {
  /** 32-byte RFC 8032 seed (what RFC 8032 §7.1 prints as "SECRET KEY"). */
  secretKey: Uint8Array;
  /** 32-byte compressed Edwards point. */
  publicKey: Uint8Array;
}

/**
 * argon2id cost parameters.
 *
 * Names mirror react-native-quick-crypto / Node's experimental argon2 surface
 * (08 §2.2) so the device adapter is a rename-free pass-through; the noble adapter
 * maps them onto noble's `m`/`t`/`p`/`dkLen`.
 */
export interface KdfParams {
  /** Memory cost in KiB (argon2 `m`). */
  memoryCost: number;
  /** Iterations (argon2 `t`). */
  timeCost: number;
  /** Lanes (argon2 `p`). */
  parallelism: number;
  /** Derived-key length in bytes (argon2 `T`). */
  outputLength: number;
  /** Optional secret ("pepper") mixed into initialization — RFC 9106 `K`. */
  secret?: Uint8Array;
  /** Optional associated data — RFC 9106 `X`. */
  associatedData?: Uint8Array;
}

/**
 * D8 default PIN-KDF parameters (decisions/2026-07-14-v0-stack-pins.md; 08 §2.6).
 *
 * The documented fallback floor (m=19456 / t=2 / p=1) applies ONLY if the on-device
 * benchmark on the 2 GB target exceeds 300 ms — api/02-auth owns that decision record.
 * Enforcing a parameter floor is task 14 (SEC-AUTH-01); this constant is the default,
 * not a gate.
 */
export const DEFAULT_KDF_PARAMS: Readonly<KdfParams> = Object.freeze({
  memoryCost: 32768,
  timeCost: 3,
  parallelism: 1,
  outputLength: 32,
});

/** The crypto capabilities core needs, and nothing more. */
export interface CryptoPort {
  /** SHA-256 digest — returns the raw 32 bytes, never hex. */
  sha256(data: Uint8Array): Uint8Array;

  /** Derive a keypair. With a 32-byte seed the result is deterministic (RFC 8032). */
  ed25519Keygen(seed?: Uint8Array): Ed25519KeyPair;

  /** Public key for a 32-byte secret seed. */
  ed25519GetPublicKey(secretKey: Uint8Array): Uint8Array;

  /**
   * Ed25519 signature over `message` — the RAW bytes handed in, never a hex or
   * base64 rendering of them (05 §2.2: the signature covers the raw 32-byte hash).
   */
  sign(message: Uint8Array, secretKey: Uint8Array): Uint8Array;

  /** Verify an Ed25519 signature. MUST return false — never throw — on bad input. */
  verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean;

  /** argon2id key derivation (D8). */
  kdf(password: Uint8Array, salt: Uint8Array, params: KdfParams): Promise<Uint8Array>;

  /** Cryptographically secure random bytes. Also the entropy source for UUIDv7 (task 06). */
  randomBytes(length: number): Uint8Array;
}
