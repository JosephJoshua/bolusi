/**
 * Where this device keeps the cash drawer it takes cash into (money drawer-choice.ts): its own
 * settings in `meta_kv`, never synced, so a shared counter PC stays on its drawer for whoever signs in.
 */
import { readMeta, writeMeta } from '@bolusi/core';
import type { DrawerChoiceStorage } from '@bolusi/modules/money';
import type { Kysely } from 'kysely';

/** Device-local: the drawer (`cash` or `account:<id>`) this device was last set to. */
export const CASH_DRAWER_META_KEY = 'money.drawer';

export function drawerChoiceStorage<DB>(db: Kysely<DB>): DrawerChoiceStorage {
  return {
    read: () => readMeta(db, CASH_DRAWER_META_KEY),
    write: (drawer) => writeMeta(db, CASH_DRAWER_META_KEY, drawer),
  };
}
