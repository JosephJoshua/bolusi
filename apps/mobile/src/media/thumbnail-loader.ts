/**
 * THE BRIDGE that makes a PULLED note's photo actually verifiable (task 120; 06 §6).
 *
 * ── WHAT WAS MISSING, AND WHY IT COULD NOT BE FIXED HERE ────────────────────────────────────────
 * Task 119 left `loadThumbnail` as `UNWIRED_NOTES_MEDIA`, resolving `unavailable`, and was right to:
 * 06 §6 says downloaded bytes must be "verified against `mediaRef.sha256` before display", and at
 * schemaVersion 2 the `notes.note_created` payload carried a bare `mediaId`. For a note pulled from
 * another device there was NO hash anywhere on this device — no `media_items` row, nothing in the
 * payload — so every reachable implementation of this function was either "render unverified" (which
 * §6 forbids) or "never render". Wiring it then would have meant choosing one of those.
 *
 * schemaVersion 3 carries the whole signed `mediaRef`, so the hash now arrives with the op, covered
 * by the originating device's signature (05 §2). This file is the wiring that was waiting for it.
 *
 * ── WHY THE SOURCE OF THE HASH IS THE WHOLE POINT ───────────────────────────────────────────────
 * The `ThumbnailRef` handed in comes from the note projection, which the v3 fold wrote from the
 * signed payload. It is NOT read from `media_items` here, and must never be: that row is local state
 * a rooted device, a restored backup, or another process can rewrite, so verifying a downloaded file
 * against it would verify the file against itself. `core/src/media/download.ts` makes this argument
 * at length and takes the hash as a parameter precisely to force the caller to source it correctly.
 */
import type { NotesRuntime, ThumbnailRef, ThumbnailState } from '@bolusi/modules/notes/screens';

import type { MediaClient } from '../../media/client.js';
import type { RenderableMedia } from '../../media/remote-cache.js';

/**
 * Map the media client's outcome onto the screen's four states (design-system §5).
 *
 * `mismatch` maps to `mismatch` and NOTHING else. Folding it into `unavailable` would be the
 * dangerous simplification: the user would see "photo not available yet" — a calm, routine,
 * ignorable state — for the one case that means the bytes on the server are not the bytes that were
 * signed. 06 §6/§8 require that to be loud and distinct.
 */
function toThumbnailState(resolved: RenderableMedia): ThumbnailState {
  switch (resolved.kind) {
    case 'local':
    case 'cached':
      // Both arms are hash-verified against the SIGNED ref before `loadForRender` returns them —
      // `cached` always was, `local` since task 140, which found this arm rendering a document-dir
      // file on `exists()` alone and so serving one device's photo as another's evidence. There is
      // no path from unverified bytes to a rendered uri THROUGH `loadForRender`.
      //
      // The `legacy` branch of the loader below is the exception, and it is one this mapping cannot
      // see: `loadLocalForRender` also answers `local`, for a v1/v2 attachment that has no signed
      // hash anywhere on the device to check. `remote-cache.ts`'s `loadLocalMediaOnly` states that
      // residual in full. Do not read this `case 'local'` as proof of verification on its own — the
      // proof lives at the call site that chose which loader to use.
      return { kind: 'ready', uri: resolved.uri };
    case 'unavailable':
      return { kind: 'unavailable' };
    case 'mismatch':
      return { kind: 'mismatch' };
  }
}

/**
 * Bind the notes port's `loadThumbnail` to the real media client.
 *
 * The two arms are not interchangeable and the ref's type is what keeps them apart:
 *  - `signed` → the full 06 §6 path: local file, else cache (re-verified), else fetch + verify.
 *  - `legacy` → local file or nothing. No cache read, no fetch: there is no hash to check against.
 */
export function createNotesThumbnailLoader(media: MediaClient): NotesRuntime['loadThumbnail'] {
  return async (ref: ThumbnailRef): Promise<ThumbnailState> => {
    const resolved =
      ref.kind === 'signed'
        ? await media.loadForRender({ mediaId: ref.mediaId, sha256: ref.sha256, mime: ref.mime })
        : await media.loadLocalForRender(ref.mediaId);
    return toThumbnailState(resolved);
  };
}
