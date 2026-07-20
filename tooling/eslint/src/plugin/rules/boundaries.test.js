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
    // core → canonicalize: the JCS wrapper is its only importer (08 §3.3)
    {
      code: `import canonicalize from 'canonicalize';`,
      filename: '/repo/packages/core/src/crypto/jcs.ts',
    },
    // noble is allowed exactly where the matrix grants it (08 §3.3): test-support…
    {
      code: `import { ed25519 } from '@noble/curves/ed25519.js';`,
      filename: '/repo/packages/test-support/src/crypto/noble-port.ts',
    },
    // …the harness…
    {
      code: `import { sha256 } from '@noble/hashes/sha2.js';`,
      filename: '/repo/packages/harness/src/device.ts',
    },
    // …and the server's own adapter.
    {
      code: `import { ed25519 } from '@noble/curves/ed25519.js';`,
      filename: '/repo/apps/server/src/crypto.ts',
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
    // ...and core's projection-engine tests drive the shim over better-sqlite3 (task 08,
    // testing-guide §2.3): test/ files only, never shipping source (invalid case below).
    {
      code: `import Database from 'better-sqlite3';`,
      filename: '/repo/packages/core/test/projection/better-sqlite3-driver.ts',
    },
    // ...and packages/modules (task 25 — `notes`, the first module outside core) drives the shim in
    // its T-8 conformance suite: test/ files only, never shipping source (invalid case below).
    {
      code: `import Database from 'better-sqlite3';`,
      filename: '/repo/packages/modules/test/support/better-sqlite3-driver.ts',
    },
    // @electric-sql/pglite is the harness's OWN shipping driver (a runtime dep — the harness IS test
    // tooling), so like better-sqlite3's harness row it is unrestricted here. This is the positive
    // control on the exemption: the fix is not a blanket pglite ban (task 42, review-03).
    {
      code: `import { PGlite } from '@electric-sql/pglite';`,
      filename: '/repo/packages/harness/src/device.ts',
    },
    // ...and core's applier-conformance suite drives the projection engine against in-process PGlite
    // (task 11 — T-8): test/ files only, never shipping source (invalid cases below).
    {
      code: `import { PGlite } from '@electric-sql/pglite';`,
      filename: '/repo/packages/core/test/module/applier-conformance.test.ts',
    },
    // ...and db-server / apps-server carry pglite as a devDep for their own test lanes.
    {
      code: `import { PGlite } from '@electric-sql/pglite';`,
      filename: '/repo/packages/db-server/test/watermarks.test.ts',
    },
    {
      code: `import { PGlite } from '@electric-sql/pglite';`,
      filename: '/repo/apps/server/test/integration/projection.test.ts',
    },
    // ...and packages/modules (task 25 — `notes`) drives PGlite in its T-8 dual-dialect suite.
    {
      code: `import { PGlite } from '@electric-sql/pglite';`,
      filename: '/repo/packages/modules/test/support/engines.ts',
    },
    // ── task 95: SUBPATH imports resolve to the driver's package root, so a subpath is treated
    // exactly as the bare specifier. VALID side — a driver subpath stays clean wherever the bare
    // specifier would: a testOnly owner's TEST files, or an unrestricted owner's shipping source.
    // These prove the generalized packageRoot() lookup (which replaced op-sqlite's per-driver
    // special case) did NOT over-block. (Denominator: 4 drivers × {bare, subpath} × {shipping,
    // test} — these are the {subpath, test/owner-clean} rows; the {bare, *} rows are above.)
    //
    // pglite/worker (the real DB surface — PGliteWorker) from core's TEST lane: clean (core is a
    // testOnly owner; test files are permitted). Mirror of the pinned invalid case below.
    {
      code: `import { PGliteWorker } from '@electric-sql/pglite/worker';`,
      filename: '/repo/packages/core/test/module/applier-conformance.test.ts',
    },
    // ...and pglite/worker in the harness's OWN shipping source stays CLEAN — the harness is an
    // UNRESTRICTED owner (task 26 added it to the allowlist; task 42 kept it). The subpath
    // normalization must not regress that exemption.
    {
      code: `import { PGliteWorker } from '@electric-sql/pglite/worker';`,
      filename: '/repo/packages/harness/src/device.ts',
    },
    // better-sqlite3 subpath in a db-client TEST file (its CI conformance adapter): clean.
    {
      code: `import Database from 'better-sqlite3/lib/database.js';`,
      filename: '/repo/packages/db-client/test/better-sqlite3-adapter.ts',
    },
    // pg subpath inside db-server (its unrestricted owner) shipping source: clean.
    {
      code: `import Client from 'pg/lib/client.js';`,
      filename: '/repo/packages/db-server/src/pool.ts',
    },
    // op-sqlite subpath inside db-client (its unrestricted owner) shipping source: clean — the
    // generalized packageRoot() keeps @op-engineering/op-sqlite/* resolving to the driver, as the
    // deleted special case did.
    {
      code: `import { open } from '@op-engineering/op-sqlite/sync';`,
      filename: '/repo/packages/db-client/src/connection.ts',
    },
    // ── task 104: the platform-free prong now matches on the package root too. These are the
    // controls proving that did not turn into a blanket ban.
    //
    // (a) POSITIVE CONTROL — `ws` is forbidden only in PLATFORM-FREE packages. apps/server is
    // platform-bound and legitimately speaks WebSocket (08 §3.2 — the Hono app's `upgradeWebSocket`
    // lane), so both the bare specifier and a subpath stay CLEAN there. If these ever go red the
    // fix has over-reached into a blanket ban.
    {
      code: `import WebSocket from 'ws';`,
      filename: '/repo/apps/server/src/realtime/socket.ts',
    },
    {
      code: `import WebSocket from 'ws/lib/websocket.js';`,
      filename: '/repo/apps/server/src/realtime/socket.ts',
    },
    // (b) OVER-MATCH CONTROL — a DIFFERENT package whose name merely starts with a forbidden one.
    // `packageRoot('ws-utils/lib/parse.js')` is `ws-utils`, which `/^ws$/` does not match, and
    // `packageRoot('pg-format/lib/index.js')` is `pg-format`, which `/^pg$/` does not match and
    // which is not a DB_DRIVER_OWNERS key. Both stay clean IN A PLATFORM-FREE PACKAGE — the
    // strictest place — so an anchored entry cannot grow a prefix match by accident.
    {
      code: `import { parse } from 'ws-utils/lib/parse.js';`,
      filename: '/repo/packages/core/src/sync/transport.ts',
    },
    {
      code: `import format from 'pg-format/lib/index.js';`,
      filename: '/repo/packages/core/src/sync/transport.ts',
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
    // the test-only lane seam (@bolusi/db-server/testing[/budget]) is importable from NON-shipping
    // files so apps/server's L3 suites reach real PG16 while `pg` stays locked to db-server (task
    // 81). Test helper, .test.ts, and vitest.config — all outside shipping source (invalid below).
    {
      code: `import { createTestDatabase } from '@bolusi/db-server/testing';`,
      filename: '/repo/apps/server/test/helpers/media-db.ts',
    },
    {
      code: `import { setupPgLane } from '@bolusi/db-server/testing';`,
      filename: '/repo/apps/server/test/integration/oplog/helpers.test.ts',
    },
    {
      code: `import { MAX_PARALLEL_FILES } from '@bolusi/db-server/testing/budget';`,
      filename: '/repo/apps/server/vitest.config.ts',
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
    // core must BIND a crypto provider through CryptoPort, never import one (08 §3.3/§2.6)
    {
      code: `import { ed25519 } from '@noble/curves/ed25519.js';`,
      filename: '/repo/packages/core/src/crypto/signed-core.ts',
      errors: [{ messageId: 'platformFree' }],
    },
    {
      code: `import { sha256 } from '@noble/hashes/sha2.js';`,
      filename: '/repo/packages/modules/src/notes/ops.ts',
      errors: [{ messageId: 'platformFree' }],
    },
    // ── task 104: the platform-free prong matches the import's PACKAGE ROOT, so a SUBPATH of a
    // forbidden package is caught exactly as its bare specifier is. `ws` was the last exact-match
    // holdout (`/^ws$/`): before this, `ws/lib/websocket.js` from a platform-free package escaped
    // the prong entirely while bare `ws` was blocked. Both rows are pinned — the bare one so the
    // normalization cannot silently stop matching, the subpath one so the hole cannot reopen.
    // (Denominator for the ws leg: {bare, subpath} × {platform-free importer, platform-BOUND
    // importer} = 4 rows — these 2 invalid, the 2 valid controls in the valid[] block above.)
    {
      code: `import WebSocket from 'ws';`,
      filename: '/repo/packages/core/src/sync/transport.ts',
      errors: [{ messageId: 'platformFree' }],
    },
    {
      code: `import WebSocket from 'ws/lib/websocket.js';`,
      filename: '/repo/packages/core/src/sync/transport.ts',
      errors: [{ messageId: 'platformFree' }],
    },
    // ...and the same normalization for the OTHER entries in the list, so the fix is tested as a
    // class and not as the one instance that prompted it (T-12). hono/expo/react-native already
    // matched subpaths via their own `($|\/|-)` alternations; these rows pin that the packageRoot
    // switch did not regress them.
    {
      code: `import { cors } from 'hono/cors';`,
      filename: '/repo/packages/schemas/src/envelope.ts',
      errors: [{ messageId: 'platformFree' }],
    },
    {
      code: `import { Platform } from 'react-native/Libraries/Utilities/Platform.js';`,
      filename: '/repo/packages/i18n/src/format.ts',
      errors: [{ messageId: 'platformFree' }],
    },
    {
      code: `import { getInfoAsync } from 'expo-file-system/next';`,
      filename: '/repo/packages/modules/src/notes/queries.ts',
      errors: [{ messageId: 'platformFree' }],
    },
    {
      code: `import { readFileSync } from 'node:fs/promises';`,
      filename: '/repo/packages/core/src/oplog/append.ts',
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
    // ...same for core: a test-only owner, so its SHIPPING source is still barred (task 08).
    {
      code: `import Database from 'better-sqlite3';`,
      filename: '/repo/packages/core/src/projection/engine.ts',
      errors: [{ messageId: 'dbDriverTestOnly' }],
    },
    // ...and packages/modules is a test-only owner too (task 25): its SHIPPING source (the manifest
    // that ships in dist/) is still barred — the drivers belong to its test/ suites only.
    {
      code: `import Database from 'better-sqlite3';`,
      filename: '/repo/packages/modules/src/notes/applier.ts',
      errors: [{ messageId: 'dbDriverTestOnly' }],
    },
    // @electric-sql/pglite is the SAME class as better-sqlite3, and until task 42 the lock did not
    // name it — so a real Postgres engine reached shipping source uncaught (review-03's positive
    // control: better-sqlite3 BLOCKED, pglite CLEAN, same file). These fixtures pin the gap shut in
    // each testOnly owner's SHIPPING source:
    {
      code: `import { PGlite } from '@electric-sql/pglite';`,
      filename: '/repo/packages/core/src/projection/engine.ts',
      errors: [{ messageId: 'dbDriverTestOnly' }],
    },
    {
      code: `import { PGlite } from '@electric-sql/pglite';`,
      filename: '/repo/packages/db-server/src/pool.ts',
      errors: [{ messageId: 'dbDriverTestOnly' }],
    },
    {
      code: `import { PGlite } from '@electric-sql/pglite';`,
      filename: '/repo/packages/modules/src/notes/applier.ts',
      errors: [{ messageId: 'dbDriverTestOnly' }],
    },
    {
      code: `import { PGlite } from '@electric-sql/pglite';`,
      filename: '/repo/apps/server/src/db.ts',
      errors: [{ messageId: 'dbDriverTestOnly' }],
    },
    // ...and outside every pglite owner → the ownerless driver lock (db-client is Hermes-only and
    // never runs Postgres; even a test file there is barred — the driver is injected, never imported)
    {
      code: `import { PGlite } from '@electric-sql/pglite';`,
      filename: '/repo/packages/db-client/src/connection.ts',
      errors: [{ messageId: 'dbDriver' }],
    },
    // ...dynamic import from a non-owner is caught too (same visitor as op-sqlite's dynamic case)
    {
      code: `const mod = await import('@electric-sql/pglite');`,
      filename: '/repo/packages/schemas/src/envelope.ts',
      errors: [{ messageId: 'dbDriver' }],
    },
    // ── task 95: SUBPATH imports must be caught exactly as the bare specifier. INVALID side — a
    // driver subpath from a shipping non-owner path goes RED with the SAME message the bare
    // specifier produces from that same path. Before the packageRoot() normalization these three
    // (pglite, better-sqlite3, pg) escaped uncaught — op-sqlite was already immune via its special
    // case — which is the whole finding (rev-42). (Denominator: 4 drivers × {bare, subpath} ×
    // {shipping, test} — these are the {subpath, shipping} rows; {subpath, test/owner-clean} is the
    // valid block above, {bare, *} are the other driver fixtures.)
    //
    // THE LOAD-BEARING CASE. @electric-sql/pglite/worker exports PGliteWorker — a real SQL-running
    // DB surface — and reached shipping core uncaught. Pinned to the SAME message the bare pglite
    // import produces from this exact file (dbDriverTestOnly: core is a testOnly owner, shipping
    // src is barred).
    {
      code: `import { PGliteWorker } from '@electric-sql/pglite/worker';`,
      filename: '/repo/packages/core/src/projection/engine.ts',
      errors: [{ messageId: 'dbDriverTestOnly' }],
    },
    // ...and pglite/live from a true NON-owner (schemas) → the ownerless driver lock, same message
    // as the bare dynamic-import fixture above.
    {
      code: `import x from '@electric-sql/pglite/live';`,
      filename: '/repo/packages/schemas/src/envelope.ts',
      errors: [{ messageId: 'dbDriver' }],
    },
    // better-sqlite3 subpath in db-client SHIPPING source → the test-only lock, same as bare.
    {
      code: `import Database from 'better-sqlite3/lib/database.js';`,
      filename: '/repo/packages/db-client/src/adapters/better-sqlite3.ts',
      errors: [{ messageId: 'dbDriverTestOnly' }],
    },
    // pg subpath outside db-server → the driver lock, same as bare `pg`. (Also closes a second
    // hole: the platform-free prong's /^pg$/ never matched `pg/*`, so before task 95 a pg subpath
    // escaped BOTH locks.)
    {
      code: `import Client from 'pg/lib/client.js';`,
      filename: '/repo/apps/server/src/db.ts',
      errors: [{ messageId: 'dbDriver' }],
    },
    // op-sqlite subpath outside db-client → the driver lock. Regression guard for the DELETED
    // special case: packageRoot() must keep @op-engineering/op-sqlite/* locked (it did via
    // startsWith before; now via the general mechanism).
    {
      code: `import { open } from '@op-engineering/op-sqlite/sync';`,
      filename: '/repo/packages/core/src/oplog/append.ts',
      errors: [{ messageId: 'dbDriver' }],
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
    // the /testing carve-out is SCOPED to non-shipping files: the raw-handle test factory must
    // never reach production source, or FR-1039 is weakened (task 81). Same seam, SHIPPING file:
    {
      code: `import { createTestDatabase } from '@bolusi/db-server/testing';`,
      filename: '/repo/apps/server/src/deps.ts',
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
