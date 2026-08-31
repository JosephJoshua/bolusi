// TEST-ONLY better-sqlite3 driver for the bootstrap suite (08 §2.5; testing-guide §2.3).
//
// op-sqlite is a JSI native module that cannot load under Node, so CI drives the identical
// `openClientDb` + migration + registration code through better-sqlite3 instead. It lives under
// `test/` and is never imported by shipping source — `bolusi/boundaries` enforces that half
// (`{ workspace: 'apps/mobile', testOnly: true }`), `shipping-deps.test.ts` the other.
//
// SQLCIPHER IS OFF HERE, BY DESIGN — say it plainly, because this driver is what the bootstrap suite
// runs against and a reader could otherwise take a green run as evidence of encryption. better-sqlite3
// has no SQLCipher build; `encryptionKey` is accepted and IGNORED. So this lane proves the key is
// READ, DEMANDED, and PASSED (that a missing key refuses to open, that the value reaching the driver
// is the one SecureStore held) — and proves NOTHING about whether the file on disk is ciphertext.
// That is SEC-DEV-06's on-device leg (task 27a) and it is unverifiable here (D12/D13: no physical
// Android or iOS device).
//
// The driver BODY (the `createDriver` normalizers + statement runner) is no longer copied here: it
// was one of five byte-identical copies the 2026-07-26 audit found, now extracted to the shared
// `@bolusi/sqlite-test-driver` package (task 185 leg 4, 08 §3.3 rule 9). This file keeps ONLY what
// is unique to the bootstrap suite — the key-recording OPENER (`openedWith` + `new Database`) — which
// is why apps/mobile stays a direct better-sqlite3 owner: it constructs the handle, the shared body
// wraps it. The `dependencies`/`devDependencies` split (driver stays a devDep) keeps the Node addon
// off the device bundle; `shipping-deps.test.ts` asserts that half, `bolusi/boundaries` the import.
import Database from 'better-sqlite3';

import { createDriver } from '@bolusi/sqlite-test-driver';

import type { DbDriver, DbDriverOpenParams } from '@bolusi/db-client';

/** Records every key the bootstrap hands the driver — the SQLCipher-key assertions read this. */
export const openedWith: DbDriverOpenParams[] = [];

export function resetOpenedWith(): void {
  openedWith.length = 0;
}

/**
 * A file-backed or in-memory driver factory.
 *
 * `location: ':memory:'` is the default. A NAMED file is what the persistence test needs: proving
 * "a write survives a restart" requires the bytes to outlive the connection, and `:memory:` dies
 * with it — which would make the reproduction assert nothing (T-14b).
 */
export const openBetterSqlite3Driver = (params: DbDriverOpenParams): Promise<DbDriver> => {
  openedWith.push(params);
  const path = params.location === undefined ? ':memory:' : params.location;
  return Promise.resolve(createDriver(new Database(path)));
};
