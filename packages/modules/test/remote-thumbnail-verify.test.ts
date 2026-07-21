// A PULLED note's photo is download-verified against the SIGNED sha256 (task 120; 06 §6, 05 §2).
//
// THE BUG THIS PINS. Before schemaVersion 3, `notes.note_created` carried only `mediaId`. A note
// captured on THIS device still rendered — its bytes are on disk and `media_items.local_path` finds
// them. A note PULLED from another device could not be verified at all: 06 §6 requires fetched bytes
// be "verified against `mediaRef.sha256` before display", and the pulling device had no `media_items`
// row and no hash from any source. So the only reachable outcomes for a remote photo were "render it
// unverified" or "never render it". v3 carries the whole signed `mediaRef`, and these tests walk the
// resulting hash from the foreign device's signed payload all the way to the verify.
//
// WHY THE ASSERTIONS ARE ABOUT A HASH THAT CAME OUT OF THE PROJECTION. The point is provenance, not
// arithmetic: `fetchAndVerifyMedia` was already correct and already tested in core. What was missing
// was any way for a remote note to SUPPLY it an expected hash. So each test below sources the hash
// the way the app does — remote op → fold → query → `thumbnailRefFor` — rather than handing the
// verifier a literal, which would prove only that SHA-256 works.
import { createHash } from 'node:crypto';

import { afterEach, describe, expect, test } from 'vitest';

import {
  fetchAndVerifyMedia,
  MediaTransportError,
  type CryptoPort,
  type MediaTransportPort,
} from '@bolusi/core';
import { getNoteHandler, thumbnailRefFor, noteCreatedPayload } from '@bolusi/modules/notes';

import {
  DEVICE_B,
  insertOp,
  MEDIA_A,
  MEDIA_A_REF,
  noteId,
  op,
  openClientEngine,
  STORE,
  TENANT,
  USER_B,
  type ClientEngine,
} from './support/engines.js';

let eng: ClientEngine | null = null;
afterEach(async () => {
  await eng?.close();
  eng = null;
});

/** The real bytes the foreign device captured, and the hash its signed payload therefore pins. */
const REAL_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]);
const REAL_SHA256 = createHash('sha256').update(REAL_BYTES).digest('hex');

/** What a hostile or broken server might return instead. Same length — only the content differs. */
const TAMPERED_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 9]);

const crypto: CryptoPort = {
  sha256: (data: Uint8Array) => new Uint8Array(createHash('sha256').update(data).digest()),
} as unknown as CryptoPort;

/** A transport that serves exactly what it is told to, so a test can substitute the bytes. */
function transportServing(bytes: Uint8Array | 'missing'): MediaTransportPort {
  return {
    download: (): Promise<Uint8Array> =>
      bytes === 'missing'
        ? Promise.reject(
            new MediaTransportError('media not found', { code: 'MEDIA_NOT_FOUND', status: 404 }),
          )
        : Promise.resolve(bytes),
  } as unknown as MediaTransportPort;
}

const REMOTE_V3 = noteId(21);
const REMOTE_V2 = noteId(22);

/**
 * A `note_created` op from ANOTHER device (DEVICE_B/USER_B — this is the whole point: nothing about
 * this media was ever on our disk), carrying the signed ref at `schemaVersion` 3.
 */
function remoteV3Op(sha256: string) {
  return op(
    {
      id: 'op-remote-v3',
      deviceId: DEVICE_B,
      userId: USER_B,
      type: 'notes.note_created',
      entityType: 'note',
      entityId: REMOTE_V3,
      schemaVersion: 3,
      payload: {
        title: 'Layar retak',
        body: 'dari perangkat lain',
        mediaRef: { ...MEDIA_A_REF, sha256 },
      },
    },
    1,
  );
}

/** Read a note through the REAL query handler — the same seam the screen uses (04 §6). */
async function readNote(entityId: string) {
  if (eng === null) throw new Error('engine not open');
  const page = await getNoteHandler({ noteId: entityId }, {
    db: eng.db as never,
    tenantId: TENANT,
    storeId: STORE,
  } as never);
  const row = page.rows[0];
  if (row === undefined) throw new Error(`no note ${entityId}`);
  return row;
}

describe('a PULLED note verifies its photo against the SIGNED sha256 (06 §6)', () => {
  test('the signed hash survives the pull → fold → query trip and reaches the render ref', async () => {
    eng = await openClientEngine();
    const remote = remoteV3Op(REAL_SHA256);
    await insertOp(eng.db, remote);
    await eng.engine.applyAppendedOp(remote);

    const row = await readNote(REMOTE_V3);
    // The hash we will verify against came off ANOTHER device's signed payload — never from a local
    // media_items row, which does not exist for this note and would be attacker-writable if it did.
    expect(row.mediaSha256).toBe(REAL_SHA256);
    expect(row.mediaMime).toBe('image/jpeg');

    const ref = thumbnailRefFor(row);
    expect(ref).toStrictEqual({
      kind: 'signed',
      mediaId: MEDIA_A,
      sha256: REAL_SHA256,
      mime: 'image/jpeg',
    });
  });

  test('the honest bytes verify: the server returning what was signed yields ok', async () => {
    eng = await openClientEngine();
    const remote = remoteV3Op(REAL_SHA256);
    await insertOp(eng.db, remote);
    await eng.engine.applyAppendedOp(remote);
    const ref = thumbnailRefFor(await readNote(REMOTE_V3));
    if (ref?.kind !== 'signed') throw new Error('expected a signed ref');

    const outcome = await fetchAndVerifyMedia(
      { transport: transportServing(REAL_BYTES), crypto },
      ref.mediaId,
      ref.sha256,
    );

    // POSITIVE CONTROL. Without it, a verify that rejected EVERYTHING would pass the test below and
    // look like a working integrity check while rendering nothing, forever.
    expect(outcome.kind).toBe('ok');
  });

  test('TAMPERED bytes are REJECTED — mismatch, and the bytes are never returned', async () => {
    eng = await openClientEngine();
    const remote = remoteV3Op(REAL_SHA256);
    await insertOp(eng.db, remote);
    await eng.engine.applyAppendedOp(remote);
    const ref = thumbnailRefFor(await readNote(REMOTE_V3));
    if (ref?.kind !== 'signed') throw new Error('expected a signed ref');

    const outcome = await fetchAndVerifyMedia(
      { transport: transportServing(TAMPERED_BYTES), crypto },
      ref.mediaId,
      ref.sha256,
    );

    expect(outcome.kind).toBe('mismatch');
    // The substituted bytes are NOT handed back under any key — `mismatch` carries hashes only, so
    // there is no field a careless caller could render. This is the property, not the label.
    expect(Object.values(outcome)).not.toContainEqual(TAMPERED_BYTES);
    if (outcome.kind === 'mismatch') {
      expect(outcome.expected).toBe(REAL_SHA256);
      expect(outcome.actual).not.toBe(REAL_SHA256);
    }
  });

  test('a 404 is unavailable, NOT mismatch — an absent photo is not a tampered one', async () => {
    eng = await openClientEngine();
    const remote = remoteV3Op(REAL_SHA256);
    await insertOp(eng.db, remote);
    await eng.engine.applyAppendedOp(remote);
    const ref = thumbnailRefFor(await readNote(REMOTE_V3));
    if (ref?.kind !== 'signed') throw new Error('expected a signed ref');

    const outcome = await fetchAndVerifyMedia(
      { transport: transportServing('missing'), crypto },
      ref.mediaId,
      ref.sha256,
    );
    // api/03 §8: the op may simply precede the media. Collapsing this into `mismatch` would cry
    // tamper at every not-yet-uploaded photo and train the user to ignore the danger state.
    expect(outcome.kind).toBe('unavailable');
  });
});

describe('backward compatibility: a v2 note has NO signed hash and is never fetched', () => {
  test('a pulled v2 note routes to the legacy arm — local file only, never network', async () => {
    eng = await openClientEngine();
    const remote = op(
      {
        id: 'op-remote-v2',
        deviceId: DEVICE_B,
        userId: USER_B,
        type: 'notes.note_created',
        entityType: 'note',
        entityId: REMOTE_V2,
        schemaVersion: 2,
        payload: { title: 'Lama', body: 'v2', mediaId: MEDIA_A },
      },
      1,
    );
    await insertOp(eng.db, remote);
    await eng.engine.applyAppendedOp(remote);

    const row = await readNote(REMOTE_V2);
    expect(row.mediaId).toBe(MEDIA_A);
    // Honestly empty rather than back-filled: no hash was ever signed for this op, and inventing one
    // from the local media_items row would verify the file against itself.
    expect(row.mediaSha256).toBeNull();

    // `legacy` is what forbids the fetch. There is no `sha256` field on this arm, so a caller
    // physically cannot reach `fetchAndVerifyMedia` with it — the type is the enforcement.
    expect(thumbnailRefFor(row)).toStrictEqual({ kind: 'legacy', mediaId: MEDIA_A });
  });

  test('a note with no attachment resolves to no ref at all', async () => {
    eng = await openClientEngine();
    const remote = op(
      {
        id: 'op-remote-none',
        deviceId: DEVICE_B,
        userId: USER_B,
        type: 'notes.note_created',
        entityType: 'note',
        entityId: noteId(23),
        schemaVersion: 3,
        payload: { title: 'Tanpa foto', body: '', mediaRef: null },
      },
      1,
    );
    await insertOp(eng.db, remote);
    await eng.engine.applyAppendedOp(remote);
    expect(thumbnailRefFor(await readNote(noteId(23)))).toBeNull();
  });
});

describe('the v3 payload gate: media without its signed hash is unrepresentable', () => {
  test('a complete ref parses, and null parses', () => {
    expect(
      noteCreatedPayload.safeParse({ title: 'a', body: '', mediaRef: MEDIA_A_REF }).success,
    ).toBe(true);
    expect(noteCreatedPayload.safeParse({ title: 'a', body: '', mediaRef: null }).success).toBe(
      true,
    );
  });

  test('a mediaRef MISSING sha256 is REJECTED — this is the whole point of v3', () => {
    const noHash: Record<string, unknown> = { ...MEDIA_A_REF };
    delete noHash['sha256'];
    expect(noteCreatedPayload.safeParse({ title: 'a', body: '', mediaRef: noHash }).success).toBe(
      false,
    );
  });

  test('a mediaRef missing mime is REJECTED (the render path needs it to pick the cache file)', () => {
    const noMime: Record<string, unknown> = { ...MEDIA_A_REF };
    delete noMime['mime'];
    expect(noteCreatedPayload.safeParse({ title: 'a', body: '', mediaRef: noMime }).success).toBe(
      false,
    );
  });

  test('a non-hex / wrong-length sha256 is REJECTED, not merely present', () => {
    for (const bad of ['', 'deadbeef', 'z'.repeat(64), 'A'.repeat(64)]) {
      expect(
        noteCreatedPayload.safeParse({
          title: 'a',
          body: '',
          mediaRef: { ...MEDIA_A_REF, sha256: bad },
        }).success,
        `sha256 ${JSON.stringify(bad)} must not parse`,
      ).toBe(false);
    }
  });

  test('the LEGACY v2 flat shape is REJECTED by the v3 schema (strict — no silent coexistence)', () => {
    // If this parsed, a caller could keep emitting id-only attachments at version 3 and the payload
    // would look modern while carrying nothing verifiable.
    expect(noteCreatedPayload.safeParse({ title: 'a', body: '', mediaId: MEDIA_A }).success).toBe(
      false,
    );
  });
});
