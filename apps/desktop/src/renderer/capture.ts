// Taking photos and signatures on the PC. The window owns the devices (a webcam, a file on disk,
// the signature pad); what it hands the core is the finished JPEG and the pad's strokes, and the
// core runs the phone's own finalisation (hash, seal, queue, signed ref).
//
// A photo is compressed here by the phone's two-pass rule (`compressCapture`, 06 §2.2): only the
// encoder differs, a canvas instead of the phone's image manipulator.
import {
  compressCapture,
  type CompressedImage,
  type ImageCompressorPort,
  type ResizeTarget,
} from '@bolusi/device/media/compression';
import type { PadSize, SignatureStroke } from '@bolusi/device/media/signature-png';
import type { CaptureRequest } from '@bolusi/modules/screen-kit';

/** A picture as the webcam or a file gave it; the runtime compresses it before the core keeps it. */
export interface PcPhoto {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly mime: string;
}

export interface PcSignature {
  readonly strokes: readonly SignatureStroke[];
  readonly pad: PadSize;
}

/** The window's capture devices. Each resolves null when the person backs out. */
export interface PcCapture {
  photo(request?: CaptureRequest): Promise<PcPhoto | null>;
  signature(request?: CaptureRequest): Promise<PcSignature | null>;
}

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob === null ? reject(new Error('the photo did not encode')) : resolve(blob)),
      'image/jpeg',
      quality,
    );
  });
}

/**
 * The canvas encoder. The phone's rule passes pictures around by `uri`; here a uri is only a name for
 * a blob in `blobs`, so nothing is fetched (the page's CSP allows no `blob:` fetches) and nothing
 * outlives the compression.
 */
const canvasCompressor = (blobs: Map<string, Blob>): ImageCompressorPort => ({
  async compress(uri: string, target: ResizeTarget, quality: number): Promise<CompressedImage> {
    const picture = blobs.get(uri);
    if (picture === undefined) throw new Error('unknown picture');
    const source = await createImageBitmap(picture);
    try {
      const scale =
        target === null
          ? 1
          : 'width' in target
            ? target.width / source.width
            : target.height / source.height;
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(source.width * scale));
      canvas.height = Math.max(1, Math.round(source.height * scale));
      const context = canvas.getContext('2d');
      if (context === null) throw new Error('no canvas to encode the photo');
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      const blob = await toBlob(canvas, quality);
      const name = `pass:${blobs.size}`;
      blobs.set(name, blob);
      return { uri: name, width: canvas.width, height: canvas.height, sizeBytes: blob.size };
    } finally {
      source.close();
    }
  },
});

/** The JPEG the core keeps. */
export interface CompressedPhoto {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly mime: 'image/jpeg';
}

/** Compress a picture (a webcam frame, a file) by the phone's rule, to the JPEG the core keeps. */
export async function compressPhoto(photo: PcPhoto): Promise<CompressedPhoto> {
  const picture = new Blob([photo.bytes], { type: photo.mime });
  const blobs = new Map<string, Blob>([['source', picture]]);
  const size = await createImageBitmap(picture);
  const dimensions = { width: size.width, height: size.height };
  size.close();
  const result = await compressCapture(
    { compressor: canvasCompressor(blobs) },
    'source',
    dimensions,
  );
  const compressed = blobs.get(result.uri);
  if (compressed === undefined) throw new Error('the photo did not encode');
  return { bytes: new Uint8Array(await compressed.arrayBuffer()), mime: 'image/jpeg' };
}

/** A picture chosen from this PC's files; null when the picker is closed. */
export function pickPhotoFile(): Promise<PcPhoto | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/jpeg,image/png,image/webp';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file === undefined) resolve(null);
      else
        file
          .arrayBuffer()
          .then((buffer) => resolve({ bytes: new Uint8Array(buffer), mime: file.type }), reject);
    });
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}
