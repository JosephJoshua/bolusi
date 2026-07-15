// Client codegen (10-db §11.4): build a scratch SQLite DB from ALL client migrations,
// run kysely-codegen against it, write the committed types. CI re-runs this and diffs —
// a migration landed without regenerating fails the build.
//
// The scratch DB is built with better-sqlite3 (test/tooling-only, never shipping source)
// because op-sqlite is a JSI native module and cannot run in Node (testing-guide §2.3).
// The DDL is identical either way: it is the same verbatim §9 statement set.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import { CLIENT_MIGRATIONS } from '../src/migrations/runner.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outFile = join(packageRoot, 'src/generated/db.ts');

const scratchDir = mkdtempSync(join(tmpdir(), 'bolusi-client-codegen-'));
const scratchDbPath = join(scratchDir, 'scratch.db');

try {
  const scratch = new Database(scratchDbPath);
  for (const migration of CLIENT_MIGRATIONS) {
    for (const statement of migration.statements) {
      scratch.exec(statement);
    }
  }
  scratch.close();

  execFileSync(
    'kysely-codegen',
    [
      '--dialect',
      'sqlite',
      '--url',
      scratchDbPath,
      '--out-file',
      outFile,
      // 10-db §11.4: --camel-case on BOTH sides. The server generates camelCase over the
      // same snake_case DDL (§11.3), so a module's appliers can be written once against
      // `ProjectionDb` and run against client SQLite and server Postgres alike (04 §2).
      // The runtime counterpart is `CamelCasePlugin` in src/connection.ts — the flag and
      // the plugin must be changed together or the types stop describing the queries.
      '--camel-case',
      '--log-level',
      'warn',
      '--type-only-imports',
    ],
    { cwd: packageRoot, stdio: 'inherit' },
  );
} finally {
  rmSync(scratchDir, { recursive: true, force: true });
}
