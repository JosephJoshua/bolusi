// Remote media cache — the download side (06-media-pipeline §6).
//
// "Trust, but verify, same doctrine as pull-side signature checks (api/01-sync §4)." The bytes
// arriving here are attacker-reachable in a way the upload side's are not: they come from the
// server, over a device-token-authed but otherwise unremarkable GET, and they are about to be
// rendered as EVIDENCE of a repair. The ONLY thing binding them to the signed claim is
// `mediaRef.sha256`, which the op's Ed25519 signature covers (06 §3.1). So the hash check below
// is not a corruption guard — it is the whole security property of this path.
import { bytesToHex } from '../crypto/bytes.js';
import type { CryptoPort } from '../crypto/port.js';
import { MediaTransportError, type MediaTransportPort } from './ports.js';

/** Outcome of a render-time fetch. `mismatch` is terminal for this render (06 §6). */
export type MediaFetchOutcome =
  | { readonly kind: 'ok'; readonly bytes: Uint8Array }
  | { readonly kind: 'unavailable'; readonly code: string | null }
  | { readonly kind: 'mismatch'; readonly expected: string; readonly actual: string };

export interface VerifiedDownloadOptions {
  readonly transport: MediaTransportPort;
  readonly crypto: CryptoPort;
}

/**
 * Fetch `mediaId` and verify it against the SIGNED `mediaRef.sha256` before it is ever returned
 * for display (06 §6).
 *
 * "mismatch ⇒ discard + refetch once, then surface" — implemented literally: at most two fetches,
 * and a mismatching body is never returned, never cached, and never rendered. The refetch exists
 * because a mismatch is far more likely to be a truncated/garbled transfer than an attack; the
 * single retry distinguishes the two without becoming a loop that hammers a hostile server.
 *
 * WHY `expected` IS A PARAMETER AND NOT READ FROM THE DB. The hash must come from the `mediaRef`
 * inside the signed op payload — the only tamper-evident copy (06 §3.1). Reading it from the local
 * `media_items` row would verify the bytes against a value an attacker with local DB access could
 * have rewritten to match their substituted file, i.e. it would verify the file against itself.
 * Taking it as an argument forces the caller to source it from the payload.
 *
 * NEVER PREFETCHED. 06 §6: "on demand at render time — never prefetched in the sync loop". This
 * function is called by the renderer; no sync-loop code path may import it — asserted in
 * `test/media/sync-independence.test.ts`, which walks `src/sync/` and fails on a reference to this
 * module or `fetchAndVerifyMedia`. (The assertion postdates this comment: review-18 found the
 * comment claiming a test that did not exist.)
 */
export async function fetchAndVerifyMedia(
  options: VerifiedDownloadOptions,
  mediaId: string,
  expectedSha256: string,
): Promise<MediaFetchOutcome> {
  // The hash of the LAST body that failed verification. Not `| null` with a `??` fallback at the
  // return: an un-set fallback here would have to invent a value for "the hash we saw", and the
  // only honest inventions are `''` or the expected hash — both of which READ LIKE MEASUREMENTS.
  // `??` on a value you failed to read is a lie generator (the same shape as this adapter's
  // `hashFile` returning the empty-string SHA-256 for a missing file, caught in review-18). So the
  // loop cannot exit without assigning it, and the type says so.
  let lastActual: string | undefined;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let bytes: Uint8Array;
    try {
      bytes = await options.transport.download(mediaId);
    } catch (error) {
      if (error instanceof MediaTransportError) {
        // api/03 §8: a download 404 is expected and transient — "the op may precede the media".
        return { kind: 'unavailable', code: error.code };
      }
      throw error;
    }

    // `CryptoPort.sha256` returns the RAW 32 bytes, never hex (crypto/port.ts:60) — the hex
    // rendering is this call site's job, and `zSha256Hex` pins the comparison to lowercase hex.
    const actual = bytesToHex(options.crypto.sha256(bytes));
    if (actual === expectedSha256) return { kind: 'ok', bytes };
    lastActual = actual;
    // Discard. The bytes are not returned, not written to the cache dir, and not rendered.
  }

  // Surfaced (06 §6/§8): two independent fetches disagreed with the signed hash. Either the
  // server holds bytes that are not what was signed, or something between us is rewriting them.
  //
  // `lastActual` is assigned on every path that reaches here — the loop either returns `ok`,
  // returns `unavailable`, or assigns it. If a future edit breaks that, this throws instead of
  // reporting a fabricated hash: a wrong `actual` in a mismatch report is evidence about evidence,
  // and it would be read by a human deciding whether a photo was tampered with.
  if (lastActual === undefined) {
    throw new Error('fetchAndVerifyMedia: unreachable — mismatch with no measured hash');
  }
  return { kind: 'mismatch', expected: expectedSha256, actual: lastActual };
}
