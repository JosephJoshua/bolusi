// The phone catalog: phone models crawled from GSMArena (apps/server/src/catalog), with their
// photos, so the intake screen can suggest a model and show what it looks like.
//
// GLOBAL reference data, like `permissions`: no tenant_id and no RLS, the same rows for every
// tenant. The crawler is the only writer and runs as the table owner (bolusi_provision); request
// handlers get SELECT only, so nothing a device sends can change the catalog.
//
// `revision` is what devices sync by: every insert or change of a field a device keeps takes the
// next value of one sequence, and a device asks for the rows after the last revision it has. The
// crawler is a single writer that commits row by row, so a revision never commits behind a higher
// one a device has already read past.
import { sql, type Kysely } from 'kysely';

import { PROVISION_ROLE, grantToApp, ownTable } from '../src/schema/security.js';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE phone_catalog_brands (
      path       text PRIMARY KEY,   -- the brand's listing page, e.g. 'samsung-phones-9.php'
      name       text NOT NULL,
      -- When every listing page was last walked to the end; null until the first full walk, so
      -- an interrupted first crawl finishes the brand instead of stopping at known models.
      listed_at  bigint
    )
  `.execute(db);

  await sql`CREATE SEQUENCE phone_models_revision_seq`.execute(db);
  await sql`
    CREATE TABLE phone_models (
      id             integer PRIMARY KEY,  -- GSMArena's device number
      brand          text NOT NULL,
      name           text NOT NULL,        -- without the brand: 'Galaxy A55'
      kind           text NOT NULL CHECK (kind IN ('phone', 'tablet', 'watch')),
      announced_year integer,
      model_codes    text NOT NULL DEFAULT '',  -- comma-separated: 'SM-A556B, SM-A556E'
      specs          jsonb NOT NULL DEFAULT '{}',  -- PhoneSpecs (@bolusi/schemas catalog.ts)
      page_path      text NOT NULL,
      photo_url      text,
      photo_sha256   text,                 -- null: no photo stored (yet)
      details_at     bigint,               -- when the device page was last fetched or found gone
      photo_at       bigint,               -- when the photo was last fetched or found gone
      revision       bigint NOT NULL,
      created_at     bigint NOT NULL,
      updated_at     bigint NOT NULL
    )
  `.execute(db);
  await sql`CREATE UNIQUE INDEX idx_phone_models_revision ON phone_models (revision)`.execute(db);

  await sql`
    CREATE TABLE phone_model_photos (
      model_id   integer PRIMARY KEY REFERENCES phone_models(id),
      sha256     text NOT NULL,
      mime       text NOT NULL,
      bytes      bytea NOT NULL,
      fetched_at bigint NOT NULL
    )
  `.execute(db);

  for (const table of ['phone_catalog_brands', 'phone_models', 'phone_model_photos']) {
    await ownTable(db, table);
    await grantToApp(db, table, 'read-only');
  }
  await sql`ALTER SEQUENCE phone_models_revision_seq OWNER TO ${sql.id(PROVISION_ROLE)}`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE phone_model_photos`.execute(db);
  await sql`DROP TABLE phone_models`.execute(db);
  await sql`DROP SEQUENCE phone_models_revision_seq`.execute(db);
  await sql`DROP TABLE phone_catalog_brands`.execute(db);
}
