// The remote media cache — 06-media-pipeline §6, the download side.
//
// §6 in full: "When rendering an op pulled from ANOTHER device whose `mediaRef` has no local file,
// the client fetches `GET /v1/media/:id` **on demand at render time** — never prefetched in the sync
// loop. Fetched files are stored in the **cache** directory, verified against `mediaRef.sha256`
// before display (mismatch ⇒ discard + refetch once, then surface), and are always evictable."
//
// `fetchAndVerifyMedia` (core, task 18) implements the fetch + verify + single refetch, and had NO
// CALLER until this file. This is that caller, plus the two things core cannot do: decide where the
// bytes come from, and write the verified ones to disk.
//
// ── THE VERIFICATION IS THE SECURITY PROPERTY, AND IT APPLIES TO THE CACHE TOO ──────────────────
// Core verifies what the SERVER sends. This file also re-verifies what the CACHE holds, on every
// read, and that second check is not redundant: the cache directory is ordinary app storage that a
// rooted device, a backup restore, or another process can rewrite, and a photo read out of it is
// about to be shown to a human as evidence of a repair. Skipping the re-hash would mean the signed
// `mediaRef.sha256` guarded exactly one journey — the first one — and nothing afterwards.
//
// ── WHY `expectedSha256` IS A PARAMETER FROM THE PAYLOAD ────────────────────────────────────────
// Core's own header argues this and it survives verbatim here because the mistake is so easy: the
// hash MUST come from the `mediaRef` inside the SIGNED op payload, never from the local
// `media_items` row. A row is local state an attacker with device access can rewrite to match a
// substituted file — verifying against it verifies the file against itself. The signature is the
// only tamper-evident copy (06 §3.1), so this function takes the ref and never reads the row's hash.
import {
  fetchAndVerifyMedia,
  type CryptoPort,
  type MediaFilePort,
  type MediaTransportPort,
} from '@bolusi/core';

/** The signed fields this path needs. Sourced from the op payload's `mediaRef` — see the header. */
export interface RenderableMediaRef {
  readonly mediaId: string;
  readonly sha256: string;
  readonly mime: 'image/jpeg' | 'image/png';
}

/**
 * What the renderer gets. Every arm is renderable as a distinct UI state (design-system §5) —
 * there is no arm that means "here is a path, maybe it works".
 */
export type RenderableMedia =
  /**
   * A document-dir file (06 §6 — "Only self-captured media lives there").
   *
   * WHICH PRODUCER RETURNED IT DECIDES WHAT IT PROVES, so do not read this arm as "trusted because
   * it is local" — that reading is the task 140 defect: `loadMediaForRender` returns it only after
   * the bytes hashed to the SIGNED `ref.sha256`, while `loadLocalMediaOnly` (v1/v2, no hash exists
   * anywhere) returns it unverified by necessity and says so at length. Any NEW producer of this arm
   * owes the same statement.
   */
  | { readonly kind: 'local'; readonly uri: string }
  /** Fetched (now or earlier) and hash-verified against the signed ref. */
  | { readonly kind: 'cached'; readonly uri: string }
  /** api/03 §8: a 404 here is expected and transient — "the op may precede the media". */
  | { readonly kind: 'unavailable'; readonly code: string | null }
  /** Two fetches disagreed with the signed hash. Never rendered, always surfaced (§6/§8). */
  | { readonly kind: 'mismatch'; readonly expected: string; readonly actual: string };

export interface RemoteMediaDeps {
  readonly transport: MediaTransportPort;
  readonly crypto: CryptoPort;
  readonly files: MediaFilePort;
  /** The `media_items.local_path` for this id, or null (pruned, or never captured here). */
  readonly localPathFor: (mediaId: string) => Promise<string | null>;
  /** `remoteMediaCache.find` (files.ts) — a uri only if the file is actually present. */
  readonly findCached: (mediaId: string, extension: string) => string | null;
  /** `remoteMediaCache.write` (files.ts). Synchronous, like every `File#write`. */
  readonly writeCached: (mediaId: string, extension: string, bytes: Uint8Array) => string;
  /** `remoteMediaCache.evict` (files.ts) — used to discard a cache entry that failed re-verification. */
  readonly evictCached: (mediaId: string) => void;
}

/** 06 §2.2 step 5 / §2.3: the extension follows the mime, and there are exactly two mimes in v0. */
function extensionFor(mime: RenderableMediaRef['mime']): string {
  return mime === 'image/png' ? 'png' : 'jpg';
}

/**
 * Resolve a `mediaRef` to something renderable, fetching only if it has to (06 §6).
 *
 * Order: local file → cache → network — and every one of the three is hash-verified against the
 * signed ref before it is returned. That order is the spec's own ("whose mediaRef has NO LOCAL
 * FILE"), and it is also what keeps the promise "never prefetched": nothing here runs unless a
 * renderer asked for this specific id.
 *
 * EVERY arm hashes the bytes against the SIGNED `ref.sha256` before returning them — the local one
 * included. It did not always: this arm returned `{kind:'local'}` on `exists(localPath)` alone,
 * justified by "it is our own capture". That sentence is true of a self-authored op and FALSE of
 * exactly the ops this function exists to serve. §6 is about "an op pulled from ANOTHER device", and
 * `localPathFor` answers by MEDIA ID — the id the pulled op NAMES, not evidence that this device
 * captured those bytes. So a note signed elsewhere whose `mediaRef.mediaId` collided with a photo in
 * this device's document dir rendered THIS device's photo as that note's repair evidence, with no
 * hash read and no download (task 140). "A local file exists" is not "this is our capture", and the
 * skip was keyed on the first while its comment described the second.
 *
 * WHY THE SKIP IS NOT REPAIRED BY ASKING WHO AUTHORED THE OP. That is the other shape of this fix,
 * and it is unavailable here rather than merely unchosen: the only two answers reachable on this
 * path are `mediaRef.deviceId` — a payload field the server does not yet bind to the envelope's
 * signer, so an attacker picks it (task 140 Leg B, still open) — and the local `media_items` row,
 * which is precisely the rewritable local state this file's header forbids as a verification input.
 * A gate on either would be the same bypass with a better name. The hash is the only input here that
 * an attacker cannot choose, so the hash is what the skip is keyed on.
 *
 * THE COST, STATED PLAINLY, because the old comment's concern was real: this reads the whole file on
 * the render path of a 2 GB device. What bounds it is NOT a guaranteed file size — §2.2 step 4's
 * 300 KiB is the threshold that TRIGGERS pass 2, whose result is then "accepted unconditionally", so
 * the only hard ceiling is api/03 §3.1's 10 MiB — but the fact that this is the SAME read the cache
 * arm immediately below already performs on every render of every pulled photo, streamed by
 * `files.ts` in 256 KiB slices at one slice of peak memory. Whatever that read costs, this path was
 * already paying it for the majority case; the old comment bought back the minority case by spending
 * the property this file's own first paragraph calls "the whole security property of this path".
 *
 * ON MISMATCH the local file is neither deleted nor evicted. It may be un-uploaded evidence (§7
 * never prunes `pending`/`uploading`/`failed`), and a rotted local file already has an owner in the
 * drain's `HASH_MISMATCH` re-hash → `LOCAL_CORRUPT` (§5.1). What is withheld is DISPLAY: resolution
 * simply continues to the cache and then the verifying fetch, each of which checks what it returns.
 */
export async function loadMediaForRender(
  deps: RemoteMediaDeps,
  ref: RenderableMediaRef,
): Promise<RenderableMedia> {
  const localPath = await deps.localPathFor(ref.mediaId);
  if (localPath !== null && (await deps.files.exists(localPath))) {
    // Verify against the SIGNED hash, exactly as the cache arm does — see the header for why the
    // document dir earns no exemption. A match is the offline-first fast path: `local`, no fetch.
    if ((await deps.files.hashFile(localPath)) === ref.sha256) {
      return { kind: 'local', uri: localPath };
    }
    // No match: these bytes are not the bytes the op signed, whatever put them here. Fall through
    // WITHOUT deleting the file (header) — the cache and the network are both verifying paths.
  }

  const extension = extensionFor(ref.mime);
  const cached = deps.findCached(ref.mediaId, extension);
  if (cached !== null) {
    // Re-verify what the cache holds against the SIGNED hash (see the header).
    const actual = await deps.files.hashFile(cached);
    if (actual === ref.sha256) return { kind: 'cached', uri: cached };
    // Discard and fall through to a refetch. §6's "discard + refetch once" is core's rule for the
    // NETWORK; a bad cache entry is not one of those two fetches, so evicting and continuing here
    // does not spend the retry budget on a local problem.
    deps.evictCached(ref.mediaId);
  }

  const outcome = await fetchAndVerifyMedia(
    { transport: deps.transport, crypto: deps.crypto },
    ref.mediaId,
    ref.sha256,
  );
  switch (outcome.kind) {
    case 'ok':
      // Written ONLY after core returned `ok`, i.e. only after the bytes matched the signed hash.
      // Bytes that failed verification never reach the disk (core discards them) and never reach a
      // screen — which is the whole of §6's "verified before display".
      return { kind: 'cached', uri: deps.writeCached(ref.mediaId, extension, outcome.bytes) };
    case 'unavailable':
      return { kind: 'unavailable', code: outcome.code };
    case 'mismatch':
      return { kind: 'mismatch', expected: outcome.expected, actual: outcome.actual };
  }
}

/**
 * Resolve an attachment that has NO signed hash — a v1/v2 `note_created` (06 §6, task 120).
 *
 * Local file or nothing. There is deliberately no cache read and no fetch: both would produce bytes
 * with nothing to check them against, and 06 §6's requirement is "verified BEFORE display", not
 * "fetched and hoped for". A legacy note whose file has been pruned is honestly `unavailable`
 * forever — the remedy is that new notes are v3, not that old ones start trusting the network.
 *
 * ── WHAT "VERIFIED BEFORE DISPLAY" MEANS ON THIS ARM: NOTHING, AND THAT IS A FACT ABOUT THE DATA ─
 * Task 140 hashed the local arm of `loadMediaForRender` above. This function CANNOT be given the
 * same treatment, and the reason is worth stating rather than leaving as a silent asymmetry that the
 * next reader mistakes for the same bug twice. A v1/v2 `note_created` never carried a hash, so there
 * is no honest copy of one anywhere on this device: the payload has none, and back-filling from the
 * `media_items` row would verify the file against a value anyone with device access can rewrite to
 * match a substituted file — verifying the file against itself. `notes/applier.ts` refuses that
 * back-fill for the same reason and keeps `mediaSha256` null, which is what routes a note here.
 *
 * So the guarantee this arm makes is narrower than §6's, and it is exactly this: the bytes came from
 * the DOCUMENT dir, which only self-captured media occupies (§6), and nothing was fetched.
 *
 * THE RESIDUAL, NAMED: that guarantee is about the FILE, not about the OP. A v1/v2 note pulled from
 * another device that names a `mediaId` this device happens to hold still renders this device's
 * photo as that note's evidence — the same substitution task 140 Leg A closed above, and no hash can
 * close it here because no hash exists. The only closure is authorship — render a legacy attachment
 * only for an op THIS device authored — and that answer is not reachable from this function or its
 * caller: `ThumbnailRef`'s `legacy` arm carries a bare `mediaId`, `NoteMediaFields` carries no
 * author, and the `notes` projection has `created_by` (a USER id, which two devices share) and no
 * author device column at all. Closing it is a migration + projection + port change, i.e. its own
 * task, not a side effect of this one (CLAUDE.md §4).
 *
 * WHAT BOUNDS IT TODAY: `NOTE_CREATED_SCHEMA_VERSION` is 3, so every freshly-emitted note carries
 * the signed ref and lands on the verifying path above. A legacy ref can only be produced by an op
 * emitted by a pre-v3 release, and v0 has not shipped one. The exposure is therefore future, not
 * live — which is a reason to file it, not a reason to leave it undescribed.
 */
export async function loadLocalMediaOnly(
  deps: Pick<RemoteMediaDeps, 'files' | 'localPathFor'>,
  mediaId: string,
): Promise<RenderableMedia> {
  const localPath = await deps.localPathFor(mediaId);
  if (localPath !== null && (await deps.files.exists(localPath))) {
    return { kind: 'local', uri: localPath };
  }
  return { kind: 'unavailable', code: null };
}
