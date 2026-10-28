// Evidence capture for module screens (06 §2). The platform owns the camera and the signature pad;
// a screen asks for one and gets back the signed `mediaRef` its command will carry, or `null` when
// the user backed out. A failure rejects; `null` is only ever a cancel.
import type { MediaRef, VideoMime, VideoRef } from '@bolusi/schemas';

/**
 * What a capture hands back: the whole `mediaRef`, not just the id. The op's signed payload is the
 * only tamper-evident place the hash can live (05 §2), so every other device verifies against it.
 */
export interface CapturedMedia {
  readonly mediaRef: MediaRef;
}

/** Already-localized copy for the capture screen, so the user knows which shot is being asked for. */
export interface CaptureRequest {
  readonly title: string;
}

/** Open the in-app camera (06 §2.1). */
export type PhotoCapture = (request?: CaptureRequest) => Promise<CapturedMedia | null>;

/** Open the in-app signature pad (06 §2.3). */
export type SignatureCapture = (request: CaptureRequest) => Promise<CapturedMedia | null>;

/** A recorded clip: its signed ref, like a photo's. */
export interface CapturedVideo {
  readonly videoRef: VideoRef;
}

/** Open the in-app video recorder, for at most `maxMs`. `null` is only ever a cancel. */
export type VideoCapture = (
  request: CaptureRequest & {
    readonly maxMs: number;
    /** Already-localized: what the clip must show, read out before recording. */
    readonly hint: string;
  },
) => Promise<CapturedVideo | null>;

/** A stored clip as the platform resolves it: its hash rode in the signed op (06 §6). */
export interface VideoMediaRef {
  readonly mediaId: string;
  readonly sha256: string;
  readonly mime: VideoMime;
}

/**
 * Play a stored clip full screen; resolves when the viewer closes it. The platform shows its own
 * loading, not-here-yet and failed states.
 */
export type VideoPlayback = (ref: VideoMediaRef, request: CaptureRequest) => Promise<void>;
