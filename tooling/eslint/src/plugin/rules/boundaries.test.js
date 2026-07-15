import { RuleTester } from 'eslint';
import { describe, it } from 'vitest';

import rule from './boundaries.js';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

// typescript-eslint parser understands `import type` (importKind); espree does not.
import tseslint from 'typescript-eslint';

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    parser: tseslint.parser,
  },
});

tester.run('boundaries', rule, {
  valid: [
    // The platform-free lock follows "runs on Hermes", not "is shipped". Build tooling and the
    // Node test lane (`test/**/*.test.*`) run only on Node — 08 §3.4's CI leg says so — and a
    // codegen/gate script cannot read the repo without node:fs. Anything under test/ that is NOT
    // a `.test.*` file is treated as Hermes-bound and stays locked (see the invalid fixtures).
    {
      code: `import { readFileSync } from 'node:fs';`,
      filename: '/repo/packages/i18n/scripts/check.mjs',
    },
    {
      code: `import { join } from 'node:path';`,
      filename: '/repo/packages/i18n/test/gates.test.ts',
    },
    {
      code: `import { readFileSync } from 'node:fs';`,
      filename: '/repo/packages/core/test/jcs-vectors/run.test.ts',
    },
    // db-client is THE importer of op-sqlite (08 §3.2)
    {
      code: `import { open } from '@op-engineering/op-sqlite';`,
      filename: '/repo/packages/db-client/src/connection.ts',
    },
    // core → schemas is a sanctioned edge (08 §3.3)
    {
      code: `import { opEnvelopeSchema } from '@bolusi/schemas';`,
      filename: '/repo/packages/core/src/oplog/append.ts',
    },
    // only apps/mobile may import */screens
    {
      code: `import { NotesScreen } from '@bolusi/modules/notes/screens';`,
      filename: '/repo/apps/mobile/src/navigation.tsx',
    },
    // harness may value-import the server app (in-process, test-only)
    {
      code: `import { routes } from '@bolusi/server';`,
      filename: '/repo/packages/harness/src/sim-server.ts',
    },
    // the single app→app edge: TYPE-only import of @bolusi/server/client (08 §4.3)
    {
      code: `import type { AppType } from '@bolusi/server/client';`,
      filename: '/repo/apps/mobile/src/transport.ts',
    },
    // db-server root entry (forTenant) is the public surface
    {
      code: `import { forTenant } from '@bolusi/db-server';`,
      filename: '/repo/apps/server/src/routers/sync.ts',
    },
    // pg inside db-server is its sanctioned home
    {
      code: `import pg from 'pg';`,
      filename: '/repo/packages/db-server/src/pool.ts',
    },
  ],
  invalid: [
    // op-sqlite outside db-client → error (primary fixture)
    {
      code: `import { open } from '@op-engineering/op-sqlite';`,
      filename: '/repo/packages/core/src/oplog/append.ts',
      errors: [{ messageId: 'dbDriver' }],
    },
    // */screens outside apps/mobile → error (primary fixture)
    {
      code: `import { NotesScreen } from '@bolusi/modules/notes/screens';`,
      filename: '/repo/apps/server/src/routers/sync.ts',
      errors: [{ messageId: 'screensOutsideMobile' }],
    },
    // value-import of @bolusi/server outside harness → error (primary fixture)
    {
      code: `import { routes } from '@bolusi/server';`,
      filename: '/repo/apps/mobile/src/transport.ts',
      errors: [{ messageId: 'serverImport' }],
    },
    // type-only import of a non-client server subpath is still forbidden
    {
      code: `import type { Internal } from '@bolusi/server/internal';`,
      filename: '/repo/apps/mobile/src/transport.ts',
      errors: [{ messageId: 'serverImport' }],
    },
    // platform-free package importing node builtin
    {
      code: `import { readFileSync } from 'node:fs';`,
      filename: '/repo/packages/core/src/oplog/append.ts',
      errors: [{ messageId: 'platformFree' }],
    },
    // A non-`.test.` file under test/ is Hermes-bound, not Node-lane: hermes-entry.ts is the
    // release-blocking stage-6 vector entry (08 §5.6). It is NOT shipped (rootDir=src,
    // files=["dist"]) yet still runs on Hermes — so "shipped" is the wrong test and this fixture
    // pins the hole shut.
    {
      code: `import { readFileSync } from 'node:fs';`,
      filename: '/repo/packages/i18n/test/hermes-entry.ts',
      errors: [{ messageId: 'platformFree' }],
    },
    {
      code: `import { Platform } from 'react-native';`,
      filename: '/repo/packages/i18n/test/hermes-entry.ts',
      errors: [{ messageId: 'platformFree' }],
    },
    {
      code: `import { readFileSync } from 'node:fs';`,
      filename: '/repo/packages/i18n/test/vectors.ts',
      errors: [{ messageId: 'platformFree' }],
    },
    // the non-shipped exemption is a directory carve-out, not a package one: src/ stays locked
    // even in a package whose scripts/ legitimately read the repo
    {
      code: `import { readFileSync } from 'node:fs';`,
      filename: '/repo/packages/i18n/src/generated/resources.ts',
      errors: [{ messageId: 'platformFree' }],
    },
    // a nested src path that merely mentions the word is still shipped code
    {
      code: `import { join } from 'node:path';`,
      filename: '/repo/packages/i18n/src/scripts-helper.ts',
      errors: [{ messageId: 'platformFree' }],
    },
    // platform-free package importing hono
    {
      code: `import { Hono } from 'hono';`,
      filename: '/repo/packages/schemas/src/envelope.ts',
      errors: [{ messageId: 'platformFree' }],
    },
    // pg outside db-server → driver lock
    {
      code: `import pg from 'pg';`,
      filename: '/repo/apps/server/src/db.ts',
      errors: [{ messageId: 'dbDriver' }],
    },
    // better-sqlite3 outside harness → driver lock (drivers are injected into test-support)
    {
      code: `import Database from 'better-sqlite3';`,
      filename: '/repo/packages/test-support/src/drivers.ts',
      errors: [{ messageId: 'dbDriver' }],
    },
    // deprecated @hono/node-ws is banned everywhere (08 §2.6)
    {
      code: `import { createNodeWebSocket } from '@hono/node-ws';`,
      filename: '/repo/apps/server/src/realtime.ts',
      errors: [{ messageId: 'forbiddenEverywhere' }],
    },
    // expo-file-system/legacy throws at runtime in SDK 57 (08 §2.2)
    {
      code: `import * as FileSystem from 'expo-file-system/legacy';`,
      filename: '/repo/apps/mobile/src/media/upload.ts',
      errors: [{ messageId: 'forbiddenEverywhere' }],
    },
    // deep import into db-server = raw-db-handle escape hatch → forbidden (FR-1039)
    {
      code: `import { pool } from '@bolusi/db-server/internal/pool';`,
      filename: '/repo/apps/server/src/routers/sync.ts',
      errors: [{ messageId: 'dbServerDeepImport' }],
    },
    // dynamic import is covered too
    {
      code: `const mod = await import('@op-engineering/op-sqlite');`,
      filename: '/repo/packages/ui/src/tokens.ts',
      errors: [{ messageId: 'dbDriver' }],
    },
  ],
});
