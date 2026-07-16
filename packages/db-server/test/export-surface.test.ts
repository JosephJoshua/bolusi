// Task 05 acceptance (d): the package's public export surface is exactly the documented set
// (08-stack-and-repo §3.2, D7/FR-1039).
//
// This is the API half of the tenant-isolation guarantee: RLS makes an unscoped query fail
// closed, and THIS makes it inexpressible. If the raw pool/db handle ever appears here, the
// wrapper stops being "the only exported way to query tenant tables" and the guarantee is
// reduced to a convention.
import { expect, test } from 'vitest';

import * as dbServer from '../src/index.js';

/**
 * The documented surface: forTenant, the generated types (type-only, so invisible at runtime),
 * and a migration-runner entry (08 §3.2's explicit exception).
 */
const EXPECTED_EXPORTS = [
  'InvalidTenantIdError',
  'MIGRATION_FOLDER',
  'createMigrator',
  'forTenant',
  'migrateDownToStart',
  'migrateToLatest',
  // D14 (10-db-schema §6.4): the three auth-entry cross-tenant lookups. They are fixed,
  // keyed, definer-gated functions — not a raw handle, and the `queryish` assertion below
  // still holds because they return plain records, not something with `selectFrom`.
  'findDeviceByTokenHash',
  'findControlSessionByTokenHash',
  'findLoginCredential',
  // Task 47: the server watermark store (10-db §8). It CONSUMES a tenant-bound handle rather
  // than producing one, and returns a read/advance store with no `selectFrom` — so the D7
  // invariant this file guards is unchanged, and the `queryish` assertion below still covers it.
  'createServerWatermarkStore',
  // Task 49: the server projection engine factory (10-db §3 step 6). Same shape as the watermark
  // store — it CONSUMES a `forTenant` handle and returns a `ProjectionEngine` (apply/rebuild
  // methods, no `selectFrom`), so D7 and the `queryish` assertion below are untouched.
  'createServerProjectionEngine',
  // Task 17: Rule 1's candidate query (01 §8.2). Same shape again — it CONSUMES a tenant-bound
  // handle and returns plain `{opId, beforeProbe}` records, so D7 and `queryish` are untouched. It
  // is here rather than in apps/server because `test:rls` (the only real-PG16 lane) is
  // `--project db-server`, and Rule 1's `server_seq > last_pull_cursor` is the int8 comparison D16
  // forbids a substitute from being the sole witness for.
  'findRule1Candidates',
].sort();

test('the package exports exactly the documented surface', () => {
  expect(Object.keys(dbServer).sort()).toEqual(EXPECTED_EXPORTS);
});

test('the package exports no raw db, pool, or handle-producing factory', () => {
  // Named explicitly rather than inferred from the list above: these are the specific escape
  // hatches D7 exists to close, so they get their own assertion that reads as intent.
  for (const forbidden of ['db', 'getDb', 'pool', 'getPool', 'kysely', 'createForTenant']) {
    expect(Object.keys(dbServer)).not.toContain(forbidden);
  }
});

test('forTenant is the only exported way to reach a tenant table', () => {
  expect(typeof dbServer.forTenant).toBe('function');

  // Nothing else exported may hand back something queryable. The migration entries take a db
  // rather than producing one, so they cannot be used to obtain a handle.
  const queryish = Object.entries(dbServer).filter(
    ([, value]) => typeof value === 'object' && value !== null && 'selectFrom' in (value as object),
  );
  expect(queryish).toEqual([]);
});
