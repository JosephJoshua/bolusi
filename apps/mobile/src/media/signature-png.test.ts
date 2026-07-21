// 06-media-pipeline §2.3 — the signature raster and its PNG container.
//
// ── THE ORACLE IS INDEPENDENT WHERE IT MATTERS (T-14: interrogate the oracle) ───────────────────
// A hand-rolled encoder tested by a hand-rolled decoder proves only that two of my mistakes agree.
// So the IDAT is decompressed with NODE'S OWN `zlib.inflateSync`, which independently validates the
// zlib header, the stored-block framing AND the Adler-32 trailer (inflate rejects a bad checksum) —
// and the CRC-32 implementation is anchored to the published RFC vector before being used to check
// any chunk. What is left self-referential is the chunk walk itself, which is 12 lines of length
// arithmetic.
//
// ── THE ASSERTION THAT ACTUALLY GUARDS EVIDENCE ─────────────────────────────────────────────────
// A structurally perfect, correctly sized, entirely BLANK PNG would pass every container check. It
// would also destroy every signature the shop collects, silently, forever. So the load-bearing test
// decodes the pixels and asserts that ink appears where the stroke went and nowhere else — with a
// blank-canvas negative control that must fail it.
import { inflateSync } from 'node:zlib';

import { describe, expect, test } from 'vitest';

import { adler32, crc32 } from './checksums.js';
import {
  SIGNATURE_CANVAS_HEIGHT,
  SIGNATURE_CANVAS_WIDTH,
  encodeSignaturePng,
  hasInk,
  padTransform,
  rasterizeSignature,
  renderSignaturePng,
  type SignatureStroke,
} from './signature-png.js';

interface DecodedPng {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  readonly colorType: number;
  readonly palette: readonly [number, number, number][];
  /** `true` where the pixel is palette index 1 (ink). */
  readonly ink: boolean[][];
  readonly chunkTypes: readonly string[];
}

/** Walk the container, verify every chunk CRC, inflate the IDAT with node's zlib, unpack 1-bit rows. */
function decodePng(bytes: Uint8Array): DecodedPng {
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  const chunkTypes: string[] = [];
  let ihdr: Uint8Array | null = null;
  let plte: Uint8Array | null = null;
  const idat: Uint8Array[] = [];

  while (at < bytes.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const data = bytes.subarray(at + 8, at + 8 + length);
    const declared = view.getUint32(at + 8 + length);
    // Every chunk's CRC is checked — a decoder that skipped this would accept a corrupt file.
    expect(crc32(bytes.subarray(at + 4, at + 8 + length))).toBe(declared);
    chunkTypes.push(type);
    if (type === 'IHDR') ihdr = data;
    if (type === 'PLTE') plte = data;
    if (type === 'IDAT') idat.push(data);
    at += 12 + length;
  }
  if (ihdr === null || plte === null) throw new Error('missing IHDR/PLTE');

  const header = new DataView(ihdr.buffer, ihdr.byteOffset, ihdr.byteLength);
  const width = header.getUint32(0);
  const height = header.getUint32(4);
  const bitDepth = ihdr[8] ?? 0;
  const colorType = ihdr[9] ?? 0;

  const compressed = Buffer.concat(idat.map((part) => Buffer.from(part)));
  // NODE'S zlib. It validates the header check bits and the Adler-32 trailer for us.
  const raw = new Uint8Array(inflateSync(compressed));

  const bytesPerRow = Math.ceil(width / 8);
  const ink: boolean[][] = [];
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + bytesPerRow);
    expect(raw[rowStart]).toBe(0); // filter type None on every scanline
    const row: boolean[] = [];
    for (let x = 0; x < width; x += 1) {
      const byte = raw[rowStart + 1 + (x >> 3)] ?? 0;
      row.push(((byte >> (7 - (x & 7))) & 1) === 1);
    }
    ink.push(row);
  }

  const palette: [number, number, number][] = [];
  for (let index = 0; index + 2 < plte.length; index += 3) {
    palette.push([plte[index] ?? 0, plte[index + 1] ?? 0, plte[index + 2] ?? 0]);
  }

  return { width, height, bitDepth, colorType, palette, ink, chunkTypes };
}

function inkCount(decoded: DecodedPng): number {
  return decoded.ink.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
}

const PAD = { width: 400, height: 200 };
/** A diagonal stroke across the pad — every sample far enough apart to need interpolation. */
const DIAGONAL: SignatureStroke = [
  { x: 20, y: 20 },
  { x: 200, y: 100 },
  { x: 380, y: 180 },
];

describe('the checksums are anchored to their RFC vectors before anything trusts them', () => {
  test('CRC-32("123456789") === 0xCBF43926 (RFC 2083 / the standard vector)', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  test('Adler-32("Wikipedia") === 0x11E60398 (RFC 1950`s worked example)', () => {
    expect(adler32(new TextEncoder().encode('Wikipedia'))).toBe(0x11e60398);
  });
});

describe('the container is a real PNG (06 §2.3)', () => {
  test('magic, chunk order, 1-bit palette geometry, and the pinned 800 x 400 canvas', () => {
    const decoded = decodePng(renderSignaturePng([DIAGONAL], PAD));
    expect(decoded.chunkTypes).toEqual(['IHDR', 'PLTE', 'IDAT', 'IEND']);
    expect(decoded.width).toBe(SIGNATURE_CANVAS_WIDTH);
    expect(decoded.height).toBe(SIGNATURE_CANVAS_HEIGHT);
    expect(decoded.width).toBe(800);
    expect(decoded.height).toBe(400);
    expect(decoded.bitDepth).toBe(1);
    expect(decoded.colorType).toBe(3);
    // §2.3: white background, black stroke — index 0 must be the white one, because an untouched
    // buffer is all zeroes and would otherwise render a solid black rectangle.
    expect(decoded.palette).toEqual([
      [255, 255, 255],
      [0, 0, 0],
    ]);
  });

  test('§2.3`s size budget: comfortably under 64 KiB (a single wire chunk)', () => {
    // A full-pad signature is the worst realistic case for an uncompressed encoding.
    const dense: SignatureStroke[] = [];
    for (let y = 10; y < 190; y += 10) {
      dense.push([
        { x: 10, y },
        { x: 390, y },
      ]);
    }
    const bytes = renderSignaturePng(dense, PAD);
    expect(bytes.byteLength).toBeLessThan(64 * 1024);
  });
});

describe('THE INK IS REAL — the assertion a blank encoder must fail', () => {
  test('a stroke darkens the pixels it passes through, and leaves the rest white', () => {
    const decoded = decodePng(renderSignaturePng([DIAGONAL], PAD));
    const { scale, offsetX, offsetY } = padTransform(PAD);

    // Every sample point, mapped into canvas space, is inked.
    for (const point of DIAGONAL) {
      const x = Math.round(point.x * scale + offsetX);
      const y = Math.round(point.y * scale + offsetY);
      expect(decoded.ink[y]?.[x]).toBe(true);
    }
    // The MIDPOINT between two samples is inked too — that is the interpolation, and without it a
    // fast signature renders as three dots.
    const midX = Math.round(
      (((DIAGONAL[0]?.x ?? 0) + (DIAGONAL[1]?.x ?? 0)) / 2) * scale + offsetX,
    );
    const midY = Math.round(
      (((DIAGONAL[0]?.y ?? 0) + (DIAGONAL[1]?.y ?? 0)) / 2) * scale + offsetY,
    );
    expect(decoded.ink[midY]?.[midX]).toBe(true);

    // A far corner is untouched: the encoder marks the stroke, not the canvas.
    expect(decoded.ink[5]?.[790]).toBe(false);
    // And the ink is a small fraction of the canvas — a solid-black bug would be ~100%.
    const total = SIGNATURE_CANVAS_WIDTH * SIGNATURE_CANVAS_HEIGHT;
    expect(inkCount(decoded)).toBeGreaterThan(1000);
    expect(inkCount(decoded)).toBeLessThan(total / 10);
  });

  test('NEGATIVE CONTROL: an empty canvas encodes with ZERO ink — so the test above is not vacuous', () => {
    const decoded = decodePng(encodeSignaturePng(rasterizeSignature([], PAD)));
    expect(inkCount(decoded)).toBe(0);
    // Structurally valid all the same, which is exactly why the container checks alone prove nothing.
    expect(decoded.chunkTypes).toEqual(['IHDR', 'PLTE', 'IDAT', 'IEND']);
  });

  test('a SINGLE-POINT stroke still marks the canvas (a tittle, a full stop)', () => {
    const decoded = decodePng(renderSignaturePng([[{ x: 100, y: 100 }]], PAD));
    expect(inkCount(decoded)).toBeGreaterThan(0);
  });
});

describe('the pad→canvas transform preserves the mark`s proportions', () => {
  test('a pad wider than 2:1 is fitted by WIDTH and centred vertically', () => {
    const transform = padTransform({ width: 1600, height: 400 });
    expect(transform.scale).toBe(0.5);
    expect(transform.offsetX).toBe(0);
    expect(transform.offsetY).toBe(100);
  });

  test('a tall pad is fitted by HEIGHT and centred horizontally', () => {
    const transform = padTransform({ width: 400, height: 800 });
    expect(transform.scale).toBe(0.5);
    expect(transform.offsetY).toBe(0);
    expect(transform.offsetX).toBe(300);
  });

  test('a degenerate (unmeasured) pad yields scale 1 rather than Infinity/NaN', () => {
    // A layout reports 0 x 0 before it has measured. `1600 / 0` would put every coordinate at
    // Infinity and rasterise nothing at all — a signature that silently comes out blank.
    expect(padTransform({ width: 0, height: 0 })).toEqual({ scale: 1, offsetX: 0, offsetY: 0 });
  });

  test('the same mark on two differently-shaped pads produces the same proportions', () => {
    // What a human compares against a specimen is the SHAPE. The SAME RELATIVE mark — half the
    // diagonal — drawn on two pads of the same aspect but different pixel sizes must land on the
    // canvas identically, because that is the situation a phone and a tablet actually create.
    const small = decodePng(
      renderSignaturePng(
        [
          [
            { x: 10, y: 5 },
            { x: 100, y: 50 },
          ],
        ],
        { width: 200, height: 100 },
      ),
    );
    const large = decodePng(
      renderSignaturePng(
        [
          [
            { x: 20, y: 10 },
            { x: 200, y: 100 },
          ],
        ],
        { width: 400, height: 200 },
      ),
    );
    // Within a pixel of rounding on each end of the nib, not exact — the interpolation steps are
    // computed in canvas space and a half-pixel of scale difference is real, not a bug.
    expect(Math.abs(inkCount(small) - inkCount(large))).toBeLessThan(inkCount(large) * 0.02);
  });
});

describe('hasInk — the predicate the pad and `captureSignature` both gate on', () => {
  test('an empty stroke list, and a list of empty strokes, are both inkless', () => {
    expect(hasInk([])).toBe(false);
    expect(hasInk([[], []])).toBe(false);
  });

  test('one point is ink', () => {
    expect(hasInk([[{ x: 1, y: 1 }]])).toBe(true);
  });
});
