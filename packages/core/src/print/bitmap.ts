// A 1-bit picture for a dot-matrix printer, made from RGBA pixels the platform decodes (an Electron
// canvas, for instance). The renderer prints it with ESC/P's 8-dot bit-image mode at 120 x 72 dpi,
// so pixels are taken at that resolution here.

export interface MonoBitmap {
  readonly width: number;
  readonly height: number;
  /** Row-major, one entry per dot: 1 = ink. */
  readonly dots: Uint8Array;
}

/** Horizontal and vertical dots per inch of ESC/P `ESC * 1` (double density, 8-dot). */
export const BIT_IMAGE_DPI = { x: 120, y: 72 } as const;

/**
 * Scale RGBA pixels to fit `maxWidthIn` x `maxHeightIn` at the bit-image resolution and threshold
 * them (transparent counts as paper). Nearest-neighbour: logos are flat shapes, and dithering would
 * smear on carbon copies.
 */
export function toMonoBitmap(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  maxWidthIn: number,
  maxHeightIn: number,
): MonoBitmap {
  if (width <= 0 || height <= 0 || rgba.length < width * height * 4) {
    throw new RangeError('toMonoBitmap: pixel data does not match its size');
  }
  // Fit by physical size, then convert inches to dots on each axis.
  const scale = Math.min(maxWidthIn / width, maxHeightIn / height);
  const outWidth = Math.max(1, Math.round(width * scale * BIT_IMAGE_DPI.x));
  const outHeight = Math.max(1, Math.round(height * scale * BIT_IMAGE_DPI.y));
  const dots = new Uint8Array(outWidth * outHeight);
  for (let y = 0; y < outHeight; y += 1) {
    const sy = Math.min(height - 1, Math.floor((y * height) / outHeight));
    for (let x = 0; x < outWidth; x += 1) {
      const sx = Math.min(width - 1, Math.floor((x * width) / outWidth));
      const i = (sy * width + sx) * 4;
      const alpha = (rgba[i + 3] ?? 0) / 255;
      const luma =
        0.299 * (rgba[i] ?? 255) + 0.587 * (rgba[i + 1] ?? 255) + 0.114 * (rgba[i + 2] ?? 255);
      // Blend onto white paper, then threshold at the midpoint.
      dots[y * outWidth + x] = luma * alpha + 255 * (1 - alpha) < 128 ? 1 : 0;
    }
  }
  return { width: outWidth, height: outHeight, dots };
}

/**
 * Dots per QR module in bit-image mode: 4 x 2 dots is 0.85 x 0.71 mm, about square, and large
 * enough to scan off a carbon copy. Scanners correct the small difference like any tilt.
 */
export const QR_MODULE_DOTS = { x: 4, y: 2 } as const;

/** A QR code's modules (true = dark) as dots, each module a block of `QR_MODULE_DOTS`. */
export function qrBitmap(modules: readonly (readonly boolean[])[]): MonoBitmap {
  const size = modules.length;
  const width = size * QR_MODULE_DOTS.x;
  const height = size * QR_MODULE_DOTS.y;
  const dots = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const row = modules[Math.floor(y / QR_MODULE_DOTS.y)] ?? [];
    for (let x = 0; x < width; x += 1) {
      if (row[Math.floor(x / QR_MODULE_DOTS.x)] === true) dots[y * width + x] = 1;
    }
  }
  return { width, height, dots };
}
