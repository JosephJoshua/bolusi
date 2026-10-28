// A driver factory over the shared better-sqlite3 adapter, for the boot and sync suites.
import { openFileDriver, openMemoryDriver } from '@bolusi/sqlite-test-driver';

import type { DbDriver, DbDriverOpenParams } from '@bolusi/db-client';

/** Records every open the bootstrap asks for. */
export const openedWith: DbDriverOpenParams[] = [];

export function resetOpenedWith(): void {
  openedWith.length = 0;
}

/** In memory by default; a named `location` is a file, for tests that reopen it. */
export const openBetterSqlite3Driver = (params: DbDriverOpenParams): Promise<DbDriver> => {
  openedWith.push(params);
  return Promise.resolve(
    params.location === undefined || params.location === ':memory:'
      ? openMemoryDriver()
      : openFileDriver(params.location),
  );
};
