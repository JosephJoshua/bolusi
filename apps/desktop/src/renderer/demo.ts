// Demo data for the desktop build, which runs the counter screens over the in-memory repair demo
// before the offline core is wired in. Names here are seeded data, not interface copy.
import { demoRepairRuntime, type DemoRepairRole } from '@bolusi/modules/repair/demo';
import type { RepairRuntime } from '@bolusi/modules/repair/desktop';

import type { CapturedMedia } from '@bolusi/modules/screen-kit';
import { SIGNATURE_PX, type DrawnSignature } from '@bolusi/ui-web';

import { compressPhoto, type PcCapture } from './capture.js';
import { desktopPrinting } from './print.js';

export const DEMO_STORE_NAME = 'Toko Sorong Kota';

export interface DemoPerson {
  readonly role: DemoRepairRole;
  readonly userId: string;
  readonly name: string;
  /** The role catalog key (`role.<key>.name`) the person holds. */
  readonly roleKey: string;
}

export const DEMO_PEOPLE: readonly DemoPerson[] = [
  { role: 'counter', userId: 'u-siti', name: 'Siti Rahayu', roleKey: 'cashier' },
  { role: 'owner', userId: 'u-andi', name: 'Andi Pratama', roleKey: 'main_owner' },
  { role: 'storeOwner', userId: 'u-yosua', name: 'Yosua Wonda', roleKey: 'store_owner' },
  { role: 'technician', userId: 'u-budi', name: 'Budi Santoso', roleKey: 'technician' },
];

// Captures live only in this window's memory: the demo has no media store. The real build hands
// them to the offline core instead.
const captured = new Map<string, string>();
/** Recorded clips, kept as blobs: each playing gets its own url, which the player lets go. */
const clips = new Map<string, Blob>();

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function demoRef<M extends string, T extends string>(
  bytes: Uint8Array<ArrayBuffer>,
  mime: M,
  type: T,
) {
  return {
    mediaId: crypto.randomUUID(),
    sha256: await sha256Hex(bytes),
    mime,
    type,
    sizeBytes: bytes.length,
    capturedAt: Date.now(),
    location: null,
    userId: 'u-siti',
    deviceId: 'd-demo',
  };
}

async function keepDemo(
  bytes: Uint8Array<ArrayBuffer>,
  mime: 'image/jpeg' | 'image/png',
  type: 'image' | 'signature',
): Promise<CapturedMedia> {
  const mediaRef = await demoRef(bytes, mime, type);
  captured.set(mediaRef.mediaId, URL.createObjectURL(new Blob([bytes], { type: mime })));
  return { mediaRef };
}

/** The strokes drawn on a white pad, as a PNG; the real build renders them with the phone's code. */
async function signaturePng({ strokes, pad }: DrawnSignature): Promise<Uint8Array<ArrayBuffer>> {
  const canvas = document.createElement('canvas');
  canvas.width = SIGNATURE_PX.width;
  canvas.height = SIGNATURE_PX.height;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('no canvas');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.scale(canvas.width / pad.width, canvas.height / pad.height);
  context.lineWidth = 4;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  for (const stroke of strokes) {
    context.beginPath();
    for (const [index, { x, y }] of stroke.entries()) {
      if (index === 0) context.moveTo(x, y);
      context.lineTo(x, y);
    }
    context.stroke();
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (blob === null) throw new Error('signature did not render');
  return new Uint8Array(await blob.arrayBuffer());
}

/** A fresh store's worth of servisan for this person; switching people starts over. */
export function demoRuntimeFor(person: DemoPerson, capture: PcCapture): RepairRuntime {
  const runtime = demoRepairRuntime(person.role, { now: Date.now(), volume: 'store' });
  return {
    ...runtime,
    capturePhoto: async (request) => {
      const photo = await capture.photo(request);
      if (photo === null) return null;
      const jpeg = await compressPhoto(photo);
      return keepDemo(jpeg.bytes, jpeg.mime, 'image');
    },
    captureSignature: async (request) => {
      const signature = await capture.signature(request);
      return signature === null
        ? null
        : keepDemo(await signaturePng(signature), 'image/png', 'signature');
    },
    recordVideo: async (request) => {
      const video = await capture.video(request);
      if (video === null) return null;
      const videoRef = await demoRef(video.bytes, video.mime, 'video' as const);
      clips.set(videoRef.mediaId, new Blob([video.bytes], { type: video.mime }));
      return { videoRef };
    },
    // A clip recorded here plays; the seeded ones have none to show.
    playVideo: (ref, request) =>
      capture.play(request, () => {
        const clip = clips.get(ref.mediaId);
        return Promise.resolve(
          clip === undefined
            ? { kind: 'unavailable' }
            : { kind: 'ready', url: URL.createObjectURL(clip) },
        );
      }),
    // A photo taken here shows itself; the seeded ones show the demo's placeholders.
    loadThumbnail: (ref) => {
      const url = captured.get(ref.mediaId);
      return url === undefined
        ? runtime.loadThumbnail(ref)
        : Promise.resolve({ kind: 'ready', uri: url });
    },
    printing:
      runtime.printing === undefined
        ? undefined
        : desktopPrinting(runtime.printing, DEMO_STORE_NAME),
  };
}
