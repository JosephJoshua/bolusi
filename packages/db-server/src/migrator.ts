// Migration-runner entry (08-stack-and-repo §3.2: the documented exception to "forTenant is
// the only export" — migrations legitimately need a schema-level handle).
//
// `pnpm db:migrate` goes through kysely-ctl (kysely.config.ts). This module is the
// PROGRAMMATIC path, used by the test harness to bring a fresh database up to latest.
//
// Migrations are TypeScript, so whatever imports them needs a TS-capable loader (vitest here,
// tsx under kysely-ctl). 10-db-schema §1 pins TS migrations, so this is inherent, not a gap.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Kysely } from 'kysely';
import { FileMigrationProvider, Migrator, NO_MIGRATIONS } from 'kysely/migration';

// `Kysely<any>` throughout, matching kysely's own Migration/MigratorProps contract: a migrator
// runs DDL against a schema that by definition does not match the generated types yet. It is
// also load-bearing rather than lazy — Kysely<T> is INVARIANT, so a `Kysely<unknown>` parameter
// would reject the `Kysely<DB>` every caller actually holds.
/* eslint-disable @typescript-eslint/no-explicit-any */

/** Absolute path to `packages/db-server/migrations` — resolves the same from src/ and dist/. */
export const MIGRATION_FOLDER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
);

export function createMigrator(db: Kysely<any>): Migrator {
  return new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: MIGRATION_FOLDER,
      // Load each migration through THIS module's dynamic import rather than
      // FileMigrationProvider's own. The provider lives in node_modules, so its import() is a
      // raw Node import that never sees the test runner's resolver — and the migrations are
      // TypeScript importing `.js` specifiers (NodeNext). Routing the import through a file the
      // runner has transformed is what makes those specifiers resolve.
      import: (module) => import(module),
    }),
  });
}

/** Applies every pending migration. Throws on the first failure, surfacing the migration name. */
export async function migrateToLatest(db: Kysely<any>): Promise<void> {
  const { error, results } = await createMigrator(db).migrateToLatest();
  throwIfFailed('migrateToLatest', error, results);
}

/** Reverts every applied migration (down to an empty schema). Used by the migration tests. */
export async function migrateDownToStart(db: Kysely<any>): Promise<void> {
  const { error, results } = await createMigrator(db).migrateTo(NO_MIGRATIONS);
  throwIfFailed('migrateDownToStart', error, results);
}

function throwIfFailed(
  op: string,
  error: unknown,
  results: readonly { migrationName: string; status: string }[] | undefined,
): void {
  const failed = results?.find((r) => r.status === 'Error');
  if (error !== undefined || failed !== undefined) {
    const at = failed ? ` at migration '${failed.migrationName}'` : '';
    throw new Error(`${op} failed${at}: ${String(error ?? 'unknown error')}`, { cause: error });
  }
}
