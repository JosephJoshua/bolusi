// The phone handoff relay (counter PC ↔ store phone through the server). A PC without a webcam or
// touch screen pairs a store phone once by QR; the server serves the phone a small page, holds the
// step the PC is asking for, and passes back what the phone sends. Defined once here for the
// server's validators and the PC's client.
import { z } from 'zod';

import { VIDEO_MAX_SIZE_BYTES, type VideoMime } from './media.js';

export const HANDOFF_KINDS = ['photo', 'signature', 'video'] as const;
export const zHandoffKind = z.enum(HANDOFF_KINDS);
export type HandoffKind = z.infer<typeof zHandoffKind>;

/** The signature pad's drawing space, the same as the phone app's (strokes are in these units). */
export const HANDOFF_PAD = { width: 800, height: 400 } as const;
/** Limits the phone page keeps to and the server enforces. */
export const HANDOFF_LIMITS = {
  photoBytes: 4 * 1024 * 1024,
  signatureBytes: 1024 * 1024,
  videoBytes: VIDEO_MAX_SIZE_BYTES,
  /** The longest clip a step may ask for. */
  videoMs: 5 * 60 * 1000,
  strokes: 500,
  points: 20_000,
  labelChars: 300,
} as const;

const zLabel = z.string().max(HANDOFF_LIMITS.labelChars);

/** The phone page's copy, in the PC person's language; the server only renders it. */
export const zHandoffPageLabels = z
  .object({
    photoHint: zLabel,
    signatureHint: zLabel,
    take: zLabel,
    retake: zLabel,
    clear: zLabel,
    send: zLabel,
    sending: zLabel,
    sent: zLabel,
    waiting: zLabel,
    rotate: zLabel,
    rotateNow: zLabel,
    failed: zLabel,
    withdrawn: zLabel,
    expired: zLabel,
    unreadable: zLabel,
    videoStart: zLabel,
    videoStop: zLabel,
    videoRetake: zLabel,
    videoDenied: zLabel,
    videoFailed: zLabel,
    retry: zLabel,
    videoUnsupported: zLabel,
    videoTooLarge: zLabel,
  })
  .strict();
export type HandoffPageLabels = z.infer<typeof zHandoffPageLabels>;

/** `POST /v1/handoff`: a new pairing for this PC; any earlier one ends. */
export const zHandoffPairBody = z.object({ labels: zHandoffPageLabels }).strict();
export interface HandoffPairResponse {
  readonly id: string;
  /** The phone page, relative to the API's origin: `/h/<key>`. */
  readonly path: string;
}

/** `POST /v1/handoff/:id/ask`: put one photo, signature or clip in front of the phone. */
export const zHandoffAskBody = z
  .object({
    kind: zHandoffKind,
    title: zLabel,
    /** What the clip must show, under the title. */
    hint: zLabel.optional(),
    /** A clip's limit; the page stops recording there. */
    maxMs: z.number().int().positive().max(HANDOFF_LIMITS.videoMs).optional(),
  })
  .strict()
  .refine((ask) => ask.kind !== 'video' || ask.maxMs !== undefined, {
    message: 'a video step needs maxMs',
    path: ['maxMs'],
  });
export type HandoffAsk = z.infer<typeof zHandoffAskBody>;
export interface HandoffAskResponse {
  readonly seq: number;
}

/** `POST /v1/handoff/:id/withdraw`: the PC backed out of that step. */
export const zHandoffWithdrawBody = z.object({ seq: z.number().int().positive() }).strict();

export interface HandoffPoint {
  readonly x: number;
  readonly y: number;
}

/** What reaches the PC, in order; `n` lets it ask only for what it has not seen. */
export type HandoffWireEvent =
  | { readonly n: number; readonly type: 'paired' }
  | { readonly n: number; readonly type: 'photo'; readonly seq: number; readonly jpeg: string }
  | {
      readonly n: number;
      readonly type: 'signature';
      readonly seq: number;
      readonly strokes: readonly (readonly HandoffPoint[])[];
    }
  /** A clip is too big to ride in the events; the PC fetches it from `GET /v1/handoff/:id/clip/:seq`. */
  | {
      readonly n: number;
      readonly type: 'video';
      readonly seq: number;
      readonly mime: VideoMime;
      readonly sizeBytes: number;
    };

/** `GET /v1/handoff/:id/events?after=n`: held open until there is something new, or a while. */
export interface HandoffEventsResponse {
  readonly events: readonly HandoffWireEvent[];
  /** The pairing is over (expired, replaced or ended); the PC needs a new code. */
  readonly ended: boolean;
}
