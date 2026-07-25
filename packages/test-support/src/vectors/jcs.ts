// Device-safe view over the shared RFC 8785 (JCS) golden vectors — the SEC-OPLOG-06 fixture set.
//
// ── WHY THIS FILE EXISTS, SEPARATE FROM crypto/vectors.ts ───────────────────────────────────────
// The on-device harness (apps/mobile, task 178's SEC-OPLOG-06-jcs runner) must replay the SAME golden
// vectors the Node suite uses (T-5: one fixture, not a second drifting copy), and it can only reach
// them through `@bolusi/test-support/device`. That subpath forbids reaching ANY file under `crypto/`
// (device-bundle-safe.test.ts walks its import graph and reds on a `crypto/` hit, because the barrel's
// crypto pieces drag `node:crypto`). So the JCS view lives HERE, outside `crypto/`, importing ONLY the
// shared JSON — no `node:*`, no crypto — and `crypto/vectors.ts` re-exports from this file so every
// existing Node importer (the stage-5 RFC-8785 suite, the Hermes stage-6 runner) is unchanged.
//
// The JSON import is deliberate: `esbuild` inlines it for the Hermes bundle and Metro bundles it for
// the device APK; vitest/tsc resolve it natively on Node. It carries no code, only data.
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

export const numberVectors: readonly NumberVector[] = vectors.rfc8785.numberSerialization
  .vectors as NumberVector[];

export const canonicalizationVectors: readonly CanonicalizationVector[] = vectors.rfc8785
  .canonicalization as CanonicalizationVector[];

export const propertySortingVector: PropertySortingVector = vectors.rfc8785
  .propertySorting as unknown as PropertySortingVector;

/** Decode an RFC 8785 Appendix B `ieee754` hex sample into the JS number it denotes. */
export function ieee754HexToNumber(hex: string): number {
  const view = new DataView(new ArrayBuffer(8));
  for (let i = 0; i < 8; i += 1) {
    view.setUint8(i, Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16));
  }
  return view.getFloat64(0, false);
}
