// The on-device seams for SEC-DEV-06's at-rest gate (task 178 — the second half of 27a's emulator
// correctness lane; testing-guide T-14b, security-guide §6.5, 10-db §9.7).
//
// `runAtRestGate` (at-rest-device-ctx.ts) is built and Node-proven; what was unbuilt is the
// `AtRestDeviceEnv` it consumes — the thing that actually SEEDS a real device DB. This file builds it.
//
// ── WHAT IT DRIVES, AND WHY THROUGH THE REAL WRITERS (T-16 / T-13) ──────────────────────────────
// The coverage half of the gate (`checkDbAtRestIsCiphertext`) is ALL-OR-NOTHING: every one of the 11
// signed-off columns must be observed with a non-null SEALED cell, or the gate reds. So the seed must
// drive EVERY real production writer of an encrypted column — not hand-INSERT sealed bytes, which
// would prove only that the test can seal (T-13). Traced to producers (T-16):
//   operations.payload/signed_core_jcs/location  → the real op-store (`createClientOpStore.insertOp`)
//   notes.title/body                              → the module-applier builder INSERT (04 §4.1)
//   user_pin_verifiers.salt/hash/params           → core `writeVerifier` (SEC-AUTH-09 material)
//   quarantined_ops.signed_core_jcs               → core `insertQuarantinedOp` (a rejected op)
//   users_directory.name                          → core `replaceUsersDirectory` (a user sync)
//   media_items.location                          → apps/mobile `insertMediaItem` (a media attach)
// Each writer seals through the SAME production cipher — the builder plugin for op-store/notes, the
// `encryptColumnValue` registry seam for the five raw-`sql` writers — so a green here is the PRODUCTION
// seal, exactly as `packages/harness/test/at-rest-column-encryption.test.ts` proves on Node.
//
// ── PLATFORM-AGNOSTIC BY CONSTRUCTION (so the seed+coverage logic is host-provable) ─────────────
// This file imports NO op-sqlite and NO expo-file-system: the DB driver, the AEAD primitive, and the
// three filesystem operations are INJECTED as `AtRestDeviceSeams`. On device, run-and-emit.ts binds
// op-sqlite + `deviceColumnAead` + expo-file-system (the one place that may). In CI, the host test
// binds better-sqlite3 + `nodeColumnAead` + `node:fs`, which is what lets vitest prove the seed
// populates all 11 columns and that the coverage check reds when one is missing — as far as op-sqlite
// allows off-device. The op-sqlite path + the real file bytes are the only emulator-only residual.
import { CamelCasePlugin, Kysely } from 'kysely';

import {
  createClientOpStore,
  runClientMigrations,
  createClientDialect,
  CLIENT_PRAGMAS,
  COLUMN_CIPHER_SCHEME_PREFIX,
  openClientDb,
  type AeadCipher,
  type ClientDb,
  type DbDriver,
  type DbDriverFactory,
  type ClientDatabase,
} from '@bolusi/db-client';
import {
  insertQuarantinedOp,
  replaceUsersDirectory,
  writeVerifier,
  type PinVerifier,
} from '@bolusi/core';
import {
  AT_REST_ENCRYPTED_COLUMNS,
  type AtRestProbeContext,
  type SealedCell,
} from '@bolusi/test-support/device';

import { insertMediaItem } from '../../media/queue.js';
import type { AtRestDeviceEnv } from './at-rest-device-ctx.js';

/** `"table.column"` — the key the coverage check names a missing column by. */
type ColumnKey = string;
const columnKey = (table: string, column: string): ColumnKey => `${table}.${column}`;

/** An in-bounds ([19456,65536]) but distinctive argon2 memory cost; its JSON fragment `"mKiB":51966`
 * (quotes+colon are non-base64) is the params-column marker. */
const PARAMS_MKIB = 51966;
/** A high-precision GPS latitude; its string form `-6.2214987654321` carries `.`/`-` (non-base64). */
const MEDIA_LAT = -6.2214987654321;

/**
 * ONE distinctive plaintext per signed-off column: findable in the CLEAR (the control), and whose
 * ABSENCE from the encrypted file is what the leak check proves. Every one contains a non-base64
 * character (`-`, space, `.`, `"`, `:`), so it CANNOT hide inside a base64 AEAD blob — a false "leak"
 * from a coincidental match in ciphertext is impossible. The two numeric columns (params, media
 * location) still get non-base64 markers by construction: a JSON fragment and a float string.
 *
 * `plaintextMarkers` is derived from the columns actually SEEDED, so a skipped column drops its marker
 * from both the leak hunt and the control witness — which is why skipping a column reds the COVERAGE
 * check (`checkDbAtRestIsCiphertext` enumerates all 11 independently) rather than the control.
 */
const COLUMN_MARKERS: Readonly<Record<ColumnKey, string>> = {
  'operations.payload': 'BOLUSI-ATREST-payload-krankas-invoice-77',
  'operations.signed_core_jcs': 'BOLUSI-ATREST-signedcore-krankas-invoice-77',
  'operations.location': 'BOLUSI-ATREST-opgps-jakarta-selatan',
  'notes.title': 'BOLUSI-ATREST-notetitle-Stok Oli Mesin',
  'notes.body': 'BOLUSI-ATREST-notebody-dua belas krat diperiksa',
  'user_pin_verifiers.salt': 'BOLUSI-ATREST-salt-krankas-verifier',
  'user_pin_verifiers.hash': 'BOLUSI-ATREST-hash-krankas-verifier',
  'user_pin_verifiers.params': `"mKiB":${PARAMS_MKIB}`,
  'quarantined_ops.signed_core_jcs': 'BOLUSI-ATREST-quarantinejcs-forged-op-42',
  'users_directory.name': 'BOLUSI-ATREST-username-Budi Santoso',
  'media_items.location': String(MEDIA_LAT),
};

/** The marker for a column, or `''` if unmapped (never happens for the 11 signed-off columns). */
const markerFor = (table: string, column: string): string =>
  COLUMN_MARKERS[columnKey(table, column)] ?? '';

/**
 * The platform primitives the at-rest seed needs, INJECTED so this file stays free of op-sqlite and
 * expo-file-system. Everything is keyed by the DB's LOGICAL name — the seam owns the physical path
 * semantics (op-sqlite's `<location>/<name>` vs better-sqlite3's file path), so this orchestration
 * never touches a raw path. On device these are op-sqlite + `deviceColumnAead` + expo-file-system; in
 * CI they are better-sqlite3 + `nodeColumnAead` + node:fs — which is what makes the seed + coverage
 * host-provable, leaving only the real op-sqlite bytes as the emulator-only residual.
 */
export interface AtRestDeviceSeams {
  /** The AES-256-GCM primitive backing the production column cipher (deviceColumnAead / nodeColumnAead). */
  readonly aead: AeadCipher;
  /** Opens a DB driver for `{ name, location }` — op-sqlite on device, better-sqlite3 in CI. */
  readonly driverFactory: DbDriverFactory;
  /** The directory/location handed to `driverFactory` for every DB (a dir on device; a tmp dir in CI). */
  readonly location: string | undefined;
  /** Raw bytes of the (closed) DB file named `name` — its physical bytes, read below the app layer. */
  readBytesOf(name: string): Promise<Uint8Array>;
  /** Copy the DB file `srcName` → `dstName` (the probe reads a copy, never the live file — 08 §2.2). */
  copyDbFile(srcName: string, dstName: string): Promise<void>;
  /** Best-effort delete of the DB file `name` + its WAL/SHM sidecars, so each seed starts clean. */
  removeDb(name: string): Promise<void>;
}

/** The transactional surface both connections expose to the shared seed (op-store needs both halves). */
interface SeedTarget {
  readonly db: Kysely<ClientDatabase>;
  readonly driver: Pick<DbDriver, 'begin' | 'commit' | 'rollback'>;
}

/** A logical DB name unique to this gate — never the production `bolusi.db`, so it can be freely
 * wiped and cannot collide with the app's one connection (which HarnessActivity never opens anyway). */
const ENCRYPTED_DB = 'bolusi-harness-atrest.db';
const CONTROL_DB = 'bolusi-harness-atrest-control.db';
const PROBE_COPY = 'bolusi-harness-atrest-copy.db';

/** An obviously-fake 32-byte key (64 hex) — the seal is key-independent, so a throwaway key is
 * correct here; the gate proves the MECHANISM seals, not any particular device key. */
const HARNESS_DB_KEY = 'a'.repeat(64);

/**
 * Drive EVERY reachable production writer of a signed-off encrypted column against `target`. When the
 * connection carries the cipher (the encrypted DB) each value is sealed; when it does not (the control)
 * each is written in the clear — same writers, same markers, so the control is a faithful T-14b witness.
 *
 * `skip` exists ONLY so the falsification host-test can watch the coverage check go red: skipping a
 * column drops the writer that produces it, and `checkDbAtRestIsCiphertext` (which independently
 * enumerates all 11 columns) then reds naming the gap. Production seeds ALL 11 (empty skip).
 */
async function seedAllColumns(target: SeedTarget, skip: ReadonlySet<ColumnKey>): Promise<void> {
  const run = (...columns: ColumnKey[]): boolean => columns.every((c) => !skip.has(c));

  // operations.payload / signed_core_jcs / location — the REAL production op-store (05 §1).
  if (run('operations.payload', 'operations.signed_core_jcs', 'operations.location')) {
    const store = createClientOpStore(target);
    await store.transaction(async (tx) => {
      await tx.insertOp({
        op: {
          id: 'op-atrest-1',
          tenantId: 'tenant-1',
          storeId: 'store-1',
          userId: 'user-1',
          deviceId: 'device-1',
          seq: 1,
          type: 'notes.note_created',
          entityType: 'note',
          entityId: 'note-atrest-1',
          schemaVersion: 3,
          payload: { marker: markerFor('operations', 'payload') } as never,
          timestamp: 1_700_000_000_000,
          location: {
            lat: -7.5,
            lng: 110.0,
            accuracyMeters: 5,
            marker: markerFor('operations', 'location'),
          } as never,
          source: 'ui',
          agentInitiated: false,
          agentConversationId: null,
          previousHash: '0'.repeat(64),
          hash: '1'.repeat(64),
          signature: 'c2ln',
        },
        signedCoreJcs: `{"marker":"${markerFor('operations', 'signed_core_jcs')}"}`,
      });
    });
  }

  // notes.title / notes.body — the module-applier builder INSERT (04 §4.1); the seam seals them
  // without the applier knowing (04 §2).
  if (run('notes.title', 'notes.body')) {
    await target.db
      .insertInto('notes')
      .values({
        id: 'note-atrest-1',
        tenantId: 'tenant-1',
        storeId: 'store-1',
        title: markerFor('notes', 'title'),
        body: markerFor('notes', 'body'),
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
  }

  // user_pin_verifiers.salt / .hash / .params — enrollment's SEC-AUTH-09 material, via the real writer.
  if (run('user_pin_verifiers.salt', 'user_pin_verifiers.hash', 'user_pin_verifiers.params')) {
    const verifier: PinVerifier = {
      algorithm: 'argon2id',
      saltB64: markerFor('user_pin_verifiers', 'salt'),
      mKiB: PARAMS_MKIB,
      t: 3,
      p: 1,
      hashB64: markerFor('user_pin_verifiers', 'hash'),
      asOf: { timestamp: 1_700_000_000_000, deviceId: 'device-1', seq: 1 },
    };
    await writeVerifier(target.db, 'user-1', verifier);
  }

  // quarantined_ops.signed_core_jcs — a rejected op held aside, via the real quarantine writer.
  if (run('quarantined_ops.signed_core_jcs')) {
    await insertQuarantinedOp(target.db, {
      id: 'q-atrest-1',
      deviceId: 'device-9',
      serverSeq: 42,
      signedCoreJcs: `{"marker":"${markerFor('quarantined_ops', 'signed_core_jcs')}"}`,
      hash: '2'.repeat(64),
      signature: 'c2ln',
      reason: 'bad_signature',
      quarantinedAt: 1_700_000_000_000,
    });
  }

  // users_directory.name — employee PII from a user sync, via the real directory writer.
  if (run('users_directory.name')) {
    await replaceUsersDirectory(target.db, [
      {
        id: 'user-1',
        name: markerFor('users_directory', 'name'),
        photoMediaId: null,
        status: 'active',
      },
    ]);
  }

  // media_items.location — capture GPS from a media attach, via apps/mobile's real writer.
  if (run('media_items.location')) {
    await insertMediaItem(target.db, {
      id: 'media-atrest-1',
      tenantId: 'tenant-1',
      storeId: 'store-1',
      userId: 'user-1',
      deviceId: 'device-1',
      type: 'image',
      mime: 'image/jpeg',
      sizeBytes: 1234,
      sha256: 'a'.repeat(64),
      capturedAt: 1_700_000_000_000,
      location: { lat: MEDIA_LAT, lng: 106.8, accuracyMeters: 5 },
      localPath: '/documents/media-atrest-1.jpg',
    });
  }
}

/** Read every stored cell of every signed-off encrypted column from a raw driver over the copy — no
 * Kysely plugin, so the PHYSICALLY-STORED (sealed) value is what comes back, exactly what the probe
 * inspects. */
async function readSealedCells(raw: DbDriver): Promise<SealedCell[]> {
  const cells: SealedCell[] = [];
  for (const [table, column] of AT_REST_ENCRYPTED_COLUMNS) {
    const result = await raw.execute(
      `SELECT ${column} AS c FROM ${table} WHERE ${column} IS NOT NULL`,
    );
    for (const row of result.rows) {
      const value = row['c'];
      cells.push({ table, column, value: value === null ? null : String(value) });
    }
  }
  return cells;
}

/** Checkpoint the WAL into the main file so a copy of just that file is complete (10-db §9 WAL). */
async function checkpoint(driver: DbDriver): Promise<void> {
  await driver.execute('PRAGMA wal_checkpoint(TRUNCATE)');
}

/**
 * Build the at-rest device env `runAtRestGate` consumes.
 *
 * `seedColumns` defaults to ALL 11 signed-off columns; it is a seam, not a backdoor — the gate's own
 * coverage check enumerates all 11 independently, so an env told to seed fewer makes the gate RED. The
 * falsification host-test uses that: seed 10, watch coverage red naming the 11th.
 */
export function createAtRestDeviceEnv(
  seams: AtRestDeviceSeams,
  seedColumns: readonly (readonly [string, string])[] = AT_REST_ENCRYPTED_COLUMNS,
): AtRestDeviceEnv {
  const skip: ReadonlySet<ColumnKey> = new Set(
    AT_REST_ENCRYPTED_COLUMNS.filter(
      ([t, c]) => !seedColumns.some(([st, sc]) => st === t && sc === c),
    ).map(([t, c]) => columnKey(t, c)),
  );

  // The markers actually planted — one per SEEDED column. A skipped column contributes no marker, so
  // the control witnesses exactly what was seeded and the leak hunt looks for exactly what was planted;
  // the SKIP is then caught by the coverage check (all 11 enumerated), not by a spurious control miss.
  const seededMarkers: readonly string[] = Object.freeze(
    seedColumns.map(([t, c]) => markerFor(t, c)).filter((marker) => marker.length > 0),
  );

  return {
    plaintextMarkers: seededMarkers,

    async seedUnencryptedControl(): Promise<Uint8Array> {
      // A BARE connection — no encryption plugin, no registered cipher — so `encryptColumnValue` is a
      // pass-through and every builder/raw writer lands PLAINTEXT (the graceful-degradation path
      // column-encryption-plugin.ts documents). CamelCasePlugin is still required so the builder
      // writers (op-store, notes) map camelCase → snake_case; its option matches
      // connection.ts:CLIENT_CAMEL_CASE_OPTIONS (10-db §11.4). No column here has a single-letter
      // camel segment, so the option is not load-bearing for this seed — the round-trip is still
      // proven by the host test writing and reading these very rows.
      await seams.removeDb(CONTROL_DB);
      const driver = await seams.driverFactory({ name: CONTROL_DB, location: seams.location });
      for (const pragma of CLIENT_PRAGMAS) await driver.execute(pragma);
      await runClientMigrations(driver, { now: () => 1 });
      const db = new Kysely<ClientDatabase>({
        dialect: createClientDialect(driver),
        plugins: [new CamelCasePlugin({ underscoreBetweenUppercaseLetters: true })],
      });
      try {
        await seedAllColumns({ db, driver }, skip);
        await checkpoint(driver);
      } finally {
        await db.destroy();
        await driver.close();
      }
      return seams.readBytesOf(CONTROL_DB);
    },

    async seedEncryptedDb(): Promise<AtRestProbeContext> {
      // The PRODUCTION wiring: openClientDb installs the cipher + registers it, so the same writers
      // seal. Fresh file each run (removeDb) so a stale seed cannot masquerade as this one.
      await seams.removeDb(ENCRYPTED_DB);
      const conn: ClientDb = await openClientDb({
        driverFactory: seams.driverFactory,
        keyStore: { getDatabaseEncryptionKey: () => Promise.resolve(HARNESS_DB_KEY) },
        aead: seams.aead,
        name: ENCRYPTED_DB,
        location: seams.location,
      });
      try {
        await runClientMigrations(conn.driver, { now: () => 1 });
        await seedAllColumns(conn, skip);
        await checkpoint(conn.driver);
      } finally {
        await conn.close();
      }

      // Read a COPY, never the live file — and read the sealed cells through a raw driver over that
      // same copy, so nothing touches the (now closed) production handle.
      await seams.copyDbFile(ENCRYPTED_DB, PROBE_COPY);
      const copyBytes = await seams.readBytesOf(PROBE_COPY);
      const raw = await seams.driverFactory({ name: PROBE_COPY, location: seams.location });
      let cells: SealedCell[];
      try {
        cells = await readSealedCells(raw);
      } finally {
        await raw.close();
      }

      return {
        readCopyBytes: () => Promise.resolve(copyBytes),
        plaintextMarkers: seededMarkers,
        readSealedCells: () => Promise.resolve(cells),
        sealedPrefix: COLUMN_CIPHER_SCHEME_PREFIX,
      };
    },
  };
}
