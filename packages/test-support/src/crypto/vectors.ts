// Typed view over the shared golden vector file (testing-guide §2.2).
//
// One fixture set feeds every runtime: the Node JCS suite (CI stage 5), the Hermes
// runner (stage 6), the noble interop suite (stage 7) and quick-crypto on device
// (stage 12). Keeping the data in ONE json file is what makes "byte-identical across
// implementations" a checkable claim rather than four drifting copies.
//
// The JSON import is deliberate: `esbuild` inlines it for the Hermes bundle (no `fs` on
// Hermes) and vitest/tsc resolve it natively on Node.
import vectors from '../../vectors/ed25519.json' with { type: 'json' };

// The RFC 8785 (JCS) view lives in `../vectors/jcs.ts` so the on-device harness can reach it via
// `@bolusi/test-support/device` (which forbids any `crypto/` file — device-bundle-safe.test.ts). It is
// re-exported here UNCHANGED so every existing Node importer keeps `@bolusi/test-support`'s surface —
// one fixture set, not a second copy (T-5).
export {
  numberVectors,
  canonicalizationVectors,
  propertySortingVector,
  ieee754HexToNumber,
  type NumberVector,
  type CanonicalizationVector,
  type PropertySortingVector,
} from '../vectors/jcs.js';

export interface Sha256Vector {
  name: string;
  messageUtf8: string;
  digestHex: string;
}

export interface Ed25519Vector {
  name: string;
  /** 32-byte RFC 8032 seed (the RFC's "SECRET KEY"), hex. */
  seedHex: string;
  publicKeyHex: string;
  /** Hex of the message bytes; `''` means the empty message. */
  messageHex: string;
  signatureHex: string;
}

export interface Argon2idVector {
  name: string;
  version: number;
  passwordHex: string;
  saltHex: string;
  secretHex: string;
  associatedDataHex: string;
  memoryCost: number;
  timeCost: number;
  parallelism: number;
  outputLength: number;
  tagHex: string;
}

export const sha256Vectors: readonly Sha256Vector[] = vectors.sha256.vectors as Sha256Vector[];

export const ed25519Vectors: readonly Ed25519Vector[] = vectors.ed25519.vectors as Ed25519Vector[];

export const argon2idVectors: readonly Argon2idVector[] = vectors.argon2id
  .vectors as Argon2idVector[];
