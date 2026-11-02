// Person sessions (least-privilege sync, owner decision 2026-11-01): a shared store device holds
// only what its staff may read, and anyone who may read more reads the rest online for as long as
// they are signed in there. The server checks their PIN itself before it serves any of it, so a
// tampered device cannot claim a person it never verified. The token is stored hashed, bound to one
// device and one person, and ends on sign-out, expiry, or the device's revocation.
//
// No client mirror: the device keeps the token in memory only.
import { sql, type Kysely } from 'kysely';

import { secureTenantTable } from '../src/schema/security.js';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE person_sessions (
      id         uuid PRIMARY KEY,
      tenant_id  uuid NOT NULL REFERENCES tenants(id),
      device_id  uuid NOT NULL REFERENCES devices(id),
      user_id    uuid NOT NULL REFERENCES users(id),
      token_hash text NOT NULL UNIQUE,
      created_at bigint NOT NULL,
      expires_at bigint NOT NULL,
      revoked_at bigint
    )
  `.execute(db);
  await sql`CREATE INDEX person_sessions_device ON person_sessions (device_id, user_id)`.execute(
    db,
  );
  await secureTenantTable(db, 'person_sessions');
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS person_sessions`.execute(db);
}
