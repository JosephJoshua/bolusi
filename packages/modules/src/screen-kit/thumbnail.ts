// Thumbnails for module screens (06 §6): the ref a renderer resolves, the states it can be in, and
// the hook that loads one. The loader is the platform's media client, bound by apps/mobile.
import { useEffect, useRef, useState } from 'react';

import type { MediaRefMime } from '@bolusi/schemas';

/**
 * What a renderer hands the media client to resolve one attachment (06 §6).
 *
 * Two arms, because an attachment is NOT always accompanied by a signed hash, and the difference
 * decides whether fetching is permissible at all:
 *
 *  - `signed` (schemaVersion 3 payloads): the `sha256` rode inside the op payload under the
 *    originating device's Ed25519 signature (05 §2), so bytes fetched from the server can be
 *    verified against it before display — the whole of 06 §6.
 *  - `legacy` (schemaVersion 1/2 payloads): an id, and NO signed hash — there never was one. Such a
 *    note is resolvable only from a local file. It must never be fetched, because there would be
 *    nothing to check the bytes against, and "shown unverified" is indistinguishable to the user
 *    from "shown verified".
 *
 * A discriminated union rather than `{mediaId, sha256: string | null}` so that "fetch these bytes
 * and trust them" has NO INHABITANT: the `legacy` arm has no `sha256` field, so a caller cannot
 * physically reach the verifying fetch without producing a hash. The type is the enforcement — not
 * a comment asking the next author to remember (CLAUDE.md §2.11).
 */
export type ThumbnailRef =
  | {
      readonly kind: 'signed';
      readonly mediaId: string;
      readonly sha256: string;
      readonly mime: MediaRefMime;
    }
  | { readonly kind: 'legacy'; readonly mediaId: string };

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
