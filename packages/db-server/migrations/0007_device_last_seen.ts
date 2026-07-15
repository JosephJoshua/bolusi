// devices.last_seen_at — the device-token lifecycle field (api/02-auth §8: "lastSeenAt is updated
// at most once per 5 minutes per device (throttled write — no hot row)"; surfaced by GET /v1/devices
// §7.1). 10-db-schema §7's devices DDL omitted it (it carries last_sync_at, owned by sync, which is
// a different signal); this closes that gap. Nullable — a freshly enrolled device has not been seen
// on a subsequent request yet.
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE devices ADD COLUMN last_seen_at bigint`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE devices DROP COLUMN IF EXISTS last_seen_at`.execute(db);
}
