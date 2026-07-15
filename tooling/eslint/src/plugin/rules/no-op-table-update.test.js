import { RuleTester } from 'eslint';
import { describe, it } from 'vitest';

import rule from './no-op-table-update.js';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

// Column-scoped allowance (task 06): bookkeeping.ts may UPDATE only these four columns.
const BOOKKEEPING = '/repo/packages/core/src/oplog/bookkeeping.ts';
const COLUMN_OPTS = [
  {
    allowFiles: ['packages/core/src/oplog/bookkeeping.ts'],
    allowColumns: ['syncStatus', 'syncedAt', 'rejectionCode', 'rejectionReason'],
  },
];
// Legacy FULL file exemption (allowFiles only): the DDL trigger + adversarial append-only tests.
const LEGACY_OPTS = [{ allowFiles: ['packages/db-server/migrations/0003_operations.ts'] }];

tester.run('no-op-table-update', rule, {
  valid: [
    // mutating a projection table is fine — only the op log is append-only
    { code: `await db.updateTable('note_projections').set({ title }).execute();` },
    { code: `await db.deleteFrom('sync_cursors').execute();` },
    // inserts into operations are the normal append path
    { code: `await db.insertInto('operations').values(op).execute();` },
    // COLUMN-SCOPED: bookkeeping.ts setting the full four bookkeeping columns → allowed.
    {
      code: `await db.updateTable('operations').set({ syncStatus: 'synced', syncedAt: t, rejectionCode: null, rejectionReason: null }).where('id', '=', id).execute();`,
      options: COLUMN_OPTS,
      filename: BOOKKEEPING,
    },
    // COLUMN-SCOPED: a subset of the bookkeeping columns → allowed.
    {
      code: `await db.updateTable('operations').set({ syncStatus: 'synced' }).execute();`,
      options: COLUMN_OPTS,
      filename: BOOKKEEPING,
    },
    // LEGACY full exemption (DDL / adversarial-test files) — allowFiles WITHOUT allowColumns:
    // still fully exempt, so the CREATE TRIGGER DDL and the append-only tests keep passing.
    {
      code: `await db.updateTable('operations').set({ payload }).execute();`,
      options: LEGACY_OPTS,
      filename: '/repo/packages/db-server/migrations/0003_operations.ts',
    },
  ],
  invalid: [
    // Kysely updateTable('operations') → error (primary fixture, no allowlist)
    {
      code: `await db.updateTable('operations').set({ payload }).execute();`,
      errors: [{ messageId: 'opTableMutation' }],
    },
    {
      code: `await db.deleteFrom('operations').where('id', '=', id).execute();`,
      errors: [{ messageId: 'opTableMutation' }],
    },
    // raw SQL string DELETE FROM operations → error (primary fixture)
    {
      code: `await run("DELETE FROM operations WHERE id = ?");`,
      errors: [{ messageId: 'rawSqlMutation' }],
    },
    {
      code: 'await sql`UPDATE operations SET payload = ${p}`;',
      errors: [{ messageId: 'rawSqlMutation' }],
    },
    // The allowlist is EXACT-FILE: another core oplog file is NOT covered even with the same
    // options object — append.ts mutating a signed-core column still fails (05 §1).
    {
      code: `await db.updateTable('operations').set({ signature }).where('id', '=', id).execute();`,
      options: COLUMN_OPTS,
      filename: '/repo/packages/core/src/oplog/append.ts',
      errors: [{ messageId: 'opTableMutation' }],
    },
    {
      code: `await db.deleteFrom('operations').where('id', '=', id).execute();`,
      options: COLUMN_OPTS,
      filename: '/repo/packages/core/src/oplog/verify.ts',
      errors: [{ messageId: 'opTableMutation' }],
    },
    // COLUMN-SCOPED enforcement (the reviewer's probe): bookkeeping.ts UPDATing a signed-core
    // column is REJECTED even though the file is allowlisted — file-level exemption would have
    // let this through (05 §1, §2.3).
    {
      code: `await db.updateTable('operations').set({ signature }).where('id', '=', id).execute();`,
      options: COLUMN_OPTS,
      filename: BOOKKEEPING,
      errors: [{ messageId: 'opTableColumnEscape' }],
    },
    {
      code: `await db.updateTable('operations').set({ payload }).execute();`,
      options: COLUMN_OPTS,
      filename: BOOKKEEPING,
      errors: [{ messageId: 'opTableColumnEscape' }],
    },
    // One good key + one signed-core key → still rejected (subset must be TOTAL).
    {
      code: `await db.updateTable('operations').set({ syncStatus: 'synced', payload }).execute();`,
      options: COLUMN_OPTS,
      filename: BOOKKEEPING,
      errors: [{ messageId: 'opTableColumnEscape' }],
    },
    // A dynamic .set() (identifier) cannot be proven a subset → rejected (fail closed).
    {
      code: `await db.updateTable('operations').set(patch).where('id', '=', id).execute();`,
      options: COLUMN_OPTS,
      filename: BOOKKEEPING,
      errors: [{ messageId: 'opTableColumnEscape' }],
    },
    // A spread .set() cannot be proven a subset → rejected (fail closed).
    {
      code: `await db.updateTable('operations').set({ ...patch }).execute();`,
      options: COLUMN_OPTS,
      filename: BOOKKEEPING,
      errors: [{ messageId: 'opTableColumnEscape' }],
    },
    // DELETE is NEVER allowed on the op log — not even in the column-scoped bookkeeping file.
    {
      code: `await db.deleteFrom('operations').where('id', '=', id).execute();`,
      options: COLUMN_OPTS,
      filename: BOOKKEEPING,
      errors: [{ messageId: 'opTableMutation' }],
    },
  ],
});
