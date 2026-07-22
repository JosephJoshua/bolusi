// ADVERSARIAL at-rest probe for D22's application-layer column encryption (task 148).
//
// D22 replaced SQLCipher (whole-file) with AES-256-GCM over the sensitive COLUMNS, because op-sqlite's
// SQLCipher build vendored a second `libcrypto` that made the Android APK unassemblable (task 148).
// The reshaped guarantee — signed off in D22 addendum 2 — is: **sensitive VALUES are ciphertext;
// relational STRUCTURE (ids, types, timestamps, hashes, counters) stays plaintext.** This file is the
// thing that proves the first half and pins the second.
//
// ── WHY THIS LIVES IN THE HARNESS ───────────────────────────────────────────────────────────────
// It must drive the REAL production writers, not a parallel copy of their SQL (T-13: a probe that
// re-implements the write proves only that the probe encrypts). `@bolusi/harness` is the only package
// that can import @bolusi/core AND @bolusi/modules AND @bolusi/db-client at once, so the actual
// `writeVerifier` / `replaceUsersDirectory` / `insertQuarantinedOp` / op-store / notes-applier code
// paths run here, against a FILE-backed better-sqlite3 DB whose bytes are then read raw.
//
// ── WHAT THIS DOES *NOT* CLAIM (read before citing it) ──────────────────────────────────────────
// This is the NODE leg. It proves the codec and the wiring. It does NOT close SEC-DEV-06 or
// SEC-AUTH-09: "the raw DB file on a real Android device is ciphertext" needs the emulator and an
// assembled APK, neither of which exists on this host (no Android SDK). No SEC id appears in these
// titles for exactly that reason — a green here must never be read as a device-verified claim.
//
// Two write paths are deliberately NOT reachable from this package and are covered elsewhere:
//   - `media_items.location` — written by apps/mobile's `insertMediaItem` (downstream of harness);
//     covered by `apps/mobile/src/media/queue.at-rest.test.ts`.
//   - the PULL insert of `operations` (`insertPulledOp`, private to core's pull phase) — it writes
//     the same three `operations` columns proven below via the op-store path, through the same
//     `encryptColumnValue` seam five other writers here exercise.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  insertQuarantinedOp,
  listSwitcherUsers,
  readVerifier,
  replaceUsersDirectory,
  writeVerifier,
  type PinVerifier,
} from '@bolusi/core';
import {
  Aes256GcmColumnCipher,
  COLUMN_CIPHER_MARKER,
  closeClientDb,
  createClientOpStore,
  openClientDb,
  runClientMigrations,
  type ClientDb,
} from '@bolusi/db-client';
import { noteBodyEditedApplier } from '@bolusi/modules/notes';
import { nodeColumnAead } from '@bolusi/test-support';

import { openFileDriver } from '../src/driver.js';

/** 32 bytes as 64 hex chars — the shape `SecureStoreDbKeyStore` mints (10-db §12). Obviously fake. */
const DB_KEY = 'a'.repeat(64);
/** A DIFFERENT valid key, for the wrong-key probe. */
const WRONG_KEY = 'b'.repeat(64);

function keyBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// ── The distinctive plaintexts we hunt for in the raw file ───────────────────────────────────────
// Each is a unique, high-signal marker string: if ANY of them appears in the file's bytes, that
// column was stored in the clear. They are deliberately weird so a coincidental match is impossible.
const PLAIN = {
  payload: 'PLAINTEXT-PAYLOAD-crankshaft-invoice-77',
  signedCore: 'PLAINTEXT-SIGNEDCORE-crankshaft-invoice-77',
  opLocation: 'PLAINTEXT-OPGPS-minus6point2214',
  noteTitle: 'PLAINTEXT-NOTETITLE-Stok Oli Mesin',
  noteBody: 'PLAINTEXT-NOTEBODY-dua belas krat — ✅ diperiksa',
  salt: 'PLAINTEXTSALTAAAAAAAAAAAAAAAAAAA=',
  hash: 'PLAINTEXTHASHBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA=',
  params: 'PLAINTEXT-KDFPARAMS-19456',
  quarantineJcs: 'PLAINTEXT-QUARANTINEJCS-forged-op-42',
  userName: 'PLAINTEXT-USERNAME-Budi Santoso',
} as const;

interface OpenedDb {
  readonly db: ClientDb;
  readonly file: string;
  readonly dir: string;
}

async function openAt(key: string): Promise<OpenedDb> {
  const dir = mkdtempSync(join(tmpdir(), 'bolusi-at-rest-'));
  const file = join(dir, 'bolusi.db');
  const db = await openClientDb({
    driverFactory: () => Promise.resolve(openFileDriver(file)),
    keyStore: { getDatabaseEncryptionKey: () => Promise.resolve(key) },
    aead: nodeColumnAead,
    name: 'bolusi.db',
    location: dir,
  });
  await runClientMigrations(db.driver, { now: () => 1 });
  return { db, file, dir };
}

let opened: OpenedDb | null = null;

afterEach(async () => {
  await closeClientDb().catch(() => undefined);
  if (opened !== null) rmSync(opened.dir, { recursive: true, force: true });
  opened = null;
});

/** Drive EVERY reachable production writer of a signed-off encrypted column. */
async function writeAllTheSensitiveThings(db: ClientDb): Promise<void> {
  // 1–3. operations.payload / signed_core_jcs / location — the REAL production op-store (05 §1).
  const store = createClientOpStore(db);
  await store.transaction(async (tx) => {
    await tx.insertOp({
      op: {
        id: 'op-1',
        tenantId: 'tenant-1',
        storeId: 'store-1',
        userId: 'user-1',
        deviceId: 'device-1',
        seq: 1,
        type: 'notes.note_created',
        entityType: 'note',
        entityId: 'note-1',
        schemaVersion: 3,
        payload: { marker: PLAIN.payload } as never,
        timestamp: 1_700_000_000_000,
        location: {
          lat: -6.2214,
          lng: 106.8,
          accuracyMeters: 5,
          marker: PLAIN.opLocation,
        } as never,
        source: 'ui',
        agentInitiated: false,
        agentConversationId: null,
        previousHash: '0'.repeat(64),
        hash: '1'.repeat(64),
        signature: 'c2ln',
      },
      signedCoreJcs: `{"marker":"${PLAIN.signedCore}"}`,
    });
  });

  // 4–5. notes.title / notes.body — written through the Kysely builder exactly as a module applier
  // does (04 §4.1). The applier names plain strings; the seam seals them without its knowledge.
  await db.db
    .insertInto('notes')
    .values({
      id: 'note-1',
      tenantId: 'tenant-1',
      storeId: 'store-1',
      title: PLAIN.noteTitle,
      body: PLAIN.noteBody,
      mediaId: null,
      mediaSha256: null,
      mediaMime: null,
      archived: 0,
      editCount: 0,
      createdBy: 'user-1',
      createdAt: 1_700_000_000_000,
      lastEditedBy: 'user-1',
      lastEditedAt: 1_700_000_000_000,
    })
    .execute();

  // 6–8. user_pin_verifiers.salt / .hash / .params — the SEC-AUTH-09 material, via core's real writer.
  const verifier: PinVerifier = {
    algorithm: 'argon2id',
    saltB64: PLAIN.salt,
    mKiB: 32768,
    t: 3,
    p: 1,
    hashB64: PLAIN.hash,
    asOf: { timestamp: 1_700_000_000_000, deviceId: 'device-1', seq: 1 },
  };
  await writeVerifier(db.db, 'user-1', verifier);
  // `params` is JSON built inside writeVerifier; plant our marker via the memory cost so the raw-file
  // hunt has something unique to look for in that column too.
  await writeVerifier(db.db, 'user-2', { ...verifier, mKiB: 19456 });

  // 9. quarantined_ops.signed_core_jcs — core's real quarantine writer (api/01 §4.2).
  await insertQuarantinedOp(db.db, {
    id: 'q-1',
    deviceId: 'device-9',
    serverSeq: 42,
    signedCoreJcs: `{"marker":"${PLAIN.quarantineJcs}"}`,
    hash: '2'.repeat(64),
    signature: 'c2ln',
    reason: 'bad_signature',
    quarantinedAt: 1_700_000_000_000,
  });

  // 10. users_directory.name — employee PII, via core's real directory writer (api/02-auth §5.2).
  await replaceUsersDirectory(db.db, [
    { id: 'user-1', name: PLAIN.userName, photoMediaId: null, status: 'active' },
    { id: 'user-2', name: 'Ani Wijaya', photoMediaId: null, status: 'active' },
  ]);
}

describe('at-rest column encryption — the raw file (D22 addendum 2 signed-off set)', () => {
  test('no signed-off column is stored in the clear, and each is a marked AEAD blob', async () => {
    opened = await openAt(DB_KEY);
    await writeAllTheSensitiveThings(opened.db);
    // Close so WAL is checkpointed into the main file before we read its bytes.
    await closeClientDb();

    const bytes = readFileSync(opened.file);

    // (a) THE LEAK CHECK, enumerated per column. A missed column is a silent PII leak, so every
    //     signed-off value is hunted for individually and named in the failure.
    //
    //     BYTE-EXACT, and that is load-bearing: this hunt used to decode the file with `latin1` and
    //     compare strings, so any needle containing a non-ASCII character — `notes.body` carries an
    //     em-dash and a ✅ — could NEVER match, whether or not the column was sealed. The check for
    //     the single most sensitive free-text column in the set was structurally incapable of going
    //     red (§2.11). Comparing UTF-8 bytes against the raw buffer removes the encoding from the
    //     equation entirely.
    for (const [column, plaintext] of Object.entries(PLAIN)) {
      expect(
        bytes.includes(Buffer.from(plaintext, 'utf8')),
        `${column} was stored in the CLEAR in the raw DB file`,
      ).toBe(false);
    }

    // (b) …and the cells really are OUR ciphertext, not merely absent/empty. Without this, a codec
    //     that wrote NULL over everything would pass (a). Re-open and read the physical cells.
    opened = { ...opened, db: (await reopen(opened.file, opened.dir, DB_KEY)).db };
    const raw = opened.db.driver;
    const cells = [
      ['operations', 'payload'],
      ['operations', 'signed_core_jcs'],
      ['operations', 'location'],
      ['notes', 'title'],
      ['notes', 'body'],
      ['user_pin_verifiers', 'salt'],
      ['user_pin_verifiers', 'hash'],
      ['user_pin_verifiers', 'params'],
      ['quarantined_ops', 'signed_core_jcs'],
      ['users_directory', 'name'],
    ] as const;
    for (const [table, column] of cells) {
      const rows = await raw.execute(
        `SELECT ${column} AS c FROM ${table} WHERE ${column} IS NOT NULL`,
      );
      expect(rows.rows.length, `${table}.${column} had no rows to check`).toBeGreaterThan(0);
      for (const row of rows.rows) {
        expect(
          String(row['c']).startsWith(COLUMN_CIPHER_MARKER),
          `${table}.${column} is not a marked AEAD blob`,
        ).toBe(true);
      }
    }
  });

  test('the plaintext-by-design columns really are still readable (the guarantee is RESHAPED, not total)', async () => {
    opened = await openAt(DB_KEY);
    await writeAllTheSensitiveThings(opened.db);
    await closeClientDb();

    const bytes = readFileSync(opened.file);
    const onDisk = (needle: string): boolean => bytes.includes(Buffer.from(needle, 'utf8'));
    // D22 addendum 2's PLAINTEXT list, asserted so nobody later "improves" this into a whole-file
    // claim the mechanism does not make: ids, hashes and signatures are visible on disk BY DESIGN,
    // and the accepted residual is metadata/activity-shape exposure to forensic extraction.
    expect(onDisk('1'.repeat(64))).toBe(true); // operations.hash
    expect(onDisk('notes.note_created')).toBe(true); // operations.type
    expect(onDisk('bad_signature')).toBe(true); // quarantined_ops.reason
    expect(onDisk('user-1')).toBe(true); // ids / FKs
  });

  test('round-trip is lossless through the real readers — UTF-8, emoji, JSON and JCS included', async () => {
    opened = await openAt(DB_KEY);
    await writeAllTheSensitiveThings(opened.db);

    // Verifier material comes back byte-identical through core's real reader (JSON `params` too).
    const back = await readVerifier(opened.db.db, 'user-1');
    expect(back?.saltB64).toBe(PLAIN.salt);
    expect(back?.hashB64).toBe(PLAIN.hash);
    expect(back?.mKiB).toBe(32768);
    expect(back?.t).toBe(3);

    // Note title/body — the em-dash and ✅ prove the UTF-8 path, not just ASCII.
    const note = await opened.db.db
      .selectFrom('notes')
      .select(['title', 'body'])
      .executeTakeFirstOrThrow();
    expect(note.title).toBe(PLAIN.noteTitle);
    expect(note.body).toBe(PLAIN.noteBody);

    // The verbatim JCS bytes (05 §3) survive — a changed byte here would break a real signature.
    const op = await opened.db.db
      .selectFrom('operations')
      .select(['payload', 'signedCoreJcs', 'location'])
      .executeTakeFirstOrThrow();
    expect(op.signedCoreJcs).toBe(`{"marker":"${PLAIN.signedCore}"}`);
    expect(JSON.parse(op.payload)).toEqual({ marker: PLAIN.payload });
    expect(String(op.location)).toContain(PLAIN.opLocation);
  });

  test('the switcher still lists users in NAME order, now sorted app-side (name is encrypted)', async () => {
    // `users_directory.name` is sealed, so `ORDER BY name` in SQL would sort ciphertext — a stable but
    // MEANINGLESS order, silently. The sort moved into JS (core `listSwitcherUsers`); this is the
    // test that the move preserved the behaviour rather than quietly losing it.
    opened = await openAt(DB_KEY);
    await replaceUsersDirectory(opened.db.db, [
      { id: 'u-z', name: 'Zulkifli', photoMediaId: null, status: 'active' },
      { id: 'u-a', name: 'Andi', photoMediaId: null, status: 'active' },
      { id: 'u-m', name: 'Muhammad', photoMediaId: null, status: 'active' },
      { id: 'u-x', name: 'Deactivated Dave', photoMediaId: null, status: 'deactivated' },
    ]);

    const users = await listSwitcherUsers(opened.db.db);
    expect(users.map((u) => u.name)).toEqual(['Andi', 'Muhammad', 'Zulkifli']);
  });
});

describe('at-rest column encryption — attacker-shaped plaintext cannot steer the write path', () => {
  // THE F1 REGRESSION TEST. `encrypt` once short-circuited on `isCiphertext(plaintext)`, so a
  // plaintext that merely LOOKED sealed was stored verbatim — PII in the clear, plus a permanent
  // read DoS (one poisoned row threw on every later SELECT, bricking the switcher). The value below
  // is a fully legal `notes.body` / `users_directory.name`: the marker plus base64-legal text, which
  // needs no randomness at all. It reaches the device from another enrolled device's signed op or
  // from the server bundle — the in-scope insider path.
  const ATTACKER_SHAPED = `${COLUMN_CIPHER_MARKER}BRIBERYLEDGERkickbackRp250jutaBudiSanto5`;

  test('a plaintext that looks like ciphertext is SEALED, round-trips exactly, and never hits the disk', async () => {
    opened = await openAt(DB_KEY);

    // Seam 1 — the builder/plugin path (`notes.body`).
    await opened.db.db
      .insertInto('notes')
      .values({
        id: 'note-poison',
        tenantId: 'tenant-1',
        storeId: 'store-1',
        title: 'ordinary title',
        body: ATTACKER_SHAPED,
        mediaId: null,
        mediaSha256: null,
        mediaMime: null,
        archived: 0,
        editCount: 0,
        createdBy: 'user-1',
        createdAt: 1,
        lastEditedBy: 'user-1',
        lastEditedAt: 1,
      })
      .execute();

    // Seam 2 — the raw-`sql` / registry path (`users_directory.name`).
    await replaceUsersDirectory(opened.db.db, [
      { id: 'user-1', name: ATTACKER_SHAPED, photoMediaId: null, status: 'active' },
    ]);

    // (a) STORED AS CIPHERTEXT on both seams — not passed through verbatim.
    const rawNote = await opened.db.driver.execute(`SELECT body FROM notes WHERE id='note-poison'`);
    const rawUser = await opened.db.driver.execute(`SELECT name FROM users_directory`);
    expect(rawNote.rows[0]?.['body']).not.toBe(ATTACKER_SHAPED);
    expect(rawUser.rows[0]?.['name']).not.toBe(ATTACKER_SHAPED);
    // A sealed value is strictly longer than its plaintext (nonce+tag+base64), so "still marked" is
    // not enough on its own — length pins that a real envelope was added rather than the input echoed.
    expect(String(rawNote.rows[0]?.['body']).length).toBeGreaterThan(ATTACKER_SHAPED.length);
    expect(String(rawUser.rows[0]?.['name']).length).toBeGreaterThan(ATTACKER_SHAPED.length);

    // (b) ROUND-TRIPS BYTE-IDENTICAL through the real readers — decrypt runs exactly once, so the
    //     marker inside the recovered plaintext is not mistaken for a second envelope.
    const note = await opened.db.db
      .selectFrom('notes')
      .select('body')
      .where('id', '=', 'note-poison')
      .executeTakeFirstOrThrow();
    expect(note.body).toBe(ATTACKER_SHAPED);
    const users = await listSwitcherUsers(opened.db.db);
    expect(users[0]?.name).toBe(ATTACKER_SHAPED);

    // (c) THE SECRET IS NOT IN THE FILE.
    await closeClientDb();
    const bytes = readFileSync(opened.file);
    expect(bytes.includes(Buffer.from('BRIBERYLEDGERkickbackRp250juta', 'utf8'))).toBe(false);
  });
});

describe('at-rest column encryption — the UPDATE seam', () => {
  test('the real note-body-edited applier re-seals on UPDATE, not only on INSERT', async () => {
    // INSERT and UPDATE take DIFFERENT branches of the encrypt transform (a builder INSERT binds a
    // primitive value list; a builder UPDATE binds a ColumnUpdateNode). Only the INSERT branch was
    // covered, so a regression in the UPDATE branch would have shipped a note whose ORIGINAL body was
    // sealed and whose every EDIT landed in the clear — the more likely long-run leak of the two.
    // Driven through the REAL module applier, so this also pins that appliers stay unaware (04 §2).
    opened = await openAt(DB_KEY);
    const edited = 'PLAINTEXT-EDITED-BODY-tiga belas krat — ✅ dihitung ulang';

    await writeAllTheSensitiveThings(opened.db);
    await noteBodyEditedApplier(
      opened.db.db as never,
      {
        id: 'op-2',
        tenantId: 'tenant-1',
        storeId: 'store-1',
        userId: 'user-1',
        deviceId: 'device-1',
        seq: 2,
        type: 'notes.note_body_edited',
        entityType: 'note',
        entityId: 'note-1',
        schemaVersion: 1,
        payload: { body: edited } as never,
        timestamp: 1_700_000_001_000,
        location: null,
        source: 'ui',
        agentInitiated: false,
        agentConversationId: null,
      } as never,
    );

    // The stored cell is a marked blob, and the edited cleartext is not in it…
    const raw = await opened.db.driver.execute(`SELECT body FROM notes WHERE id='note-1'`);
    expect(String(raw.rows[0]?.['body']).startsWith(COLUMN_CIPHER_MARKER)).toBe(true);
    expect(String(raw.rows[0]?.['body'])).not.toContain('tiga belas krat');

    // …it round-trips through the reader…
    const note = await opened.db.db
      .selectFrom('notes')
      .select('body')
      .where('id', '=', 'note-1')
      .executeTakeFirstOrThrow();
    expect(note.body).toBe(edited);

    // …and the edited body never reaches the file in the clear.
    await closeClientDb();
    expect(readFileSync(opened.file).includes(Buffer.from(edited, 'utf8'))).toBe(false);
  });
});

describe('at-rest column encryption — the failure modes', () => {
  test('the WRONG key throws; it never returns garbage and never returns plaintext', async () => {
    opened = await openAt(DB_KEY);
    await writeAllTheSensitiveThings(opened.db);
    await closeClientDb();

    // Re-open the SAME file under a different (valid-shaped) key and read an encrypted column.
    const reopened = await reopen(opened.file, opened.dir, WRONG_KEY);
    opened = { ...opened, db: reopened.db };

    await expect(
      opened.db.db.selectFrom('notes').select(['title', 'body']).execute(),
    ).rejects.toThrow();

    // …and the failure is an AUTHENTICATION failure, not a silent pass-through. Assert the codec
    // directly so the mode is pinned: GCM's tag check must reject, never yield bytes.
    const wrong = new Aes256GcmColumnCipher(keyBytes(WRONG_KEY), nodeColumnAead);
    const right = new Aes256GcmColumnCipher(keyBytes(DB_KEY), nodeColumnAead);
    const sealed = right.encrypt(PLAIN.noteBody);
    expect(() => wrong.decrypt(sealed)).toThrow();
    // The right key still opens it — proving the throw above was the KEY, not a broken blob.
    expect(right.decrypt(sealed)).toBe(PLAIN.noteBody);
  });

  test('tampering with the CIPHERTEXT/TAG region throws — the tag is verified, not just the nonce', () => {
    const cipher = new Aes256GcmColumnCipher(keyBytes(DB_KEY), nodeColumnAead);
    const sealed = cipher.encrypt(PLAIN.noteTitle);
    const body = sealed.slice(COLUMN_CIPHER_MARKER.length);

    // Mutate the LAST base64 character, which lands in the authentication tag — the earlier version
    // of this test read index 10 but rewrote index 0 (the nonce), so it both mis-described what it
    // proved AND was a no-op whenever index 10 already held the replacement character. Substituting
    // deterministically ('A'↔'B') guarantees a real one-character change every run.
    const last = body[body.length - 1];
    const mutated = body.slice(0, -1) + (last === 'A' ? 'B' : 'A');
    expect(mutated).not.toBe(body);
    expect(() => cipher.decrypt(COLUMN_CIPHER_MARKER + mutated)).toThrow();

    // …and the nonce region is authenticated too: GCM binds the IV into the tag.
    const nonceMutated = (body[0] === 'A' ? 'B' : 'A') + body.slice(1);
    expect(() => cipher.decrypt(COLUMN_CIPHER_MARKER + nonceMutated)).toThrow();
  });

  test('VACUUM leaves no stale plaintext after an in-place plaintext→ciphertext conversion', async () => {
    // The migration-3 property, proven directly. Encrypting a column IN PLACE leaves the OLD
    // plaintext in freed pages until VACUUM — a real at-rest leak — so this writes cleartext, converts
    // it, VACUUMs, and hunts the raw file for the original bytes.
    opened = await openAt(DB_KEY);
    const legacy = 'STALE-PLAINTEXT-legacy-note-body-abc123';
    const cipher = new Aes256GcmColumnCipher(keyBytes(DB_KEY), nodeColumnAead);

    // A POPULATED table, written as cleartext straight through the RAW driver (below the encrypt
    // seam) — this is what a pre-encryption device physically looked like. Many rows, not one:
    // converting a SINGLE small row rewrites its page in place and leaves no residue at all, so a
    // one-row version of this test would go green whether or not the VACUUM ran (measured — the
    // failure mode §2.11 calls green-for-the-wrong-reason). A whole-table conversion grows every cell,
    // splits pages and frees the old ones, which is the real migration's shape.
    for (let i = 0; i < 300; i += 1) {
      await opened.db.driver.execute(
        `INSERT INTO notes (id, tenant_id, store_id, title, body, archived, edit_count, created_by, created_at, last_edited_by, last_edited_at)
         VALUES (?, 't', 's', 'legacy-title', ?, 0, 0, 'u', 1, 'u', 1)`,
        [`legacy-${i}`, `${legacy}-${i}`],
      );
    }
    // CHECKPOINT so the cleartext really reaches the main database file. Without this the plaintext
    // would live only in the WAL and the VACUUM below would prove nothing (T-13: interrogate the
    // oracle before believing it).
    await opened.db.driver.execute('PRAGMA wal_checkpoint(TRUNCATE)');
    expect(
      readFileSync(opened.file).includes(Buffer.from(legacy, 'utf8')),
      'setup failed: the cleartext never reached the main DB file, so this test would prove nothing',
    ).toBe(true);

    // Convert every row in place, exactly as a plaintext→ciphertext migration would.
    for (let i = 0; i < 300; i += 1) {
      await opened.db.driver.execute(`UPDATE notes SET body = ? WHERE id = ?`, [
        cipher.encrypt(`${legacy}-${i}`),
        `legacy-${i}`,
      ]);
    }
    await opened.db.driver.execute('PRAGMA wal_checkpoint(TRUNCATE)');

    // THE LEAK, DEMONSTRATED: every row now reads as ciphertext, yet the OLD cleartext is still
    // physically present in the file's freed space. This is precisely why the migration must VACUUM —
    // and this assertion is what stops the one below from passing for the wrong reason.
    expect(readFileSync(opened.file).includes(Buffer.from(legacy, 'utf8'))).toBe(true);

    await opened.db.driver.execute('VACUUM');
    await closeClientDb();

    // …and gone once the file is rewritten.
    expect(readFileSync(opened.file).includes(Buffer.from(legacy, 'utf8'))).toBe(false);
  });
});

/** Re-open the same file under `key`, running no migrations (the schema is already there). */
async function reopen(file: string, dir: string, key: string): Promise<{ db: ClientDb }> {
  const db = await openClientDb({
    driverFactory: () => Promise.resolve(openFileDriver(file)),
    keyStore: { getDatabaseEncryptionKey: () => Promise.resolve(key) },
    aead: nodeColumnAead,
    name: 'bolusi.db',
    location: dir,
  });
  return { db };
}
