// notes.media_sha256 / notes.media_mime — the signed hash a PULLED note verifies its photo against
// (task 120; 06-media-pipeline §6, 05-operation-log §2, 10-db-schema §8).
//
// WHY. 0005 created `notes.media_id` for "schemaVersion 2 payloads". That id is enough for a note
// whose photo was captured on the SAME device — it resolves through the local `media_items` row. It
// is not enough for a note pulled from another device: 06 §6 requires downloaded bytes be "verified
// against `mediaRef.sha256` before display", and the pulling device has no `media_items` row and no
// other source for that hash. `notes.note_created` therefore moves to schemaVersion 3, whose payload
// carries the whole signed `mediaRef` (05 §2 — the payload is what the Ed25519 signature covers, so
// it is the only tamper-evident carrier), and these two columns are where the fold lands it.
//
// The server folds the SAME appliers as the client (04 §2, deps.ts SERVER_MODULES), so these columns
// are not optional server-side bookkeeping — without them the shared `note_created` applier fails on
// every v3 op the server accepts.
//
// NULLABLE, deliberately: v1 notes carry no media and v2 notes carry an id with no hash. Both are
// permanent history (05 §7), so the columns stay honestly empty for them rather than being
// back-filled with a value no device ever signed. A null here means "resolvable only from a local
// file", never "hash not fetched yet".
//
// Append-only per the migration convention (0007/0009 set the precedent) — 0005 is not edited.
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // `text`, not a domain/CHECK on hex: the payload's `zSha256Hex` already pins lowercase 64-hex at
  // the point where an op is validated (05 §8 SCHEMA_INVALID), and a second, weaker restatement here
  // would be a rule that can silently disagree with the one that actually gates writes.
  await sql`ALTER TABLE notes ADD COLUMN media_sha256 text`.execute(db);
  await sql`ALTER TABLE notes ADD COLUMN media_mime text`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE notes DROP COLUMN media_mime`.execute(db);
  await sql`ALTER TABLE notes DROP COLUMN media_sha256`.execute(db);
}
