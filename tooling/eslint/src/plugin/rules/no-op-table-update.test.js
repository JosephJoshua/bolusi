import { RuleTester } from 'eslint';
import { describe, it } from 'vitest';

import rule from './no-op-table-update.js';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

tester.run('no-op-table-update', rule, {
  valid: [
    // mutating a projection table is fine — only the op log is append-only
    { code: `await db.updateTable('note_projections').set({ title }).execute();` },
    { code: `await db.deleteFrom('sync_cursors').execute();` },
    // inserts into operations are the normal append path
    { code: `await db.insertInto('operations').values(op).execute();` },
    // allowlisted bookkeeping file (exact-file allowlist, column depth = tasks 06/07)
    {
      code: `await db.updateTable('operations').set({ syncStatus: 'synced' }).execute();`,
      options: [{ allowFiles: ['packages/core/src/oplog/bookkeeping.ts'] }],
      filename: '/repo/packages/core/src/oplog/bookkeeping.ts',
    },
  ],
  invalid: [
    // Kysely updateTable('operations') → error (primary fixture)
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
  ],
});
