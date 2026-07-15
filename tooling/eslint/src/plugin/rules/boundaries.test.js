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
    // @bolusi/ui may import react-native and @expo/vector-icons (08 §3.3) — the styling-lib prong
    // must not over-match these legitimate RN imports.
    {
      code: `import { StyleSheet } from 'react-native';`,
      filename: '/repo/packages/ui/src/components/Button.tsx',
    },
    {
      code: `import MCI from '@expo/vector-icons/MaterialCommunityIcons.js';`,
      filename: '/repo/packages/ui/src/components/Icon.tsx',
    },
    // better-sqlite3 backs db-client's CI conformance adapter — test/ files only (§2.5)
    {
      code: `import Database from 'better-sqlite3';`,
      filename: '/repo/packages/db-client/test/better-sqlite3-adapter.ts',
    },
    // ...and its codegen tooling script (10-db §11.4 builds a scratch DB)
    {
      code: `import Database from 'better-sqlite3';`,
      filename: '/repo/packages/db-client/scripts/codegen.ts',
    },
    // better-sqlite3 remains the harness's simulated-device driver
    {
      code: `import Database from 'better-sqlite3';`,
      filename: '/repo/packages/harness/src/device.ts',
    },
    // db-client test/tooling files may use Node builtins; only its shipping source may not
    {
      code: `import { mkdtempSync } from 'node:fs';`,
      filename: '/repo/packages/db-client/scripts/codegen.ts',
    },
    {
      code: `import { tmpdir } from 'node:os';`,
      filename: '/repo/packages/db-client/test/migrations.test.ts',
    },
    // test-support types the conformance suite against db-client's driver interface
    // (type-only; the driver handle itself is injected by the runner — 08 §3.3 rule 7)
    {
      code: `import type { DbDriver } from '@bolusi/db-client';`,
      filename: '/repo/packages/test-support/src/driver-conformance/index.ts',
    },
    // a type-only re-export is still type-only
    {
      code: `export type { DbDriver } from '@bolusi/db-client';`,
      filename: '/repo/packages/test-support/src/index.ts',
    },
    // the type-only lock is scoped to test-support: db-client's OWN tests value-import it
    {
      code: `import { openClientDb } from '@bolusi/db-client';`,
      filename: '/repo/packages/db-client/test/dialect.test.ts',
    },
    // ...and the harness may value-import it (08 §3.3 harness row)
    {
      code: `import { openClientDb } from '@bolusi/db-client';`,
      filename: '/repo/packages/harness/src/device.ts',
    },
  ],
  invalid: [
    // styling/animation libraries are banned in v0 (design-system §7 lint (c) + 08 §2.6) — added
    // task 23. Reanimated in the ui package:
    {
      code: `import Animated from 'react-native-reanimated';`,
      filename: '/repo/packages/ui/src/components/Banner.tsx',
      errors: [{ messageId: 'stylingLib' }],
    },
    // NativeWind in a screen:
    {
      code: `import { styled } from 'nativewind';`,
      filename: '/repo/packages/modules/src/notes/screens/NotesList.tsx',
      errors: [{ messageId: 'stylingLib' }],
    },
    // a styling-lib subpath is caught via the package root:
    {
      code: `import { Theme } from '@shopify/restyle';`,
      filename: '/repo/apps/mobile/src/App.tsx',
      errors: [{ messageId: 'stylingLib' }],
    },
    // Tamagui core subpath:
    {
      code: `import { styled } from '@tamagui/core';`,
      filename: '/repo/packages/ui/src/components/Card.tsx',
      errors: [{ messageId: 'stylingLib' }],
    },
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
    // better-sqlite3 outside its owners → driver lock (drivers are injected into test-support)
    {
      code: `import Database from 'better-sqlite3';`,
      filename: '/repo/packages/test-support/src/drivers.ts',
      errors: [{ messageId: 'dbDriver' }],
    },
    // better-sqlite3 inside db-client SHIPPING SOURCE → test-only lock (08 §2.5).
    // This is the fixture that keeps the CI adapter out of the device bundle.
    {
      code: `import Database from 'better-sqlite3';`,
      filename: '/repo/packages/db-client/src/adapters/better-sqlite3.ts',
      errors: [{ messageId: 'dbDriverTestOnly' }],
    },
    // op-sqlite outside db-client, from the app that actually ships it (primary fixture)
    {
      code: `import { open } from '@op-engineering/op-sqlite';`,
      filename: '/repo/apps/mobile/src/bootstrap.ts',
      errors: [{ messageId: 'dbDriver' }],
    },
    // db-client is Hermes-only: no Node builtins in shipping source
    {
      code: `import { readFileSync } from 'node:fs';`,
      filename: '/repo/packages/db-client/src/connection.ts',
      errors: [{ messageId: 'nodeInHermesSource' }],
    },
    // test-support → db-client must be TYPE-ONLY (08 §3.3 hard rule 7).
    // The reviewer's constructed violation: a genuine VALUE import that every other
    // mechanism (consistent-type-imports, verbatimModuleSyntax, shipping-deps) misses.
    {
      code: `import { DbOpenError } from '@bolusi/db-client';`,
      filename: '/repo/packages/test-support/src/driver-conformance/index.ts',
      errors: [{ messageId: 'dbClientTypeOnly' }],
    },
    // ...including via a subpath, and via re-export
    {
      code: `import { openOpSqliteDriver } from '@bolusi/db-client/op-sqlite';`,
      filename: '/repo/packages/test-support/src/driver-conformance/index.ts',
      errors: [{ messageId: 'dbClientTypeOnly' }],
    },
    {
      code: `export { DbError } from '@bolusi/db-client';`,
      filename: '/repo/packages/test-support/src/index.ts',
      errors: [{ messageId: 'dbClientTypeOnly' }],
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
