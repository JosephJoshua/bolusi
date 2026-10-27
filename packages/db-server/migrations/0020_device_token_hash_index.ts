// devices.token_hash index: every authenticated request resolves its device by token hash
// (`auth_find_device_by_token_hash`, 0006), and without an index that was a sequential scan of every
// device of every tenant, plus the dead row versions each push leaves behind when it advances the
// device's chain head. The sync load test measured 0.6 ms per request at 400 devices, growing with
// the fleet (docs/development.md).
//
// UNIQUE because a token hash names exactly one device: two rows with one hash would make the lookup
// return two devices for one bearer token. NULLs (the system device has no token) stay allowed.
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE UNIQUE INDEX idx_devices_token_hash ON devices (token_hash)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_devices_token_hash`.execute(db);
}
