// Several cash drawers per store (Kas as the shared money ledger). Mirrors client migration 35.
//
// A drawer other than the store's main one is a money account of kind `drawer`; a drawer may be
// limited to some roles. Each cash move, count and adjustment names its drawer. Every record before
// this was of the main drawer (`cash`), as a re-fold of their ops gives.
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE money_accounts ADD COLUMN role_ids_json text`.execute(db);
  await sql`ALTER TABLE money_entries ADD COLUMN drawer text`.execute(db);
  await sql`
    UPDATE money_entries SET drawer = 'cash'
    WHERE kind IN ('cash_moved', 'cash_counted', 'cash_adjusted')
  `.execute(db);
  await sql`CREATE INDEX idx_money_entries_store_drawer ON money_entries (store_id, kind, drawer, created_at)`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX idx_money_entries_store_drawer`.execute(db);
  await sql`ALTER TABLE money_entries DROP COLUMN drawer`.execute(db);
  await sql`ALTER TABLE money_accounts DROP COLUMN role_ids_json`.execute(db);
}
