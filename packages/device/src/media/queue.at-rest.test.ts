// The 11th signed-off encrypted column: `media_items.location` (D22 addendum 2 #9; task 148).
//
// The other ten are proven in `packages/harness/test/at-rest-column-encryption.test.ts`, which drives
// each column's REAL production writer against a file-backed DB and reads the raw bytes back. This one
// cannot live there: `insertMediaItem` is apps/mobile code, and the harness sits UPSTREAM of the app,
// so it cannot import it. Rather than re-implement the INSERT in the harness (T-13 — a probe that
// re-writes the SQL proves only that the probe encrypts), the column is proven HERE, against the same
// real writer the capture pipeline calls (06 §2.2 step 7).
//
// Scope, stated: this is the NODE leg. It proves the wiring and the codec. "The raw DB file on a real
// Android device is ciphertext" is emulator-only and remains unclaimed (no Android SDK on this host),
// which is why no SEC id appears in these titles.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test } from 'vitest';

import {
  COLUMN_CIPHER_SCHEME_PREFIX,
  closeClientDb,
  openClientDb,
  runClientMigrations,
} from '@bolusi/db-client';
import { nodeColumnAead } from '@bolusi/test-support';

import { openBetterSqlite3Driver } from '../../test/better-sqlite3-driver.js';
import { insertMediaItem } from './queue.js';

/** 32 bytes as 64 hex chars — the shape `SecureStoreDbKeyStore` mints. Obviously fake. */
const DB_KEY = 'a'.repeat(64);

/** A distinctive GPS marker: if these bytes appear in the file, the capture location leaked. */
const PLAIN_LOCATION_MARKER = -6.2214987654321;

let dir: string | null = null;

afterEach(async () => {
  await closeClientDb().catch(() => undefined);
  if (dir !== null) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

test('media_items.location is ciphertext at rest; local_path and sha256 stay plaintext by design', async () => {
  dir = mkdtempSync(join(tmpdir(), 'bolusi-media-at-rest-'));
  const file = join(dir, 'bolusi.db');

  const db = await openClientDb({
    driverFactory: () => openBetterSqlite3Driver({ name: 'bolusi.db', location: file }),
    keyStore: { getDatabaseEncryptionKey: () => Promise.resolve(DB_KEY) },
    aead: nodeColumnAead,
    name: 'bolusi.db',
    location: file,
  });
  await runClientMigrations(db.driver, { now: () => 1 });

  // THE REAL capture-side writer (06 §2.2 step 7) — not a re-implementation of its SQL.
  await insertMediaItem(db.db, {
    id: 'media-1',
    tenantId: 'tenant-1',
    storeId: 'store-1',
    userId: 'user-1',
    deviceId: 'device-1',
    type: 'image',
    mime: 'image/jpeg',
    sizeBytes: 1234,
    sha256: 'a'.repeat(64),
    capturedAt: 1_700_000_000_000,
    location: { lat: PLAIN_LOCATION_MARKER, lng: 106.8, accuracyMeters: 5 },
    localPath: '/documents/media-1.jpg',
  });

  // The physical cell is a marked AEAD blob…
  const raw = await db.driver.execute(`SELECT location, local_path, sha256 FROM media_items`);
  const stored = String(raw.rows[0]?.['location']);
  expect(stored.startsWith(COLUMN_CIPHER_SCHEME_PREFIX)).toBe(true);
  expect(stored).not.toContain(String(PLAIN_LOCATION_MARKER));

  // …and it round-trips losslessly through the decrypt seam.
  const viaKysely = await db.db
    .selectFrom('mediaItems')
    .select('location')
    .executeTakeFirstOrThrow();
  expect(JSON.parse(String(viaKysely.location))).toEqual({
    lat: PLAIN_LOCATION_MARKER,
    lng: 106.8,
    accuracyMeters: 5,
  });

  // PLAINTEXT BY DESIGN, pinned so nobody later reads this control as broader than it is:
  // `local_path` is filtered on by the drain/prune passes, and `sha256` is a hash. Encrypting the
  // path would not protect the photo anyway — the IMAGE BYTES on disk are unencrypted and explicitly
  // out of scope (task 158), an accepted residual until that lands.
  expect(raw.rows[0]?.['local_path']).toBe('/documents/media-1.jpg');
  expect(raw.rows[0]?.['sha256']).toBe('a'.repeat(64));

  await closeClientDb();

  // The raw FILE carries no cleartext GPS.
  expect(readFileSync(file).toString('latin1')).not.toContain(String(PLAIN_LOCATION_MARKER));
});
