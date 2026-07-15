// Barrel over the kysely-codegen output. `db.ts` is GENERATED — never hand-edit it
// (10-db §11.5); regenerate with `pnpm -F @bolusi/db-client db:codegen`. CI regenerates
// and diffs, so a hand edit fails the build.
//
// Only the alias lives here: `ClientDatabase` is the name the rest of the repo uses for
// the client schema, while codegen always emits `DB`.
export type { DB as ClientDatabase } from './db.js';
export type * from './db.js';
