// 06-media-pipeline §2.2 steps 3–4: the pinned two-pass rule.
//
// THE LOAD-BEARING TEST IS "COMPRESSION IS REAL". A compressor that returned its input unchanged
// satisfies `ImageCompressorPort` perfectly, compiles, lints, and would ship a 9 MB JPEG per photo
// to a shop on a 3 G uplink — the exact well-typed no-op class §2.11 keeps catching. So the suite
// asserts a MEASURED shrink and MEASURED dimensions, and carries a pass-through as an explicit
// negative control that must fail those same assertions.
import { describe, expect, test } from 'vitest';

import { FakeFs, ShrinkingCompressor, bytesOfLength } from './_harness.test.js';
import {
  CAPTURE_QUALITY,
  PASS_1_COMPRESS,
  PASS_1_MAX_LONG_EDGE,
  PASS_2_COMPRESS,
  PASS_2_MAX_LONG_EDGE,
  SIZE_BUDGET_BYTES,
  compressCapture,
  resizeTargetFor,
  type CompressedImage,
  type ImageCompressorPort,
} from './compression.js';

describe('the pinned parameters are 06 §2.2`s, verbatim', () => {
  test('every number matches the spec table', () => {
    // Pinned here so a "tuning" edit to the constants is a red test rather than a silent change to
    // what evidence looks like. 06 §2.2 owns these; this is the mirror that fails when they drift.
    expect(CAPTURE_QUALITY).toBe(0.7);
    expect(PASS_1_MAX_LONG_EDGE).toBe(1600);
    expect(PASS_1_COMPRESS).toBe(0.7);
    expect(SIZE_BUDGET_BYTES).toBe(307_200);
    expect(PASS_2_MAX_LONG_EDGE).toBe(1280);
    expect(PASS_2_COMPRESS).toBe(0.5);
  });
});

describe('resizeTargetFor — downscale ONLY, one edge, ratio preserved by the encoder', () => {
  test('a landscape source pins the WIDTH', () => {
    expect(resizeTargetFor({ width: 4000, height: 3000 }, 1600)).toEqual({ width: 1600 });
  });

  test('a portrait source pins the HEIGHT — the long edge is what the cap is about', () => {
    expect(resizeTargetFor({ width: 3000, height: 4000 }, 1600)).toEqual({ height: 1600 });
  });

  test('an image already inside the cap is NOT resized (never upscale)', () => {
    // A `{ width: 1600 }` here would re-sample a 900 px photo UP: a bigger file, no more detail,
    // more memory to decode — on the device class this whole pipeline exists to protect.
    expect(resizeTargetFor({ width: 1200, height: 900 }, 1600)).toBeNull();
    expect(resizeTargetFor({ width: 1600, height: 1200 }, 1600)).toBeNull();
  });
});

describe('the two passes (06 §2.2 steps 3–4)', () => {
  function rig(source: { width: number; height: number }, bytesPerPixel: number) {
    const fs = new FakeFs();
    fs.write('/cache/shot.jpg', bytesOfLength(9_000_000));
    const compressor = new ShrinkingCompressor(source, fs, bytesPerPixel);
    return { fs, compressor, deps: { compressor, sizeOf: fs.port.sizeOf } };
  }

  test('a pass-1 output inside the budget STOPS — no second pass', async () => {
    // 0.1 B/px puts 1600x1200 at ~134 KiB, comfortably inside 300 KiB.
    const { compressor, deps } = rig({ width: 4000, height: 3000 }, 0.1);
    const result = await compressCapture(deps, '/cache/shot.jpg', { width: 4000, height: 3000 });

    expect(result.passes).toBe(1);
    expect(compressor.calls).toHaveLength(1);
    expect(result.sizeBytes).toBeLessThanOrEqual(SIZE_BUDGET_BYTES);
    expect(Math.max(result.width, result.height)).toBeLessThanOrEqual(PASS_1_MAX_LONG_EDGE);
  });

  test('a pass-1 output OVER the budget triggers pass 2, from the ORIGINAL source', async () => {
    const { compressor, deps } = rig({ width: 4000, height: 3000 }, 0.5);
    const result = await compressCapture(deps, '/cache/shot.jpg', { width: 4000, height: 3000 });

    expect(result.passes).toBe(2);
    expect(compressor.calls).toHaveLength(2);
    expect(compressor.calls[0]).toMatchObject({ target: { width: 1600 }, compress: 0.7 });
    expect(compressor.calls[1]).toMatchObject({ target: { width: 1280 }, compress: 0.5 });
    // Both passes read the camera original — never pass 1's already-lossy output.
    expect(compressor.calls[1]?.uri).toBe('/cache/shot.jpg');
    expect(Math.max(result.width, result.height)).toBeLessThanOrEqual(PASS_2_MAX_LONG_EDGE);
  });

  test('pass 2 is accepted UNCONDITIONALLY — capture never fails on size (§2.2 step 4)', async () => {
    // 4 B/px keeps even 1280x960 far over budget. The spec is explicit: accept it anyway. Losing a
    // repair's only photo over a transfer-cost heuristic is the worse failure, and the wire chunks.
    const { compressor, deps } = rig({ width: 4000, height: 3000 }, 4);
    const result = await compressCapture(deps, '/cache/shot.jpg', { width: 4000, height: 3000 });

    expect(result.passes).toBe(2);
    expect(result.sizeBytes).toBeGreaterThan(SIZE_BUDGET_BYTES);
    // And there is NO third pass.
    expect(compressor.calls).toHaveLength(2);
  });

  test('the reported size is MEASURED on the encoded file, not derived from dimensions', async () => {
    const { fs, deps } = rig({ width: 4000, height: 3000 }, 0.1);
    const result = await compressCapture(deps, '/cache/shot.jpg', { width: 4000, height: 3000 });
    expect(result.sizeBytes).toBe(fs.read(result.uri).byteLength);
  });

  test('NEGATIVE CONTROL: a pass-through compressor FAILS the shrink assertions', async () => {
    // The whole point. This double satisfies `ImageCompressorPort` and returns the input untouched —
    // which is what a broken `expoImageCompressor` (a dropped `saveAsync`, a `compress` that never
    // reached the native call) would look like from here. If the assertions above could pass against
    // it, they would prove nothing about compression at all.
    const fs = new FakeFs();
    fs.write('/cache/shot.jpg', bytesOfLength(9_000_000));
    const passthrough: ImageCompressorPort = {
      // Ignores the resize target and the quality entirely — which is exactly the point.
      compress: (uri): Promise<CompressedImage> =>
        Promise.resolve({ uri, width: 4000, height: 3000 }),
    };

    const result = await compressCapture(
      { compressor: passthrough, sizeOf: fs.port.sizeOf },
      '/cache/shot.jpg',
      { width: 4000, height: 3000 },
    );

    // It still runs both passes (the size never drops), and every §2.2 guarantee is violated:
    expect(result.passes).toBe(2);
    expect(result.sizeBytes).toBe(9_000_000);
    expect(result.sizeBytes).toBeGreaterThan(SIZE_BUDGET_BYTES);
    expect(Math.max(result.width, result.height)).toBeGreaterThan(PASS_2_MAX_LONG_EDGE);
  });
});
