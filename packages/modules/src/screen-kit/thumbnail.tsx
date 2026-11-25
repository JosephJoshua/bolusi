// Thumbnails for module screens (06 §6): the ref a renderer resolves, the states it can be in, and
// the hook that loads one. The loader is the platform's media client, bound by apps/mobile.
import { useEffect, useRef, useState } from 'react';

import type { ThumbnailRef } from '@bolusi/schemas';

/** What a renderer hands the media client to resolve one attachment; defined in schemas (06 §6). */
export type { ThumbnailRef };

/** One image attachment, resolved for display (06-media-pipeline §6 `RenderableMedia`, screen view). */
export type ThumbnailState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly uri: string }
  /** api/03 §8: a 404 is expected + transient — the op may precede the media. */
  | { readonly kind: 'unavailable' }
  /** 06 §6: two fetches disagreed with the signed hash — never shown, always a distinct state. */
  | { readonly kind: 'mismatch' };

/** Resolves a ref through the media client; bound once per module runtime by apps/mobile. */
export type ThumbnailLoader = (ref: ThumbnailRef) => Promise<ThumbnailState>;

/**
 * Resolve an attachment to a displayable, hash-verified thumbnail (06 §6 via the media client).
 * `null` ref ⇒ there is no attachment and nothing loads. A resolver throw degrades to
 * `unavailable` (api/03 §8: a missing photo is transient, never an error the whole screen dies on).
 *
 * A throw must NEVER degrade to `ready`, and a `mismatch` must never be softened into `unavailable`:
 * both would render bytes, or the absence of a complaint, where 06 §6 requires a distinct and
 * visible failure.
 */
export function useThumbnailState(load: ThumbnailLoader, ref: ThumbnailRef | null): ThumbnailState {
  const [state, setState] = useState<ThumbnailState>(
    ref === null ? { kind: 'unavailable' } : { kind: 'loading' },
  );

  // The identity the effect depends on. An object literal rebuilt each render would re-run the
  // effect (and re-fetch) on every parent re-render; the fields ARE the identity.
  const refKey =
    ref === null
      ? null
      : ref.kind === 'signed'
        ? `s:${ref.mediaId}:${ref.sha256}`
        : `l:${ref.mediaId}`;
  const refRef = useRef(ref);
  refRef.current = ref;
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    const current = refRef.current;
    if (current === null) {
      setState({ kind: 'unavailable' });
      return;
    }
    let active = true;
    setState({ kind: 'loading' });
    loadRef.current(current).then(
      (resolved) => {
        if (active) setState(resolved);
      },
      () => {
        if (active) setState({ kind: 'unavailable' });
      },
    );
    return () => {
      active = false;
    };
  }, [refKey]);

  return state;
}
