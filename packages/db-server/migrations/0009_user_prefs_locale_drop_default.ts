// user_prefs.locale — drop the misleading column default (task 76; 10-db-schema §8, 07-i18n §1.1).
//
// 0005 created the column as `locale text NOT NULL DEFAULT 'id-ID'`. But `'id-ID'` is
// `INTL_LOCALE_TAG.id` — a formatting tag, NOT a `Locale`. The column holds a `Locale` (`id` | `en`),
// exactly the `z.enum(['id','en'])` payload the platform applier writes verbatim. The default was
// unreachable through the fold (the applier always supplies `locale`), so it was inert — but a decoy:
// a reader trusting the DDL would conclude this column holds Intl tags. The read-side fallback
// ("default `id` when the row is absent") belongs to the reader (`resolveLocale`), which a column
// default cannot express anyway. So the default is dropped; NOT NULL stays because every insert
// supplies the value. Append-only per the migration convention (0007 set the precedent).
import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE user_prefs ALTER COLUMN locale DROP DEFAULT`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Faithful inverse: restore the pre-0009 historical default. It is the wrong vocabulary (an Intl
  // tag, not a `Locale`) — that is exactly why `up` removed it — but `down` must reconstruct the
  // state 0005 left, not an improved one.
  await sql`ALTER TABLE user_prefs ALTER COLUMN locale SET DEFAULT 'id-ID'`.execute(db);
}
