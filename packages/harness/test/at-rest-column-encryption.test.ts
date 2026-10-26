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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  drainPendingVerifiers,
  enqueuePendingVerifier,
  insertOpLogRow,
  insertQuarantinedOp,
  listSwitcherUsers,
  operationFromSignedCoreJcs,
  readEntityOps,
  readPendingVerifiers,
  readVerifier,
  replaceUsersDirectory,
  SIGNED_CORE_SEAL,
  writeVerifier,
  type PendingVerifier,
  type PinVerifier,
  type PinVerifierUploadPort,
} from '@bolusi/core';
import {
  Aes256GcmColumnCipher,
  COLUMN_CIPHER_SCHEME_PREFIX,
  COMPRESSED_COLUMN_CIPHER_SCHEME_PREFIX,
  closeClientDb,
  createClientOpStore,
  openClientDb,
  runClientMigrations,
  type ClientDb,
} from '@bolusi/db-client';
import { noteBodyEditedApplier } from '@bolusi/modules/notes';
import { repairModule } from '@bolusi/modules/repair';
import type { SignedOperation } from '@bolusi/schemas';
import { nodeColumnAead, opRowOf } from '@bolusi/test-support';

import { openFileDriver } from '@bolusi/sqlite-test-driver';

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
  opLocation: 'PLAINTEXT-OPGPS-minus6point2214',
  pulledPayload: 'PLAINTEXT-PULLEDPAYLOAD-gearbox-receipt-31',
  noteTitle: 'PLAINTEXT-NOTETITLE-Stok Oli Mesin',
  noteBody: 'PLAINTEXT-NOTEBODY-dua belas krat — ✅ diperiksa',
  salt: 'PLAINTEXTSALTAAAAAAAAAAAAAAAAAAA=',
  hash: 'PLAINTEXTHASHBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA=',
  params: 'PLAINTEXT-KDFPARAMS-19456',
  quarantineJcs: 'PLAINTEXT-QUARANTINEJCS-forged-op-42',
  userName: 'PLAINTEXT-USERNAME-Budi Santoso',
  pendingSalt: 'PLAINTEXTPENDINGSALTCCCCCCCCCCCC=',
  pendingHash: 'PLAINTEXTPENDINGHASHDDDDDDDDDDDDDDDDDDDDDDDA=',
} as const;

/** An owner's offline PIN reset, still waiting to be uploaded. */
const PENDING: PendingVerifier = {
  userId: 'user-2',
  actorUserId: 'user-1',
  verifierRef: 'ref-1',
  verifier: {
    algorithm: 'argon2id',
    saltB64: PLAIN.pendingSalt,
    mKiB: 19456,
    t: 2,
    p: 1,
    hashB64: PLAIN.pendingHash,
    asOf: { timestamp: 1_700_000_000_500, deviceId: 'device-1', seq: 7 },
  },
};

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

/**
 * An op whose payload and location carry plaintext markers. Since client migration 6 the signed text
 * is their only stored copy, so it is the real canonical text, as a production writer stores it.
 */
const LOCAL_OP: SignedOperation = {
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
};

const PULLED_OP: SignedOperation = {
  ...LOCAL_OP,
  id: 'op-2',
  deviceId: 'device-2',
  payload: { marker: PLAIN.pulledPayload } as never,
  location: null,
};

/** Drive EVERY reachable production writer of a signed-off encrypted column. */
async function writeAllTheSensitiveThings(db: ClientDb): Promise<void> {
  // 1. operations.signed_core_jcs (which holds the payload and location) — the REAL production
  //    op-store (05 §1), and the pull's raw-`sql` writer.
  const store = createClientOpStore(db);
  await store.transaction(async (tx) => {
    await tx.insertOp(opRowOf(LOCAL_OP));
  });
  await insertOpLogRow(db.db, opRowOf(PULLED_OP), {
    syncStatus: 'synced',
    syncedAt: 1_700_000_000_000,
    arrivalSeq: 1,
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
  // The same material waiting for its upload (client migration 14), via core's real queue writer.
  await enqueuePendingVerifier(db.db, PENDING);

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
    // The op log's signed text is sealed compressed (`SIGNED_CORE_SEAL`); everything else is not.
    const cells = [
      ['operations', 'signed_core_jcs', COMPRESSED_COLUMN_CIPHER_SCHEME_PREFIX],
      ['notes', 'title', COLUMN_CIPHER_SCHEME_PREFIX],
      ['notes', 'body', COLUMN_CIPHER_SCHEME_PREFIX],
      ['user_pin_verifiers', 'salt', COLUMN_CIPHER_SCHEME_PREFIX],
      ['user_pin_verifiers', 'hash', COLUMN_CIPHER_SCHEME_PREFIX],
      ['user_pin_verifiers', 'params', COLUMN_CIPHER_SCHEME_PREFIX],
      ['pending_pin_verifiers', 'salt', COLUMN_CIPHER_SCHEME_PREFIX],
      ['pending_pin_verifiers', 'hash', COLUMN_CIPHER_SCHEME_PREFIX],
      ['pending_pin_verifiers', 'params', COLUMN_CIPHER_SCHEME_PREFIX],
      ['quarantined_ops', 'signed_core_jcs', COMPRESSED_COLUMN_CIPHER_SCHEME_PREFIX],
      ['users_directory', 'name', COLUMN_CIPHER_SCHEME_PREFIX],
    ] as const;
    for (const [table, column, prefix] of cells) {
      const rows = await raw.execute(
        `SELECT ${column} AS c FROM ${table} WHERE ${column} IS NOT NULL`,
      );
      expect(rows.rows.length, `${table}.${column} had no rows to check`).toBeGreaterThan(0);
      for (const row of rows.rows) {
        expect(
          String(row['c']).startsWith(prefix),
          `${table}.${column} is not a marked AEAD blob of the expected scheme`,
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
    // Both writers' rows, decompressed and opened, are the canonical text they were given, and the
    // payload and location come back out of it.
    const ops = await opened.db.db
      .selectFrom('operations')
      .select(['signedCoreJcs', 'hash', 'signature'])
      .orderBy('id')
      .execute();
    expect(ops.map((op) => op.signedCoreJcs)).toEqual([
      opRowOf(LOCAL_OP).signedCoreJcs,
      opRowOf(PULLED_OP).signedCoreJcs,
    ]);
    const local = operationFromSignedCoreJcs(ops[0]!.signedCoreJcs, ops[0]!);
    expect(local.payload).toEqual({ marker: PLAIN.payload });
    expect(JSON.stringify(local.location)).toContain(PLAIN.opLocation);
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
  const ATTACKER_SHAPED = `${COLUMN_CIPHER_SCHEME_PREFIX}BRIBERYLEDGERkickbackRp250jutaBudiSanto5`;

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
    // SOFT so BOTH seams are demonstrated independently on a failure. With hard assertions the first
    // one aborts the test and the second seam is never evaluated — so a regression in only the
    // registry seam would be reported as "the builder seam failed", pointing at the wrong code.
    expect.soft(rawNote.rows[0]?.['body']).not.toBe(ATTACKER_SHAPED);
    expect.soft(rawUser.rows[0]?.['name']).not.toBe(ATTACKER_SHAPED);
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

describe('at-rest column encryption — a forged marker in a PLAINTEXT column is inert', () => {
  // F7. The marker used to be a FIXED string, so anyone could write it. `operations
  // .agent_conversation_id` is plaintext BY DESIGN (correctly — it is not PII), it rides the SIGNED
  // envelope as an unbounded `z.string().nullable()` (schemas/envelope.ts), and the projection fold
  // selects it (`OP_COLUMNS`, read by every re-fold). So a second enrolled device could sign an op
  // whose conversation id merely LOOKED sealed, the server would accept it, it would sync to every
  // device in the store, and the read seam would try to decrypt it and THROW — permanently breaking
  // `runRebuild` for that module on every device, in an APPEND-ONLY table where the row cannot be
  // deleted without breaking the hash chain. No key, no randomness, no server compromise.
  //
  // The attacker constructs the prefix LITERALLY here — they do not import our constant — which is
  // the whole point: after the fix the marker carries a key-derived tag they cannot compute.
  const FORGED = `${String.fromCharCode(1)}gcm1:${'A'.repeat(40)}`;

  test('a signed op carrying a marker-shaped conversation id does not break the projection fold', async () => {
    opened = await openAt(DB_KEY);

    await insertOpLogRow(
      opened.db.db,
      opRowOf({
        ...LOCAL_OP,
        id: 'op-forged',
        entityId: 'n1',
        payload: {} as never,
        location: null,
        agentConversationId: FORGED,
      }),
      { syncStatus: 'synced', syncedAt: 1, arrivalSeq: 1 },
    );

    // The column is plaintext by design — it is stored verbatim, and that is CORRECT.
    const raw = await opened.db.driver.execute(
      `SELECT agent_conversation_id AS c FROM operations WHERE id='op-forged'`,
    );
    expect(raw.rows[0]?.['c']).toBe(FORGED);

    // THE ASSERTION THAT MATTERS: the real projection reader must survive it. Before the keyed
    // marker this threw "Unsupported state or unable to authenticate data" and took every future
    // rebuild of the module with it.
    const page = await readEntityOps(opened.db.db, LOCAL_OP.entityType, 'n1');
    expect(page).toHaveLength(1);
    expect(page[0]?.agentConversationId).toBe(FORGED);
  });

  test('the marker is STABLE across a reopen — existing sealed rows stay readable', async () => {
    // THE WAY THE KEYED MARKER COULD GO BADLY WRONG. The suffix must be derived from the KEY, not
    // minted per connection: a per-connection random tag would still pass every same-session test,
    // and then every row written by a previous run would stop matching the marker and read back as
    // opaque envelope text — silent, total data loss on the second launch. This asserts the property
    // directly: seal, close, reopen with the SAME key, read.
    opened = await openAt(DB_KEY);
    await replaceUsersDirectory(opened.db.db, [
      { id: 'u-1', name: PLAIN.userName, photoMediaId: null, status: 'active' },
    ]);
    const markerBefore = new Aes256GcmColumnCipher(keyBytes(DB_KEY), nodeColumnAead).marker;
    await closeClientDb();

    const again = await reopen(opened.file, opened.dir, DB_KEY);
    opened = { ...opened, db: again.db };
    const users = await listSwitcherUsers(opened.db.db);
    expect(users[0]?.name).toBe(PLAIN.userName);

    // …and the marker itself is a pure function of the key, so a third construction agrees.
    expect(new Aes256GcmColumnCipher(keyBytes(DB_KEY), nodeColumnAead).marker).toBe(markerBefore);

    // ⚠️ THIS NEXT LINE IS THE ONLY GUARD ON THE KEYING PROPERTY — DO NOT WEAKEN IT.
    // The forged-marker test above does NOT cover it: its literal 40-'A' forgery happens not to
    // collide with a constant-suffix marker like `gcm1:AAAAAAAAAAAA:`, so that test still passes even
    // if the suffix stops depending on the key. Anyone citing F7 as evidence that the marker is keyed
    // is citing the wrong test. A DIFFERENT key must derive a DIFFERENT marker — that is what makes
    // the marker unforgeable by someone who does not hold this device's key.
    expect(new Aes256GcmColumnCipher(keyBytes(WRONG_KEY), nodeColumnAead).marker).not.toBe(
      markerBefore,
    );
  });

  test('a genuinely sealed value still round-trips beside it (the fix is not "decrypt nothing")', async () => {
    opened = await openAt(DB_KEY);
    await opened.db.db
      .insertInto('notes')
      .values({
        id: 'note-real',
        tenantId: 't',
        storeId: 's',
        title: 'real title',
        body: PLAIN.noteBody,
        mediaId: null,
        mediaSha256: null,
        mediaMime: null,
        archived: 0,
        editCount: 0,
        createdBy: 'u',
        createdAt: 1,
        lastEditedBy: 'u',
        lastEditedAt: 1,
      })
      .execute();

    const note = await opened.db.db.selectFrom('notes').select('body').executeTakeFirstOrThrow();
    expect(note.body).toBe(PLAIN.noteBody);
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
    expect(String(raw.rows[0]?.['body']).startsWith(COLUMN_CIPHER_SCHEME_PREFIX)).toBe(true);
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
  test('the WRONG key never yields plaintext — the value stays sealed and the codec refuses it', async () => {
    opened = await openAt(DB_KEY);
    await writeAllTheSensitiveThings(opened.db);
    await closeClientDb();

    // Re-open the SAME file under a different (valid-shaped) key and read an encrypted column.
    const reopened = await reopen(opened.file, opened.dir, WRONG_KEY);
    opened = { ...opened, db: reopened.db };
    const rows = await opened.db.db.selectFrom('notes').select(['title', 'body']).execute();

    // THE SECURITY PROPERTY, UNCHANGED: no plaintext comes back. The bytes are still ciphertext.
    expect(rows[0]?.title).not.toBe(PLAIN.noteTitle);
    expect(rows[0]?.body).not.toBe(PLAIN.noteBody);
    expect(String(rows[0]?.body).startsWith(COLUMN_CIPHER_SCHEME_PREFIX)).toBe(true);

    // THE BEHAVIOUR THAT CHANGED, ASSERTED RATHER THAN GLOSSED: because the marker is now keyed,
    // rows sealed under a different key no longer match this cipher's marker, so the read seam does
    // not claim them and they surface as OPAQUE ENVELOPE TEXT instead of throwing. That is the price
    // of making the marker unforgeable (F7) — and it is not a disclosure. It does mean the codec can
    // no longer detect a restored foreign database by itself; catching that belongs at boot, against
    // a stored key tag, which is task 160's boot probe.
    const wrong = new Aes256GcmColumnCipher(keyBytes(WRONG_KEY), nodeColumnAead);
    const right = new Aes256GcmColumnCipher(keyBytes(DB_KEY), nodeColumnAead);
    const sealed = right.encrypt(PLAIN.noteBody);
    // The codec itself still REFUSES a foreign value outright rather than returning bytes…
    expect(() => wrong.decrypt(sealed)).toThrow();
    expect(wrong.isCiphertext(sealed)).toBe(false);
    // …and the right key still opens it, proving the refusal was the KEY, not a broken blob.
    expect(right.decrypt(sealed)).toBe(PLAIN.noteBody);

    // A TAMPERED value under the CORRECT key still throws — GCM's tag is untouched by this change.
    const flipped = sealed.slice(0, -1) + (sealed.slice(-1) === 'A' ? 'B' : 'A');
    expect(() => right.decrypt(flipped)).toThrow();
  });

  test('tampering with the CIPHERTEXT/TAG region throws — the tag is verified, not just the nonce', () => {
    const cipher = new Aes256GcmColumnCipher(keyBytes(DB_KEY), nodeColumnAead);
    const sealed = cipher.encrypt(PLAIN.noteTitle);
    const body = sealed.slice(COLUMN_CIPHER_SCHEME_PREFIX.length);

    // Mutate the LAST base64 character, which lands in the authentication tag — the earlier version
    // of this test read index 10 but rewrote index 0 (the nonce), so it both mis-described what it
    // proved AND was a no-op whenever index 10 already held the replacement character. Substituting
    // deterministically ('A'↔'B') guarantees a real one-character change every run.
    const last = body[body.length - 1];
    const mutated = body.slice(0, -1) + (last === 'A' ? 'B' : 'A');
    expect(mutated).not.toBe(body);
    expect(() => cipher.decrypt(COLUMN_CIPHER_SCHEME_PREFIX + mutated)).toThrow();

    // …and the nonce region is authenticated too: GCM binds the IV into the tag.
    const nonceMutated = (body[0] === 'A' ? 'B' : 'A') + body.slice(1);
    expect(() => cipher.decrypt(COLUMN_CIPHER_SCHEME_PREFIX + nonceMutated)).toThrow();
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

describe('column cipher — compressed seal (the op log)', () => {
  const cipher = new Aes256GcmColumnCipher(keyBytes(DB_KEY), nodeColumnAead);
  const jcs = opRowOf(LOCAL_OP).signedCoreJcs;

  test('round-trips byte-identically, including empty and non-ASCII text', () => {
    for (const text of [jcs, '', 'Yohanis Wenda — layar retak ✓ 漢字', jcs.repeat(50)]) {
      const sealed = cipher.encrypt(text, SIGNED_CORE_SEAL);
      expect(sealed.startsWith(COMPRESSED_COLUMN_CIPHER_SCHEME_PREFIX)).toBe(true);
      expect(cipher.isCiphertext(sealed)).toBe(true);
      expect(cipher.decrypt(sealed)).toBe(text);
    }
  });

  test('a plain seal is unchanged by the option existing, and both kinds decrypt', () => {
    const plain = cipher.encrypt(jcs);
    expect(plain.startsWith(COLUMN_CIPHER_SCHEME_PREFIX)).toBe(true);
    expect(cipher.decrypt(plain)).toBe(jcs);
    expect(cipher.encrypt(jcs, {}).startsWith(COLUMN_CIPHER_SCHEME_PREFIX)).toBe(true);
  });

  test('a real signed core shrinks well below its plain seal', () => {
    const compressed = cipher.encrypt(jcs, SIGNED_CORE_SEAL).length;
    const plain = cipher.encrypt(jcs).length;
    expect(compressed).toBeLessThan(plain * 0.7);
  });

  test('tampering is caught by GCM before anything is inflated', () => {
    const sealed = cipher.encrypt(jcs, SIGNED_CORE_SEAL);
    const flipped = sealed.slice(0, -1) + (sealed.slice(-1) === 'A' ? 'B' : 'A');
    expect(() => cipher.decrypt(flipped)).toThrow();
  });

  test('relabelling the scheme prefix never yields the original text', () => {
    // The prefix sits outside the GCM seal, so someone who can write the file can swap it. That gains
    // nothing: the value either fails to open or reads as garbage, and a reader parsing the signed
    // core then fails loudly. (Anyone who can write the file can already delete rows outright.)
    const readAs = (value: string, from: string, to: string): string | Error => {
      try {
        return cipher.decrypt(to + value.slice(from.length));
      } catch (error) {
        return error as Error;
      }
    };
    const compressed = cipher.encrypt(jcs, SIGNED_CORE_SEAL);
    const plain = cipher.encrypt(jcs);
    expect(
      readAs(compressed, COMPRESSED_COLUMN_CIPHER_SCHEME_PREFIX, COLUMN_CIPHER_SCHEME_PREFIX),
    ).not.toBe(jcs);
    expect(
      readAs(plain, COLUMN_CIPHER_SCHEME_PREFIX, COMPRESSED_COLUMN_CIPHER_SCHEME_PREFIX),
    ).not.toBe(jcs);
  });

  test('another key neither recognises nor opens a compressed value', () => {
    const sealed = cipher.encrypt(jcs, SIGNED_CORE_SEAL);
    const wrong = new Aes256GcmColumnCipher(keyBytes(WRONG_KEY), nodeColumnAead);
    expect(wrong.isCiphertext(sealed)).toBe(false);
    expect(() => wrong.decrypt(sealed)).toThrow();
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

describe('queued PIN verifier uploads survive an app restart', () => {
  test('a verifier queued before the app died is read back intact and drained after reopening', async () => {
    opened = await openAt(DB_KEY);
    await enqueuePendingVerifier(opened.db.db, PENDING);
    // The app is killed: nothing in memory survives, only the file.
    await closeClientDb();

    opened = { ...opened, db: (await reopen(opened.file, opened.dir, DB_KEY)).db };
    expect(await readPendingVerifiers(opened.db.db)).toEqual([PENDING]);

    const sent: unknown[][] = [];
    const server: PinVerifierUploadPort = {
      upload: (...args) => {
        sent.push(args);
        return Promise.resolve({ userId: args[0], applied: true });
      },
    };
    await drainPendingVerifiers(opened.db.db, server);
    // The reset is sent as the owner who made it, for the user it targets.
    expect(sent).toEqual([['user-2', 'ref-1', PENDING.verifier, 'user-1']]);
    expect(await readPendingVerifiers(opened.db.db)).toEqual([]);

    // Once applied it is gone for good, across another restart too.
    await closeClientDb();
    opened = { ...opened, db: (await reopen(opened.file, opened.dir, DB_KEY)).db };
    expect(await readPendingVerifiers(opened.db.db)).toEqual([]);
  });
});

describe('at-rest column encryption — repair customer data', () => {
  test('customer name/phone, device passcode and event notes are sealed by the real repair appliers', async () => {
    opened = await openAt(DB_KEY);
    const secret = {
      name: 'PLAINTEXT-CUSTOMER-Yohanis Wenda',
      phone: 'PLAINTEXT-PHONE-081244556677',
      corrected: 'PLAINTEXT-CORRECTED-Yohanes Wenda',
      passcode: 'PLAINTEXT-PASSCODE-pola Z 2580',
      note: 'PLAINTEXT-NOTE-tunggu LCD dari Jayapura',
      complaint: 'PLAINTEXT-COMPLAINT-layar retak kena air',
    };
    const base = {
      tenantId: '01920000-0000-7000-8000-0000000a0001',
      storeId: '01920000-0000-7000-8000-0000000a0002',
      userId: '01920000-0000-7000-8000-0000000e000a',
      deviceId: '01920000-0000-7000-8000-0000000d000a',
      schemaVersion: 1,
      location: null,
      source: 'ui',
      agentInitiated: false,
      agentConversationId: null,
    };
    const customerId = '01920000-0000-7000-8000-0000000c0001';
    const ticketId = '01920000-0000-7000-8000-0000000c0002';
    const photo = (n: number) => ({
      mediaId: `01920000-0000-7000-8000-00000000f00${n}`,
      sha256: 'a'.repeat(64),
      mime: 'image/jpeg',
      type: 'image',
      sizeBytes: 1000,
      capturedAt: 1,
      location: null,
      userId: base.userId,
      deviceId: base.deviceId,
    });
    const apply = (
      type: string,
      entityType: string,
      entityId: string,
      seq: number,
      payload: object,
    ) =>
      repairModule.operations[type]!.apply(
        opened!.db.db as never,
        {
          ...base,
          id: `01920000-0000-7000-8000-0000000b000${seq}`,
          seq,
          type,
          entityType,
          entityId,
          payload,
          timestamp: 1_700_000_000_000 + seq,
        } as never,
      );

    await apply('repair.customer_registered', 'repair_customer', customerId, 1, {
      name: secret.name,
      phone: secret.phone,
    });
    await apply('repair.customer_details_corrected', 'repair_customer', customerId, 2, {
      name: secret.corrected,
      phone: secret.phone,
    });
    await apply('repair.ticket_opened', 'repair_ticket', ticketId, 3, {
      ticketNumber: 'K7Q-0001',
      customerId,
      device: { brand: 'Samsung', model: 'A14', color: '', imei: null, passcode: secret.passcode },
      complaint: secret.complaint,
      intakeNotes: '',
      checklist: [],
      peripherals: [],
      estimatedReadyAt: null,
      quoteLines: [
        {
          lineId: '01920000-0000-7000-8000-0000000c0003',
          kind: 'part',
          description: 'LCD',
          amount: 1,
        },
      ],
      photos: {
        front: photo(1),
        back: photo(2),
        left: photo(3),
        right: photo(4),
        top: photo(5),
        bottom: photo(6),
      },
    });
    await apply('repair.work_paused', 'repair_ticket', ticketId, 4, { note: secret.note });

    const customer = await opened.db.db
      .selectFrom('repairCustomers')
      .select(['name', 'phone'])
      .executeTakeFirstOrThrow();
    expect(customer).toEqual({ name: secret.corrected, phone: secret.phone });

    await closeClientDb();
    const bytes = readFileSync(opened.file);
    for (const [column, plaintext] of Object.entries(secret)) {
      expect(bytes.includes(Buffer.from(plaintext, 'utf8')), `${column} stored in the clear`).toBe(
        false,
      );
    }
  });
});
