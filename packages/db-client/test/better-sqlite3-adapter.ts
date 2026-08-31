// TEST-ONLY better-sqlite3 adapter (08 §2.5: never imported by shipping packages; it
// lives under test/ and is excluded from the build, so it cannot reach dist/).
//
// This is the CI half of the two-adapter design (testing-guide §2.3): op-sqlite is a JSI
// native module and cannot run in Node, so CI drives the identical dialect + migration +
// conformance code through better-sqlite3 instead.
//
// SQLCipher is OFF here BY DESIGN — better-sqlite3 has no SQLCipher build. `encryptionKey`
// is accepted and deliberately ignored, so this adapter proves nothing about encryption
// at rest; that is SEC-DEV-06's L6 leg on real hardware (task 27). What it does prove is
// that the SQL, the dialect, and the migrations behave identically on both engines.
import * as nodeCrypto from 'node:crypto';

import Database from 'better-sqlite3';

import { createDriver } from '@bolusi/sqlite-test-driver';

import { createNodeCompatibleAead } from '../src/crypto/aead.js';
import type { DbDriver, DbDriverOpenParams } from '../src/driver.js';

/**
 * Opens a database. `:memory:` (or no location) opens in-memory; any other location is treated as a
 * directory prefix, which is what the raw-file at-rest tests need (they must read the bytes back).
 */
export const openBetterSqlite3Driver = (params: DbDriverOpenParams): Promise<DbDriver> => {
  const path =
    params.location === ':memory:' || params.location === undefined
      ? ':memory:'
      : `${params.location}/${params.name}`;
  return Promise.resolve(createDriver(new Database(path)));
};

/** Opens an in-memory driver — the common shape for tests. */
export const openTestDriver = (): Promise<DbDriver> =>
  openBetterSqlite3Driver({ name: 'test.db', location: ':memory:' });

/**
 * A valid-but-obviously-fake database key: 32 bytes as 64 hex chars (10-db §12).
 *
 * Since D22 the key is decoded to the raw bytes of the AES-256-GCM column cipher, so it MUST be real
 * hex of the right length — an arbitrary string like the old `'test-key'` now fails the open, which is
 * correct behaviour, not a test-only nuisance. A repeating pattern keeps it out of the secret
 * scanner's way (security-guide §10, SEC-SECRET-02).
 */
export const TEST_DB_KEY = 'a'.repeat(64);

/** The Node AES-256-GCM binding for the column cipher in CI. The device binds quick-crypto instead. */
export const testAead = createNodeCompatibleAead(nodeCrypto);

/** The `DbKeyStore` shape every db-client test opens with. */
export const testKeyStore = {
  getDatabaseEncryptionKey: (): Promise<string> => Promise.resolve(TEST_DB_KEY),
};
