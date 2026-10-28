// How a note's attachment is resolved for display (06 §6) — the ONE place that decides whether a
// given note's photo may be fetched from the server at all.
//
// WHY THIS IS NOT IN screens/runtime.tsx. It was, briefly, and that was wrong twice over. It is a
// DATA rule, not a rendering one: whether a note carries a signed hash is a property of the op
// version that created it (v3 does, v1/v2 do not), and the answer must be identical for every
// surface that ever renders a note. Living under `screens/` also made it unreachable from any test
// that does not boot React Native, which is exactly the wrong place to put a security-relevant
// policy — the rule that decides "may these bytes be fetched" has to be testable in a plain lane.
import type { MediaRefMime } from '@bolusi/schemas';

import type { ThumbnailRef } from '../screen-kit/thumbnail.js';

/** The render-path ref (06 §6); shared by every module's screens (screen-kit/thumbnail.ts). */
export type { ThumbnailRef };

/** The subset of a note row this policy reads — so it is callable from a query row or a fixture. */
export interface NoteMediaFields {
  readonly mediaId: string | null;
  readonly mediaSha256: string | null;
  readonly mediaMime: string | null;
}

/**
 * Build the render-path ref for a note row (06 §6), or `null` when the note has no attachment.
 *
 * The hash is taken from the row the v3 fold wrote — i.e. ultimately from the signed payload — and
 * NEVER from a `media_items` row. That local row is rewritable by anyone with device access, so
 * verifying a downloaded file against it would verify the file against itself
 * (`packages/core/src/media/download.ts` makes this argument at length).
 *
 * `mediaSha256` and `mediaMime` are checked together and treated as all-or-nothing. They are written
 * together by one fold from one nullable object, so a half-populated row is not a state the applier
 * can produce; if one is ever missing, that is corruption, and the safe reading of corruption is
 * `legacy` (local file only) rather than a fetch with a half-known expectation.
 */
export function thumbnailRefFor(note: NoteMediaFields): ThumbnailRef | null {
  if (note.mediaId === null) return null;
  if (note.mediaSha256 === null || note.mediaMime === null) {
    return { kind: 'legacy', mediaId: note.mediaId };
  }
  return {
    kind: 'signed',
    mediaId: note.mediaId,
    sha256: note.mediaSha256,
    mime: note.mediaMime as MediaRefMime,
  };
}
