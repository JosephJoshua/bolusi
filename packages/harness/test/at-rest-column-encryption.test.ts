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
    const text = bytes.toString('latin1');

    // (a) THE LEAK CHECK, enumerated per column. A missed column is a silent PII leak, so every
    //     signed-off value is hunted for individually and named in the failure.
    for (const [column, plaintext] of Object.entries(PLAIN)) {
      expect(text.includes(plaintext), `${column} was stored in the CLEAR in the raw DB file`).toBe(
        false,
      );
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

    const text = readFileSync(opened.file).toString('latin1');
    // D22 addendum 2's PLAINTEXT list, asserted so nobody later "improves" this into a whole-file
    // claim the mechanism does not make: ids, hashes and signatures are visible on disk BY DESIGN,
    // and the accepted residual is metadata/activity-shape exposure to forensic extraction.
    expect(text).toContain('1'.repeat(64)); // operations.hash
    expect(text).toContain('notes.note_created'); // operations.type
    expect(text).toContain('bad_signature'); // quarantined_ops.reason
    expect(text).toContain('user-1'); // ids / FKs
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

  test('a tampered blob throws — the tag is checked, not just the nonce', async () => {
    const cipher = new Aes256GcmColumnCipher(keyBytes(DB_KEY), nodeColumnAead);
    const sealed = cipher.encrypt(PLAIN.noteTitle);
    // Flip one character of the base64 body (after the marker) — GCM must refuse it.
    const marker = COLUMN_CIPHER_MARKER;
    const body = sealed.slice(marker.length);
    const flipped = (body[10] === 'A' ? 'B' : 'A') + body.slice(1);
    expect(() => cipher.decrypt(marker + flipped)).toThrow();
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
      readFileSync(opened.file).toString('latin1').includes(legacy),
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
    expect(readFileSync(opened.file).toString('latin1')).toContain(legacy);

    await opened.db.driver.execute('VACUUM');
    await closeClientDb();

    // …and gone once the file is rewritten.
    expect(readFileSync(opened.file).toString('latin1')).not.toContain(legacy);
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
