// Client-DB glue for the NODE harness: open a VirtualDevice's own better-sqlite3 SQLite (the ONE
// dialect from @bolusi/db-client + the real client migrations) and bind the production
// `OpAppendStore` over it.
//
// The pulled-op insert, the wire readback, and the `ClientDbHandle` shape now live in the
// platform-free shared rig (@bolusi/test-support/chaos, task 181) so they can bundle on Hermes for
// the on-device CHAOS-01 runner. This file is the ONE place better-sqlite3 (`openMemoryDriver`)
// enters the Node rig — the DB seam's Node binding — kept out of the shared rig by construction.
import { CamelCasePlugin, Kysely } from 'kysely';

import {
  createClientDialect,
  createClientOpStore,
  runClientMigrations,
  type ClientDatabase,
} from '@bolusi/db-client';
import type { ClientDbHandle } from '@bolusi/test-support/chaos';

import { openMemoryDriver } from '@bolusi/sqlite-test-driver';

export { insertPulledOp, readWireOps } from '@bolusi/test-support/chaos';
export type { ClientDbHandle };

/** Open a fresh device DB: one better-sqlite3 connection, the real client migrations, the bound store. */
export async function openClientDb(): Promise<ClientDbHandle> {
  const driver = openMemoryDriver();
  await runClientMigrations(driver, { now: () => 1 });
  const db = new Kysely<ClientDatabase>({
    dialect: createClientDialect(driver),
    plugins: [new CamelCasePlugin({ underscoreBetweenUppercaseLetters: true })],
  });
  const store = createClientOpStore({ db, driver });
  return {
    driver,
    db,
    store,
    close: async () => {
      await db.destroy();
      await driver.close();
    },
  };
}
