// Evidence capture for module screens (06 §2). The platform owns the camera and the signature pad;
// a screen asks for one and gets back the signed `mediaRef` its command will carry, or `null` when
// the user backed out. A failure rejects; `null` is only ever a cancel.
import type { MediaRef } from '@bolusi/schemas';

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
