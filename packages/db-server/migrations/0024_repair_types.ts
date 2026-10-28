// Repair types on a servisan (product-scope.md, "Warranty, phones not collected and customer
// messages"). Mirrors client migration 20.
//
// A ticket records its repair types with each one's warranty; the owner's list of types lives with
// the other intake lists, so it needs no table of its own. Tickets opened before this have none.
// 0022 and 0023 belong to other branches and must be merged first.
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE repair_tickets ADD COLUMN repair_types_json text NOT NULL DEFAULT '[]'`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE repair_tickets DROP COLUMN repair_types_json`.execute(db);
}
