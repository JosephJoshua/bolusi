// 06-media-pipeline §6 — the render-time remote cache. A SECURITY SURFACE (security-guide §2.5).
//
// These bytes are the only ones in the system that arrive from outside and are shown to a human as
// EVIDENCE of a repair. The single thing binding them to the signed claim is `mediaRef.sha256`,
// which the op's Ed25519 signature covers (06 §3.1). So the adversarial cases come first here, not
// after review: a server that returns something else, a server that returns it twice, and a LOCAL
// cache entry that someone rewrote between renders.
//
// The hash is a REAL SHA-256 throughout (`noblePort`), so "the bytes matched" is a cryptographic
// statement and not an equality between two fixture strings.
import { MediaTransportError, type MediaTransportPort } from '@bolusi/core';
import { noblePort } from '@bolusi/test-support';
import { describe, expect, test } from 'vitest';

import { FakeFs, bytesOfLength, sha256Hex } from './_harness.test.js';
import { loadLocalMediaOnly, loadMediaForRender, type RemoteMediaDeps } from './remote-cache.js';

const BYTES = bytesOfLength(512);
const REF = { mediaId: 'm-1', sha256: sha256Hex(BYTES), mime: 'image/jpeg' } as const;

function rig(options: {
  localPath?: string | null;
  /** What actually sits at `localPath`. Defaults to the bytes `REF.sha256` was taken over. */
  localBytes?: Uint8Array;
  download?: () => Promise<Uint8Array>;
  seedCache?: Uint8Array;
}) {
  const fs = new FakeFs();
  const evictions: string[] = [];
  const downloads: number[] = [];
  if (options.localPath !== undefined && options.localPath !== null) {
    fs.write(options.localPath, options.localBytes ?? BYTES);
  }
  if (options.seedCache !== undefined) {
    fs.write('/cache/media/m-1.jpg', options.seedCache);
  }

  const transport = {
    download: (): Promise<Uint8Array> => {
      downloads.push(1);
      return options.download === undefined ? Promise.resolve(BYTES) : options.download();
    },
  } as unknown as MediaTransportPort;

  const deps: RemoteMediaDeps = {
    transport,
    crypto: noblePort,
    files: fs.port,
    localPathFor: () => Promise.resolve(options.localPath ?? null),
    findCached: (mediaId, extension) => {
      const path = `/cache/media/${mediaId}.${extension}`;
      return fs.files.has(path) ? path : null;
    },
    writeCached: (mediaId, extension, bytes) =>
      fs.write(`/cache/media/${mediaId}.${extension}`, bytes),
    evictCached: (mediaId) => {
      evictions.push(mediaId);
      fs.files.delete(`/cache/media/${mediaId}.jpg`);
    },
  };
  return { deps, fs, evictions, downloads };
}

describe('§6 — resolution order: local, then cache, then network', () => {
  test('POSITIVE CONTROL: a MATCHING document-dir file is served with ZERO downloads', () => {
    // The offline-first half of task 140, and the reason its fix could not be "always fetch". The
    // local file hashes to the signed ref, so it renders from the document dir and the network is
    // never touched — a prefetch or a re-download here would be a data-cost bug on a metered
    // connection and would break capture-then-view with no uplink at all.
    const { deps, downloads } = rig({ localPath: '/documents/media/m-1.jpg' });
    return loadMediaForRender(deps, REF).then((outcome) => {
      expect(outcome).toEqual({ kind: 'local', uri: '/documents/media/m-1.jpg' });
      expect(downloads).toHaveLength(0);
    });
  });

  test('a row whose file was PRUNED falls through to the network (localPath present, file gone)', async () => {
    // 06 §7 keeps the row with `localPath = null`, but a stale path is also possible after an OS
    // purge — hence the `exists` check rather than trusting the column.
    const { deps, downloads } = rig({ localPath: null });
    const outcome = await loadMediaForRender(deps, REF);
    expect(outcome.kind).toBe('cached');
    expect(downloads).toHaveLength(1);
  });

  test('a fetched file is verified, written to the CACHE dir, and reused on the next render', async () => {
    const { deps, fs, downloads } = rig({});
    const first = await loadMediaForRender(deps, REF);
    expect(first).toEqual({ kind: 'cached', uri: '/cache/media/m-1.jpg' });
    expect(fs.read('/cache/media/m-1.jpg')).toEqual(BYTES);

    const second = await loadMediaForRender(deps, REF);
    expect(second.kind).toBe('cached');
    // ONE download for two renders — the cache is doing its job.
    expect(downloads).toHaveLength(1);
  });

  test('a PNG signature lands under the .png name — the extension follows the signed mime', async () => {
    const png = bytesOfLength(64, 3);
    const { deps, fs } = rig({ download: () => Promise.resolve(png) });
    const outcome = await loadMediaForRender(deps, {
      mediaId: 'm-1',
      sha256: sha256Hex(png),
      mime: 'image/png',
    });
    expect(outcome).toEqual({ kind: 'cached', uri: '/cache/media/m-1.png' });
    expect(fs.files.has('/cache/media/m-1.png')).toBe(true);
  });
});

describe('§6 — the verification IS the security property', () => {
  test('ADVERSARIAL: a server returning different bytes is refused, twice, and nothing is cached', async () => {
    // Two independent fetches disagreed with the signed hash. Either the server holds bytes that
    // were not signed, or something between us is rewriting them. Neither is renderable.
    const { deps, fs, downloads } = rig({
      download: () => Promise.resolve(bytesOfLength(512, 99)),
    });
    const outcome = await loadMediaForRender(deps, REF);

    expect(outcome.kind).toBe('mismatch');
    expect((outcome as { expected: string }).expected).toBe(REF.sha256);
    // The MEASURED hash, not a fabricated one — a wrong `actual` here is evidence about evidence.
    expect((outcome as { actual: string }).actual).toBe(sha256Hex(bytesOfLength(512, 99)));
    // "discard + refetch once, then surface" — exactly two fetches, and no bytes on disk.
    expect(downloads).toHaveLength(2);
    expect(fs.files.has('/cache/media/m-1.jpg')).toBe(false);
  });

  test('ADVERSARIAL: a TAMPERED cache entry is re-verified, evicted, and refetched', async () => {
    // The cache directory is ordinary app storage. A rooted device, a restored backup, or another
    // process can rewrite it — and a cached photo is about to be shown to a human as proof. Trusting
    // it because it was verified ONCE would mean the signed hash guarded only the first journey.
    const { deps, fs, evictions, downloads } = rig({ seedCache: bytesOfLength(512, 42) });
    const outcome = await loadMediaForRender(deps, REF);

    expect(evictions).toEqual(['m-1']);
    expect(downloads).toHaveLength(1);
    expect(outcome).toEqual({ kind: 'cached', uri: '/cache/media/m-1.jpg' });
    // The tampered bytes are gone; the verified ones took their place.
    expect(fs.read('/cache/media/m-1.jpg')).toEqual(BYTES);
  });

  test('ADVERSARIAL: a LOCAL file that is not the signed bytes is NEVER rendered (task 140)', async () => {
    // The evidence-substitution case, and the one the local arm used to serve straight to a screen.
    // Device A signs a note whose `mediaRef.mediaId` names media THIS device holds; `localPathFor`
    // answers by id, so before task 140 `exists()` alone returned `{kind:'local'}` and the renderer
    // showed OUR photo as A's repair evidence — no hash read, no download. The local bytes here are
    // deliberately a DIFFERENT real file, so the refusal is a SHA-256 statement and not an
    // equality between two fixture strings.
    const foreign = bytesOfLength(512, 3);
    const { deps, downloads } = rig({
      localPath: '/documents/media/m-1.jpg',
      localBytes: foreign,
      download: () => Promise.resolve(BYTES),
    });
    expect(sha256Hex(foreign)).not.toBe(REF.sha256);

    const outcome = await loadMediaForRender(deps, REF);

    // Not `local`, and not the local uri under any other kind either.
    expect(outcome.kind).not.toBe('local');
    // It fell through to the VERIFYING fetch, which returned the signed bytes.
    expect(outcome).toEqual({ kind: 'cached', uri: '/cache/media/m-1.jpg' });
    expect(downloads).toHaveLength(1);
  });

  test('a mismatching LOCAL file is not deleted — it may be un-uploaded evidence (§7)', async () => {
    // The fall-through must withhold DISPLAY, not destroy bytes. §7 never prunes pending/uploading/
    // failed media automatically, and a rotted local file's owner is the drain's LOCAL_CORRUPT
    // (§5.1) — a render-path eviction here would be this repo deleting evidence to fix a display bug.
    const foreign = bytesOfLength(512, 3);
    const { deps, fs, evictions } = rig({
      localPath: '/documents/media/m-1.jpg',
      localBytes: foreign,
    });
    await loadMediaForRender(deps, REF);
    expect(fs.read('/documents/media/m-1.jpg')).toEqual(foreign);
    expect(evictions).toEqual([]);
  });

  test('a mismatching LOCAL file with nothing on the server is `unavailable`, never `local`', async () => {
    // The offline leg of the same case: no cache entry, and the fetch 404s. The honest answer is
    // "no verified bytes exist here", which the screen renders as unavailable — NOT the local file.
    const { deps } = rig({
      localPath: '/documents/media/m-1.jpg',
      localBytes: bytesOfLength(512, 3),
      download: () =>
        Promise.reject(new MediaTransportError('nope', { code: 'MEDIA_NOT_FOUND', status: 404 })),
    });
    expect(await loadMediaForRender(deps, REF)).toEqual({
      kind: 'unavailable',
      code: 'MEDIA_NOT_FOUND',
    });
  });

  test('POSITIVE CONTROL: an INTACT cache entry is served without eviction or a fetch', async () => {
    // Without this, the test above would pass on an implementation that evicted the cache on every
    // render — correct-looking, and a full re-download of every photo on every screen.
    const { deps, evictions, downloads } = rig({ seedCache: BYTES });
    const outcome = await loadMediaForRender(deps, REF);
    expect(outcome).toEqual({ kind: 'cached', uri: '/cache/media/m-1.jpg' });
    expect(evictions).toEqual([]);
    expect(downloads).toHaveLength(0);
  });

  test('a 404 is `unavailable`, carrying the code — the op may simply precede the media', async () => {
    // api/03 §8: expected and transient. Rendering it as tampering would cry wolf on the normal
    // case where another device's op arrived before its photo finished uploading.
    const { deps } = rig({
      download: () =>
        Promise.reject(new MediaTransportError('nope', { code: 'MEDIA_NOT_FOUND', status: 404 })),
    });
    expect(await loadMediaForRender(deps, REF)).toEqual({
      kind: 'unavailable',
      code: 'MEDIA_NOT_FOUND',
    });
  });
});

describe('§6 — the LEGACY arm: what verification can mean when no signed hash exists', () => {
  // `loadLocalMediaOnly` serves v1/v2 `note_created`, whose payload never carried a hash. The fix
  // above is unavailable here BY CONSTRUCTION, not by omission: there is nothing on this device to
  // check the bytes against, and the one candidate — the `media_items` row — is the rewritable local
  // state `notes/applier.ts` already refuses to back-fill from. These tests pin the narrower
  // guarantee this arm actually makes, so a reader cannot mistake it for the verified one.

  function legacyRig(seed?: { path: string; bytes: Uint8Array }) {
    const fs = new FakeFs();
    if (seed !== undefined) fs.write(seed.path, seed.bytes);
    return {
      fs,
      deps: {
        files: fs.port,
        localPathFor: (): Promise<string | null> => Promise.resolve(seed?.path ?? null),
      },
    };
  }

  test('a document-dir file is served, and NOTHING is fetched or read from the cache', async () => {
    // The whole arm: `files` and `localPathFor` are the only deps it is given, so "it must never
    // fetch" is enforced by the type — there is no transport in reach to call. That is the
    // structural half of the guarantee; the assertion below is the behavioural half.
    const { deps } = legacyRig({ path: '/documents/media/m-9.jpg', bytes: BYTES });
    expect(await loadLocalMediaOnly(deps, 'm-9')).toEqual({
      kind: 'local',
      uri: '/documents/media/m-9.jpg',
    });
  });

  test('a pruned legacy attachment is honestly `unavailable` forever — never fetched on spec', async () => {
    const { deps } = legacyRig();
    expect(await loadLocalMediaOnly(deps, 'm-9')).toEqual({ kind: 'unavailable', code: null });
  });

  test('the guarantee is about the FILE, not the OP — the residual task 140 could not close', async () => {
    // Written as a test rather than left in prose so it cannot rot silently: these bytes are NOT any
    // signed value, and this arm still returns them, because no signed value exists for a v1/v2
    // attachment. The closure is authorship ("did THIS device author the op"), which needs the note's
    // author DEVICE at the call site — `ThumbnailRef.legacy` carries a bare mediaId and the `notes`
    // projection has only `created_by` (a user id) — i.e. a migration + projection change, its own
    // task. Bounded today by NOTE_CREATED_SCHEMA_VERSION = 3: nothing freshly emitted lands here.
    const foreign = bytesOfLength(512, 3);
    expect(sha256Hex(foreign)).not.toBe(REF.sha256);
    const { deps } = legacyRig({ path: '/documents/media/m-9.jpg', bytes: foreign });
    expect(await loadLocalMediaOnly(deps, 'm-9')).toEqual({
      kind: 'local',
      uri: '/documents/media/m-9.jpg',
    });
  });
});
