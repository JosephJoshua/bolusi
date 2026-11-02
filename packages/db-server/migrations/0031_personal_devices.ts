// Personal devices (permission-scoped sync, owner decisions 2026-10-31): a phone set up for one
// person, such as an owner's own phone or a technician's, is synced what THAT person may read, and
// only they sign in on it. A device with no person is shared by the store and gets staff-level data.
//
// No client mirror: the device learns its person from its bundle. Merge after 0030: the migrator
// refuses an earlier number later.
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE devices ADD COLUMN personal_user_id uuid REFERENCES users(id)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE devices DROP COLUMN IF EXISTS personal_user_id`.execute(db);
}
