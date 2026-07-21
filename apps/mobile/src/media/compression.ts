// The pinned compress/downscale passes — 06-media-pipeline §2.2 steps 3–4.
//
// THE NUMBERS ARE THE SPEC'S, NOT MINE. 1600 px / q0.7, then 1280 px / q0.5 iff the pass-1 output
// exceeds 300 KiB. 06 §2.2 argues them (cracked-glass detail and serial numbers must stay legible;
// 8–12 MB camera output is wildly beyond every use case on a 3G uplink), and this file restates the
// values only because code has to hold them somewhere. Changing one is a change to 06 first.
//
// ── WHY THE DECISION IS SPLIT FROM THE EFFECT ───────────────────────────────────────────────────
// `resizeTargetFor` and `compressCapture` are platform-free and take the manipulator as a PORT, so
// the whole of §2.2's two-pass rule — including "downscale only, never upscale" and "accept the
// pass-2 result unconditionally" — is decided under Node with no native module. That matters more
// here than usual: this repo's recurring failure is the well-typed no-op (§2.11), and a compressor
// that returned its input unchanged would satisfy `ImageCompressorPort` perfectly. The suite next
// to this file drives a compressor whose recorded output actually shrinks, and asserts the SHRINK —
// a pass-through fails it. What no lane here can prove is that expo-image-manipulator's NATIVE
// encoder hits those bytes on a real 12 MP JPEG: there is no device (D12/D13), on either platform.
//
// ── THE SDK 57 API, VERIFIED AGAINST THE INSTALLED TYPES ────────────────────────────────────────
// `manipulateAsync` is marked `@deprecated` in expo-image-manipulator 57.0.2
// (build/ImageManipulator.d.ts:16 — "replaced by the new, contextual and object-oriented API"), so
// the adapter uses the contextual API instead: `ImageManipulator.manipulate(uri)` →
// `ImageManipulatorContext` (chainable, synchronous scheduling) → `renderAsync()` → `ImageRef` →
// `saveAsync({ compress, format })` → `ImageResult { uri, width, height }`. Read from
// `build/ImageManipulator.types.d.ts` and `build/ImageRef.d.ts` in this workspace, not from memory.
//
// `resize` takes `{ width?, height? | null }` and — per its own doc comment — "if you specify only
// one value, the other will be calculated automatically to preserve image ratio". That is why the
// target below is a ONE-KEY object: computing the second edge ourselves would round differently
// from the native encoder and make the assertion "long edge <= cap" depend on our arithmetic
// instead of the library's.
//
// THE BINDING ITSELF IS IN `native.ts`, and it has to be. `expo-image-manipulator` imports
// `expo-modules-core`, which reads the Metro global `__DEV__` AT MODULE SCOPE — so a single value
// import from this file would drag `ReferenceError: __DEV__ is not defined` into every Node test
// that touches compression, including the end-to-end one. Keeping this module import-free is what
// lets `client.test.ts` import `SIZE_BUDGET_BYTES` and assert §2.2 step 4's threshold against the
// same constant the code branches on, instead of a copy.

/** 06 §2.2 step 1: `takePictureAsync` quality. MUST be explicit — the SDK 57 default is `1`. */
export const CAPTURE_QUALITY = 0.7;

/** 06 §2.2 step 3 — pass 1: long edge <= 1600 px, JPEG `compress: 0.7`. */
export const PASS_1_MAX_LONG_EDGE = 1600;
export const PASS_1_COMPRESS = 0.7;

/** 06 §2.2 step 4's threshold: 300 KiB, spelled in bytes exactly as the spec spells it. */
export const SIZE_BUDGET_BYTES = 307_200;

/** 06 §2.2 step 4 — pass 2: long edge <= 1280 px, `compress: 0.5`, accepted unconditionally. */
export const PASS_2_MAX_LONG_EDGE = 1280;
export const PASS_2_COMPRESS = 0.5;

export interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

/**
 * A `resize` argument with exactly ONE edge set, or `null` for "do not resize".
 *
 * One edge, because the manipulator derives the other to preserve ratio (see the header). `null`
 * rather than a no-op resize, because 06 §2.2 step 3 says "downscale only, never upscale": a photo
 * already under the cap must not be re-sampled UP to it, which is what `resize({width: 1600})` on a
 * 900 px image would do — a bigger file with no more detail, on the device least able to afford it.
 */
export type ResizeTarget = { readonly width: number } | { readonly height: number } | null;

/**
 * The downscale-only long-edge fit.
 *
 * Returns `null` when the image already fits. Ties (a square image) resolve to `width`, which is
 * arbitrary and harmless — both edges are the long edge.
 */
export function resizeTargetFor(dimensions: ImageDimensions, maxLongEdge: number): ResizeTarget {
  const longEdge = Math.max(dimensions.width, dimensions.height);
  if (longEdge <= maxLongEdge) return null;
  return dimensions.width >= dimensions.height ? { width: maxLongEdge } : { height: maxLongEdge };
}

export interface CompressedImage {
  /** Cache-directory URI of the encoded file. NOT yet the evidence path — 06 §2.2 step 5 moves it. */
  readonly uri: string;
  readonly width: number;
  readonly height: number;
}

/** The image encoder seam (08 §3.2). The expo-image-manipulator binding lives in `native.ts`. */
export interface ImageCompressorPort {
  /**
   * Re-encode `uri` as JPEG at `compress`, optionally resized to `target` first.
   *
   * Resolves with the NEW file's uri and its ACTUAL encoded dimensions — read back from the
   * encoder, never echoed from the request. A caller asserting "long edge <= 1600" must be
   * asserting a measurement.
   */
  compress(uri: string, target: ResizeTarget, compress: number): Promise<CompressedImage>;
}

/** The outcome of §2.2 steps 3–4, with the pass count so a caller can assert which rule fired. */
export interface CompressionResult {
  readonly uri: string;
  readonly width: number;
  readonly height: number;
  /** Measured on the encoded file, not predicted. */
  readonly sizeBytes: number;
  /** 1 or 2 — §2.2 step 4 allows no third pass ("Capture never fails on size"). */
  readonly passes: 1 | 2;
}

export interface CompressionDeps {
  readonly compressor: ImageCompressorPort;
  /** `MediaFilePort.sizeOf` — rejects on a missing file rather than reporting 0 (T-19). */
  readonly sizeOf: (path: string) => Promise<number>;
}

/**
 * 06 §2.2 steps 3–4, in order.
 *
 * PASS 2 RE-ENCODES THE ORIGINAL, not pass 1's output. §2.2 step 4 says only "pass 2 — long edge
 * <= 1280 px, `compress: 0.5`", leaving the source unstated; running it from the camera original
 * costs one extra decode and avoids stacking two lossy JPEG generations on evidence whose whole job
 * is to keep a serial number readable. The alternative (recompressing pass 1) would apply q0.7 then
 * q0.5 to the same pixels — visibly worse for identical bytes.
 *
 * THE SIZE IS MEASURED, NOT ESTIMATED: `sizeOf` stats the encoded file. An implementation that
 * guessed from dimensions would decide §2.2 step 4's branch on a number no user ever gets.
 */
export async function compressCapture(
  deps: CompressionDeps,
  sourceUri: string,
  dimensions: ImageDimensions,
): Promise<CompressionResult> {
  const first = await deps.compressor.compress(
    sourceUri,
    resizeTargetFor(dimensions, PASS_1_MAX_LONG_EDGE),
    PASS_1_COMPRESS,
  );
  const firstBytes = await deps.sizeOf(first.uri);
  if (firstBytes <= SIZE_BUDGET_BYTES) {
    return {
      uri: first.uri,
      width: first.width,
      height: first.height,
      sizeBytes: firstBytes,
      passes: 1,
    };
  }

  const second = await deps.compressor.compress(
    sourceUri,
    resizeTargetFor(dimensions, PASS_2_MAX_LONG_EDGE),
    PASS_2_COMPRESS,
  );
  // "accept the pass-2 result unconditionally. Capture never fails on size." (§2.2 step 4). A photo
  // that stays over budget still becomes evidence — refusing it would lose the repair record over a
  // transfer-cost heuristic, and the wire chunks anyway (api/03 §4).
  const secondBytes = await deps.sizeOf(second.uri);
  return {
    uri: second.uri,
    width: second.width,
    height: second.height,
    sizeBytes: secondBytes,
    passes: 2,
  };
}
