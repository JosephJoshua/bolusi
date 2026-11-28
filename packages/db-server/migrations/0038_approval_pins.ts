// Approval PINs (owner decision 2026-11-25): an owner's or manager's decision on a shared store
// device is taken only with a PIN the server checks and no device ever stores. A sign-in PIN's
// verifier lives on shared devices so people sign in offline, and a short PIN under a copied
// verifier is guessed offline in hours. This one never leaves the server.
//
// A decision session is a person session the server opened after checking the approval PIN: the
// push's proof for a decision (server oplog/steps/decision.ts). A sign-in session proves none.
//
// No client mirror: the device keeps neither the PIN nor its verifier.
import { sql, type Kysely } from 'kysely';

import { secureTenantTable } from '../src/schema/security.js';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE user_approval_pins (
      user_id    uuid PRIMARY KEY REFERENCES users(id),
      tenant_id  uuid NOT NULL REFERENCES tenants(id),
      salt       text NOT NULL,
      params     jsonb NOT NULL,
      hash       text NOT NULL,
      set_at     bigint NOT NULL,
      set_by     uuid NOT NULL REFERENCES users(id)
    )
  `.execute(db);
  await secureTenantTable(db, 'user_approval_pins');
  await sql`
    ALTER TABLE person_sessions ADD COLUMN proves_decisions boolean NOT NULL DEFAULT false
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE person_sessions DROP COLUMN IF EXISTS proves_decisions`.execute(db);
  await sql`DROP TABLE IF EXISTS user_approval_pins`.execute(db);
}
