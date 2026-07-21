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
