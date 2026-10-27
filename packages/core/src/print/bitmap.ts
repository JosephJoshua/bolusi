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
