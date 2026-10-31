// Durable per-user work (SEC-AUTH-08 beyond a lock): the half-entered servisan, note or any other
// module draft a user had open, kept on disk so it survives Android recreating the activity, the OS
// killing the app, or a crash. `SessionManager` keeps work in memory and writes it through here;
// on the SAME user's next PIN unlock it reads it back. Nothing here decides who may see what: the
// row is keyed by `user_id`, and the session only asks for the user who just verified their PIN.
//
// A draft can hold customer PII (name, phone, the device passcode), so the whole value is sealed
// with the connection's column cipher, like every other sensitive client column. Platform-free:
// raw `sql` over the client DDL (client migration 15), generic in `DB`, as auth/repo.ts does.
import { sql, type Kysely } from 'kysely';

import { encryptColumnValue } from '../crypto/column-cipher.js';

/** Where `SessionManager` keeps each user's work between app runs. */
export interface WorkStore<TWork> {
  /** The user's saved work, or undefined when there is none or it can no longer be read. */
  load(userId: string): Promise<TWork | undefined>;
  /** Replace the user's saved work. */
  save(userId: string, work: TWork): Promise<void>;
}

/**
 * The client `user_work` table as a {@link WorkStore}. `parse` validates what comes back, because a
 * row written by an older app version, or one that fails to decrypt, must start the user fresh
 * rather than crash the unlock or hand a screen a shape it does not expect.
 */
export function createWorkStore<DB, TWork>(
  db: Kysely<DB>,
  parse: (value: unknown) => TWork | undefined,
  now: () => number,
  /** The connection's transaction queue (db-client `ClientDb.transaction`), as sync state uses. */
  transaction: <T>(fn: () => Promise<T>) => Promise<T>,
): WorkStore<TWork> {
  return {
    async load(userId) {
      const result = await sql<{ work: string }>`
        SELECT work FROM user_work WHERE user_id = ${userId}
      `.execute(db);
      const stored = result.rows[0]?.work;
      if (stored === undefined) return undefined;
      try {
        return parse(JSON.parse(stored));
      } catch {
        return undefined;
      }
    },
    // In its own transaction: a bare write on the one client connection runs at once, so with a
    // command's transaction open it would land inside it and be lost when that command rolls back.
    // Never called from inside a transaction: the queue does not nest.
    async save(userId, work) {
      const sealed = encryptColumnValue(db, JSON.stringify(work));
      await transaction(async () => {
        await sql`
          INSERT INTO user_work (user_id, work, updated_at)
          VALUES (${userId}, ${sealed}, ${now()})
          ON CONFLICT (user_id) DO UPDATE SET work = excluded.work, updated_at = excluded.updated_at
        `.execute(db);
      });
    },
  };
}

/**
 * Drop saved work of anyone not in `userIds` (the device's active users). A deactivated or removed
 * employee can never unlock again, so their drafts, with whatever customer data they hold, should
 * not stay on the device.
 */
export async function deleteWorkExcept<DB>(
  db: Kysely<DB>,
  userIds: readonly string[],
): Promise<void> {
  if (userIds.length === 0) {
    await sql`DELETE FROM user_work`.execute(db);
    return;
  }
  await sql`DELETE FROM user_work WHERE user_id NOT IN (${sql.join(userIds)})`.execute(db);
}
