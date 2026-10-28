/**
 * Hand a verified photo to the platform to save or send (the repair photo viewer's share button).
 *
 * Only a photo that resolves `ready` through the thumbnail loader is ever shared, so what leaves the
 * app is the same hash-verified file the screen shows (06 §6); a photo still downloading, or one
 * whose bytes did not match, answers `failed` and the viewer says so.
 *
 * The share sheet rather than a gallery save: saving into the phone's gallery needs a photo-library
 * permission (and Play's photo-permission policy review), and would copy customers' phones into a
 * staff member's personal gallery and its cloud backup. The sheet lets the person choose: "Simpan ke
 * Foto" / Files on the phone, or WhatsApp to the customer.
 */
import type { ThumbnailLoader, ThumbnailRef } from '@bolusi/modules/screen-kit';

/** The platform half: the system share sheet on a phone. */
export interface SharePlatform {
  readonly isAvailable: () => Promise<boolean>;
  readonly share: (uri: string, mimeType: string) => Promise<void>;
}

export function createPhotoSharer(
  load: ThumbnailLoader,
  platform: SharePlatform,
): (ref: ThumbnailRef) => Promise<'done' | 'failed'> {
  return async (ref) => {
    const state = await load(ref).catch(() => ({ kind: 'unavailable' }) as const);
    if (state.kind !== 'ready' || !(await platform.isAvailable())) return 'failed';
    await platform.share(state.uri, ref.kind === 'signed' ? ref.mime : 'image/jpeg');
    return 'done';
  };
}
