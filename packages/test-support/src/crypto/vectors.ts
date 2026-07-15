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

/** One RFC 8785 Appendix B number sample. */
export interface NumberVector {
  /** Big-endian hex of the IEEE 754 binary64 value. */
  ieee754: string;
  /** Expected JSON text, or `null` when a compliant implementation MUST error. */
  expected: string | null;
  comment: string;
}

export interface CanonicalizationVector {
  name: string;
  input: unknown;
  expected: string;
  expectedUtf8Hex: string;
}

export interface PropertySortingVector {
  input: Record<string, string>;
  expectedValueOrder: string[];
}

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

export const numberVectors: readonly NumberVector[] = vectors.rfc8785.numberSerialization
  .vectors as NumberVector[];

export const canonicalizationVectors: readonly CanonicalizationVector[] = vectors.rfc8785
  .canonicalization as CanonicalizationVector[];

export const propertySortingVector: PropertySortingVector = vectors.rfc8785
  .propertySorting as unknown as PropertySortingVector;

export const sha256Vectors: readonly Sha256Vector[] = vectors.sha256.vectors as Sha256Vector[];

export const ed25519Vectors: readonly Ed25519Vector[] = vectors.ed25519.vectors as Ed25519Vector[];

export const argon2idVectors: readonly Argon2idVector[] = vectors.argon2id
  .vectors as Argon2idVector[];

/** Decode an RFC 8785 Appendix B `ieee754` hex sample into the JS number it denotes. */
export function ieee754HexToNumber(hex: string): number {
  const view = new DataView(new ArrayBuffer(8));
  for (let i = 0; i < 8; i += 1) {
    view.setUint8(i, Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16));
  }
  return view.getFloat64(0, false);
}
