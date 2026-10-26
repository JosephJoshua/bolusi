// Client migration 8 — the phone catalog a device keeps for offline model search at intake.
//
// Crawled server-side from GSMArena (apps/server catalog/) and downloaded by revision
// (apps/mobile bootstrap/phone-catalog.ts), with the cursor in `meta_kv`. Public reference data
// shared by every tenant, so it is neither encrypted nor tenant-scoped, and it is not a projection:
// no op writes it and a rebuild never touches it. Photos are not stored here; they download when
// shown. About 13k rows, roughly 1.5 MB.
//
// (Version 7 belongs to the repair ticket counter index, on its own branch.)
import type { ClientMigration } from './types.js';

export const phoneModelsMigration: ClientMigration = {
  version: 8,
  name: 'phone_models',
  statements: [
    `CREATE TABLE phone_models (
      id             INTEGER PRIMARY KEY,
      brand          TEXT NOT NULL,
      name           TEXT NOT NULL,
      kind           TEXT NOT NULL,
      announced_year INTEGER,
      model_codes    TEXT NOT NULL,
      photo_sha256   TEXT,
      revision       INTEGER NOT NULL
    )`,
  ],
};
