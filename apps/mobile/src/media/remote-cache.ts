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
  /** Self-captured, still on this device: the document dir (06 §6 — "Only self-captured media lives there"). */
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
 * Order: local file → cache (re-verified) → network. That order is the spec's own ("whose mediaRef
 * has NO LOCAL FILE"), and it is also what keeps the promise "never prefetched": nothing here runs
 * unless a renderer asked for this specific id.
 *
 * A LOCAL file is NOT re-hashed on this path, deliberately. It is our own capture, its hash was
 * taken over the final bytes at capture (§2.2 step 6) and the drain re-hashes it on `HASH_MISMATCH`
 * (§5.1) — the one place where a rotted local file has a defined answer (`LOCAL_CORRUPT`, which
 * stops retrying and surfaces). Re-hashing every self-captured photo at render time would read the
 * whole file on the UI path of a 2 GB device to duplicate a check that already has an owner.
 */
export async function loadMediaForRender(
  deps: RemoteMediaDeps,
  ref: RenderableMediaRef,
): Promise<RenderableMedia> {
  const localPath = await deps.localPathFor(ref.mediaId);
  if (localPath !== null && (await deps.files.exists(localPath))) {
    return { kind: 'local', uri: localPath };
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
