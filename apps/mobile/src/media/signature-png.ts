// The signature raster + PNG encoder — 06-media-pipeline §2.3.
//
// ── WHY A HAND-ROLLED ENCODER, WHICH IS NORMALLY THE WRONG ANSWER ───────────────────────────────
// §2.3 pins PNG ("line art — JPEG ringing artifacts corrupt strokes"), a canvas of max 800 x 400,
// white background, black stroke, expected under 64 KiB. Nothing in the pinned stack can produce
// one: 08 §2.2's dependency table has no canvas, no SVG rasteriser, no `react-native-view-shot`,
// and `expo-image-manipulator` transforms an EXISTING image rather than drawing one. Adding a
// dependency is a change to 08 §2.2 — a spec change, which is its own task (CLAUDE.md §4), not an
// implementation side effect. So the file format is the dependency, and PNG is small enough to
// meet honestly.
//
// The encoding is 1-bit PALETTE (colour type 3, bit depth 1) with a two-entry palette. That is not
// cleverness for its own sake — it is what makes the "no compressor" decision viable. A signature
// is two colours by definition (§2.3: white background, black stroke), so one bit per pixel is
// lossless here, and 800 x 400 becomes 400 rows x (1 filter byte + 100 data bytes) = 40,400 bytes
// BEFORE any compression. Emitting that through zlib's STORED (uncompressed) block type — legal
// DEFLATE, understood by every decoder, five bytes of header per 64 KiB block — lands ~40 KiB,
// inside §2.3's "< 64 KiB (single wire chunk)" budget with room to spare. An RGB PNG would have
// needed a real compressor to get anywhere near it.
//
// ── WHAT THE TEST LANE CAN ACTUALLY PROVE ABOUT THIS ────────────────────────────────────────────
// Everything except how it looks. The output is bytes, produced by pure functions, so the suite
// decodes what this file emits and asserts the PNG magic, the IHDR geometry, the CRC of every
// chunk, the zlib adler32, and — the one that matters — that a stroke actually darkens the pixels
// it passes through while the background stays white. That last assertion is the guard against the
// failure this repo keeps shipping: an encoder that returns a valid, correctly-sized, entirely
// BLANK PNG would satisfy every structural check and destroy every signature the shop collects.
import { crc32, adler32 } from './checksums.js';

/** §2.3: "Canvas | max 800 x 400 px". The maximum, and therefore the raster we emit. */
export const SIGNATURE_CANVAS_WIDTH = 800;
export const SIGNATURE_CANVAS_HEIGHT = 400;

/**
 * Stroke half-width in canvas pixels. A 1 px line at 800 px wide is a hairline that a 2 GB device's
 * low-DPI LCD renders as dust and a JPEG-free PNG faithfully preserves as dust; 2 gives a ~5 px nib
 * that reads as a pen at both the pad's on-screen size and full canvas resolution.
 */
export const SIGNATURE_STROKE_RADIUS = 2;

export interface SignaturePoint {
  readonly x: number;
  readonly y: number;
}

/** One continuous pen-down..pen-up path, in the PAD's coordinate space (not the canvas's). */
export type SignatureStroke = readonly SignaturePoint[];

export interface PadSize {
  readonly width: number;
  readonly height: number;
}

/** A 1-bit-per-pixel bitmap: `true` = ink (palette index 1), `false` = paper (index 0). */
export interface SignatureBitmap {
  readonly width: number;
  readonly height: number;
  readonly ink: Uint8Array;
}

/** True iff any stroke contains at least one point — the pad's "has the user signed?" predicate. */
export function hasInk(strokes: readonly SignatureStroke[]): boolean {
  return strokes.some((stroke) => stroke.length > 0);
}

/**
 * The pad→canvas transform: fit `pad` inside the 800 x 400 canvas preserving aspect ratio, centred.
 *
 * Preserving the ratio is not cosmetic. A signature stretched to fill a differently-shaped canvas
 * is a DIFFERENT signature — the thing a human compares against a specimen is its proportions — and
 * pads on a 360 dp phone and a tablet have different shapes. Scaling by the smaller factor and
 * centring means every device produces the same mark.
 *
 * A degenerate pad (zero width or height, which is what a layout reports before it has measured)
 * yields scale 1 and no offset rather than `Infinity`/`NaN` coordinates. `??`-style defaulting is
 * banned here (T-19) but this is a real branch on a real value, not a laundered failed read.
 */
export function padTransform(pad: PadSize): {
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
} {
  if (pad.width <= 0 || pad.height <= 0) return { scale: 1, offsetX: 0, offsetY: 0 };
  const scale = Math.min(SIGNATURE_CANVAS_WIDTH / pad.width, SIGNATURE_CANVAS_HEIGHT / pad.height);
  return {
    scale,
    offsetX: (SIGNATURE_CANVAS_WIDTH - pad.width * scale) / 2,
    offsetY: (SIGNATURE_CANVAS_HEIGHT - pad.height * scale) / 2,
  };
}

/** Fill the disc of `SIGNATURE_STROKE_RADIUS` centred on (cx, cy), clipped to the canvas. */
function stamp(bitmap: SignatureBitmap, cx: number, cy: number): void {
  const r = SIGNATURE_STROKE_RADIUS;
  const x0 = Math.max(0, Math.round(cx) - r);
  const x1 = Math.min(bitmap.width - 1, Math.round(cx) + r);
  const y0 = Math.max(0, Math.round(cy) - r);
  const y1 = Math.min(bitmap.height - 1, Math.round(cy) + r);
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r * r + r) bitmap.ink[y * bitmap.width + x] = 1;
    }
  }
}

/**
 * Rasterise pad-space strokes onto the 800 x 400 canvas.
 *
 * Consecutive points are joined by interpolation rather than left as dots: a finger moving quickly
 * across a 60 Hz touch surface emits points tens of pixels apart, and a pad that drew only the
 * samples would render a fast signature as a dotted line. The step is one canvas pixel, so the
 * joined path is continuous at any speed.
 *
 * A SINGLE-POINT stroke still marks the canvas (a deliberate dot — the tittle on a "j", a full
 * stop). Dropping it would silently erase part of some people's names.
 */
export function rasterizeSignature(
  strokes: readonly SignatureStroke[],
  pad: PadSize,
): SignatureBitmap {
  const bitmap: SignatureBitmap = {
    width: SIGNATURE_CANVAS_WIDTH,
    height: SIGNATURE_CANVAS_HEIGHT,
    ink: new Uint8Array(SIGNATURE_CANVAS_WIDTH * SIGNATURE_CANVAS_HEIGHT),
  };
  const { scale, offsetX, offsetY } = padTransform(pad);
  const toCanvas = (point: SignaturePoint): SignaturePoint => ({
    x: point.x * scale + offsetX,
    y: point.y * scale + offsetY,
  });

  for (const stroke of strokes) {
    if (stroke.length === 0) continue;
    const first = stroke[0];
    if (first === undefined) continue;
    let previous = toCanvas(first);
    stamp(bitmap, previous.x, previous.y);
    for (let index = 1; index < stroke.length; index += 1) {
      const raw = stroke[index];
      if (raw === undefined) continue;
      const next = toCanvas(raw);
      const steps = Math.max(1, Math.ceil(Math.hypot(next.x - previous.x, next.y - previous.y)));
      for (let step = 1; step <= steps; step += 1) {
        const t = step / steps;
        stamp(
          bitmap,
          previous.x + (next.x - previous.x) * t,
          previous.y + (next.y - previous.y) * t,
        );
      }
      previous = next;
    }
  }
  return bitmap;
}

// ── PNG container ───────────────────────────────────────────────────────────────────────────────

const PNG_MAGIC = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** DEFLATE stored blocks cap at 65,535 bytes of literal data (RFC 1951 §3.2.4). */
const STORED_BLOCK_MAX = 0xffff;

function be32(value: number): Uint8Array {
  return Uint8Array.from([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** One PNG chunk: length, type, data, CRC-32 over (type ++ data) — RFC 2083 §3.2. */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Uint8Array.from([...type].map((c) => c.charCodeAt(0)));
  const body = concat([typeBytes, data]);
  return concat([be32(data.length), body, be32(crc32(body))]);
}

/**
 * A zlib stream (RFC 1950) carrying `raw` in STORED deflate blocks.
 *
 * `0x78 0x01` is CMF/FLG for deflate, 32 KiB window, no preset dictionary — and `(0x78 << 8 | 0x01)
 * % 31 === 0`, which is the header check every decoder verifies. The stored-block header byte is
 * `BFINAL | (BTYPE=00 << 1)`, followed by LEN and its ones-complement NLEN, both little-endian.
 * The trailing adler32 is over the UNCOMPRESSED bytes.
 */
function zlibStored(raw: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [Uint8Array.from([0x78, 0x01])];
  if (raw.length === 0) {
    parts.push(Uint8Array.from([0x01, 0x00, 0x00, 0xff, 0xff]));
  }
  for (let at = 0; at < raw.length; at += STORED_BLOCK_MAX) {
    const length = Math.min(STORED_BLOCK_MAX, raw.length - at);
    const isFinal = at + length >= raw.length;
    parts.push(
      Uint8Array.from([
        isFinal ? 0x01 : 0x00,
        length & 0xff,
        (length >>> 8) & 0xff,
        ~length & 0xff,
        (~length >>> 8) & 0xff,
      ]),
      raw.subarray(at, at + length),
    );
  }
  parts.push(be32(adler32(raw)));
  return concat(parts);
}

/**
 * Encode a 1-bit palette PNG: index 0 = white paper, index 1 = black ink (§2.3).
 *
 * Filter type 0 (None) on every scanline. The adaptive filters exist to help a compressor find
 * patterns, and there is no compressor here — a Paeth pass would cost CPU on a 2 GB device and one
 * extra byte per row of nothing.
 */
export function encodeSignaturePng(bitmap: SignatureBitmap): Uint8Array {
  const bytesPerRow = Math.ceil(bitmap.width / 8);
  const raw = new Uint8Array(bitmap.height * (1 + bytesPerRow));
  for (let y = 0; y < bitmap.height; y += 1) {
    const rowStart = y * (1 + bytesPerRow);
    // raw[rowStart] is the filter byte and stays 0 (None).
    for (let x = 0; x < bitmap.width; x += 1) {
      if (bitmap.ink[y * bitmap.width + x] === 1) {
        // Bit 7 is the LEFTMOST pixel of each byte (RFC 2083 §2.3 packing order).
        const at = rowStart + 1 + (x >> 3);
        raw[at] = (raw[at] ?? 0) | (0x80 >> (x & 7));
      }
    }
  }

  const ihdr = concat([
    be32(bitmap.width),
    be32(bitmap.height),
    // bit depth 1, colour type 3 (palette), compression 0, filter 0, interlace 0
    Uint8Array.from([1, 3, 0, 0, 0]),
  ]);
  // White paper first so index 0 — the value an untouched buffer already holds — IS the background.
  const plte = Uint8Array.from([0xff, 0xff, 0xff, 0x00, 0x00, 0x00]);

  return concat([
    PNG_MAGIC,
    chunk('IHDR', ihdr),
    chunk('PLTE', plte),
    chunk('IDAT', zlibStored(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/** The whole of §2.3's raster half: pad-space strokes in, PNG bytes out. */
export function renderSignaturePng(strokes: readonly SignatureStroke[], pad: PadSize): Uint8Array {
  return encodeSignaturePng(rasterizeSignature(strokes, pad));
}
