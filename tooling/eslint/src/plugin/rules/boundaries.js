// bolusi/boundaries — whole-repo rule; the importer's workspace is derived from the file path.
// IMPLEMENTED DEPTH (deny-list half of 08 §3.3/§3.4/§2.6):
//   1. §2.6 banned packages everywhere (@hono/node-ws, expo-background-fetch,
//      expo-file-system/legacy, kysely-expo)
//   2. DB-driver locks (op-sqlite → db-client only; pg → db-server only;
//      better-sqlite3 → harness, plus db-client AND core TEST/TOOLING files only — it is the
//      CI adapter behind the shim dialect (testing-guide §2.3) that the driver-conformance
//      suite and the core projection-engine tests both drive, and must never reach shipping
//      source; @electric-sql/pglite → harness (ships legitimately as test tooling — a runtime
//      dep there, held out of every SHIPPING_WORKSPACES bundle by shipping-deps.test.ts), plus
//      core, db-server AND apps/server TEST/TOOLING files only — it is the in-process Postgres
//      the applier-conformance suite runs, a test-only engine that must never reach shipping
//      source any more than better-sqlite3 does)
//   2b. db-client is Hermes-only: no node:* in its shipping source (08 §3.2)
//   3. */screens subpaths importable only from apps/mobile
//   4. @bolusi/server edge (harness value-import only; type-only ./client elsewhere)
//   5. nothing imports @bolusi/mobile
//   6. §3.4 platform-free deny prefixes for core/schemas/i18n/modules-manifest
//      (incl. @noble/* — crypto providers are injected via CryptoPort, never imported;
//      added by task 03, the task that introduced noble to the repo)
//   7. forTenant-only / no-raw-db-handle lock: no deep imports into @bolusi/db-server (FR-1039),
//      EXCEPT the test-only lane seam `@bolusi/db-server/testing[/budget]` from NON-shipping files
//      (tests, harness helpers, vitest configs) — how apps/server's L3 suites reach real PG16 while
//      `pg` stays locked to db-server (task 81). Shipping source stays fully banned.
// NOT YET IMPLEMENTED: the full §3.3 POSITIVE allow-matrix ("anything not listed is
// forbidden" — e.g. schemas importing @bolusi/core would pass today). Owner: task 28
// (security-sweep) hardens this rule to the full matrix, or earlier if a task adds a
// new inter-package edge that the deny-list cannot see.

const FORBIDDEN_EVERYWHERE = new Map([
  ['@hono/node-ws', 'deprecated — upgradeWebSocket comes from @hono/node-server 2.x (08 §2.6)'],
  ['expo-background-fetch', 'deprecated — use expo-background-task (08 §2.6)'],
  ['expo-file-system/legacy', 'legacy re-exports throw at runtime in SDK 57 (08 §2.2)'],
  ['kysely-expo', 'rejected — we own the op-sqlite dialect shim (08 §2.6)'],
  // 06-media-pipeline §2.1 (FR-818): evidence media is capturable ONLY through the in-app camera,
  // and the enforcement is deliberately STRUCTURAL rather than per-screen — "the shared
  // MediaCapture component is the only capture surface, and `expo-image-picker` is a banned
  // import (lint rule, same class as the no-UPDATE-on-operations rule)". v0 has no non-evidence
  // media surface, so the ban is repo-wide with no exemption. Added task 18. The package is not
  // installed today, which is exactly when to add the ban: it costs nothing now and refuses the
  // one-line `expo install expo-image-picker` that would otherwise quietly re-open gallery import
  // of "evidence" a technician never photographed.
  [
    'expo-image-picker',
    'gallery selection may never exist where evidence is required — live capture only, via the shared MediaCapture component (06-media-pipeline §2.1, FR-818)',
  ],
]);

// Styling / animation libraries banned in v0 (design-system §7 lint (c) + 08 §2.6). No workspace
// legitimately imports these — the design system is tokens + StyleSheet, zero styling deps, on the
// 2 GB-RAM budget. Matched as package roots (bare name or a subpath). `react-native-reanimated` is
// "cautioned — avoid in v0" (08 §2.6): v0 UI must not need it, so importing it is an error until a
// doc change says otherwise. Added task 23.
const STYLING_FORBIDDEN = new Map([
  ['nativewind', 'no styling library in v0 — tokens + StyleSheet only (design-system §7)'],
  ['tamagui', 'no styling library in v0 — tokens + StyleSheet only (design-system §7)'],
  ['@tamagui/core', 'no styling library in v0 — tokens + StyleSheet only (design-system §7)'],
  ['styled-components', 'no styling library in v0 — tokens + StyleSheet only (design-system §7)'],
  ['@shopify/restyle', 'no styling library in v0 — tokens + StyleSheet only (design-system §7)'],
  [
    'react-native-reanimated',
    'cautioned — avoid in v0 (~25–30% Android memory inflation on RN 0.86 Hermes); v0 UI must not need it (design-system §7, 08 §2.6)',
  ],
  ['lottie-react-native', 'no animation library in v0 — no Lottie (design-system §7)'],
  ['moti', 'no animation library in v0 (design-system §7)'],
]);

/** Root package of an import specifier: `@scope/pkg/sub` → `@scope/pkg`; `pkg/sub` → `pkg`. */
function packageRoot(source) {
  if (source.startsWith('@')) {
    const parts = source.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : source;
  }
  return source.split('/')[0];
}

// DB drivers may be imported only by their owning wrapper (08 §3.3 hard rule 2).
// `testOnly` owners may import the driver from test/tooling files but NOT from shipping
// source: better-sqlite3 is test-only (08 §2.5) and backs both the harness's simulated
// devices and db-client's CI conformance adapter (testing-guide §2.3). @electric-sql/pglite is
// the same species — a test-only engine (the in-process Postgres the applier-conformance suite
// runs) — with one asymmetry: the harness ships it as a REAL runtime dep (test tooling is what
// the harness IS), so harness is an UNRESTRICTED owner, while core/db-server/apps-server carry it
// as a devDep and are `testOnly`. Without an entry here nothing catches pglite in shipping source:
// the lock looked complete because it named the driver everyone tests with (better-sqlite3) and
// missed the one it did not (review-03, task 42 — a guard that covers the cases you think of).
const DB_DRIVER_OWNERS = new Map([
  ['@op-engineering/op-sqlite', [{ workspace: 'packages/db-client' }]],
  ['pg', [{ workspace: 'packages/db-server' }]],
  [
    'better-sqlite3',
    [
      { workspace: 'packages/harness' },
      { workspace: 'packages/db-client', testOnly: true },
      // core's projection-engine tests (task 08) drive the shim dialect over better-sqlite3
      // :memory: (testing-guide §2.3); test/tooling files only — shipping core stays clean.
      { workspace: 'packages/core', testOnly: true },
      // apps/mobile's bootstrap suite (task 50) drives the REAL `bootstrap()` — open, migrate,
      // register — over better-sqlite3 :memory:, for the same reason and under the same rule as
      // core's entry above: op-sqlite is a JSI native module that cannot load under Node
      // (testing-guide §2.3), so the CI adapter is the only way to run the real migrations against
      // a real SQLite engine. Shipping mobile source stays clean — `testOnly` is what enforces
      // that, and it matters more here than anywhere: apps/mobile is the DEVICE BUNDLE, so a
      // better-sqlite3 import reaching shipping source would try to bundle a Node addon into an
      // APK. The `dependencies` half of the same lock is `shipping-deps.test.ts`, which asserts
      // apps/mobile declares no test-only driver as a runtime dep (devDependencies is where it
      // belongs — the db-client shape).
      { workspace: 'apps/mobile', testOnly: true },
      // packages/modules is the FIRST module package outside core (task 25 — `notes`). Its T-8
      // applier-conformance + engine suites drive the shim over better-sqlite3 :memory(testing-guide
      // §2.3), for the same reason and under the same rule as core's entry above. test/tooling files
      // ONLY — shipping the module manifest (dist/) stays driver-free; the drivers are devDeps.
      { workspace: 'packages/modules', testOnly: true },
    ],
  ],
  [
    '@electric-sql/pglite',
    [
      // The harness ships pglite as a real runtime dependency (it is test tooling, held out of
      // every shipping bundle by shipping-deps.test.ts's SHIPPING_WORKSPACES sweep), so it is an
      // unrestricted owner — no `testOnly`. This is the positive control on the exemption: a
      // pglite import in packages/harness stays CLEAN, so the fix is not a blanket ban.
      { workspace: 'packages/harness' },
      // core's applier-conformance suite (task 11 — T-8) runs the projection engine against a real
      // Postgres via in-process PGlite; test/tooling files only, shipping core stays clean.
      { workspace: 'packages/core', testOnly: true },
      // db-server and apps/server carry pglite as a devDep for the same test-only reason.
      { workspace: 'packages/db-server', testOnly: true },
      { workspace: 'apps/server', testOnly: true },
      // packages/modules (task 25 — `notes`, the first module outside core) runs the SAME T-8
      // dual-dialect conformance against in-process PGlite; test/tooling files only, shipping dist
      // stays clean.
      { workspace: 'packages/modules', testOnly: true },
    ],
  ],
]);

// Hermes-only workspaces: shipping source cannot use Node builtins (08 §3.2). Files
// outside the shipped bundle legitimately do (codegen scripts, the CI test lane).
const NODE_FREE_SOURCE = new Set(['packages/db-client']);

/**
 * "Is this file outside the SHIPPED bundle?" — feeds the driver lock and the db-client
 * node-free lock.
 *
 * ### DO NOT MERGE THIS WITH `NODE_LANE_ONLY` (below). They are not the same rule.
 *
 * They look interchangeable — both are "test-ish file?" predicates over the same directory
 * shapes — and they are not. One file from each package proves it, same shape, OPPOSITE
 * correct answers:
 *
 *  - `packages/db-client/test/better-sqlite3-adapter.ts` — non-`.test.ts` helper importing
 *    better-sqlite3. MUST be exempt here: it runs on Node in CI and is never bundled.
 *  - `packages/i18n/test/hermes-entry.ts` — non-`.test.ts` helper that RUNS ON HERMES as
 *    the stage-6 vector entry. MUST NOT be exempt from the platform-free prong.
 *
 * Because the questions differ: "may this import a Node-only test driver?" (packaging —
 * 08 §2.5, answered here) vs "must this survive on Hermes?" (platform — 08 §3.4, answered
 * by NODE_LANE_ONLY). DRY them and the task-22 hole reopens silently.
 *
 * CAVEAT for the node-free prong: this predicate exempts any file under `test/`, so a
 * Hermes-BUNDLED helper placed in `packages/db-client/test/` would slip the node:* lock.
 * None exists today (db-client's L6 code is shipping source under `src/adapters/`, and the
 * on-device suite lives in test-support/apps). If db-client ever gains one, move THIS
 * prong to `NODE_LANE_ONLY` — do not loosen that constant.
 */
function isOutsideShippingSource(filename) {
  return (
    /\.test\.[cm]?[jt]sx?$/.test(filename) ||
    /(?:^|\/)(?:test|tests|scripts)\//.test(filename) ||
    /\/vitest\.config\.[cm]?[jt]s$/.test(filename)
  );
}

// Platform-free workspaces (08 §3.3 hard rule 3). modules screens files are exempt.
const PLATFORM_FREE = new Set([
  'packages/core',
  'packages/schemas',
  'packages/i18n',
  'packages/modules',
]);
/**
 * Files exempt from the platform-free prong (08 §3.4).
 *
 * The invariant is "runs on Hermes ⇒ platform-free" — NOT "shipped ⇒ platform-free". Those look
 * identical until you hit the counterexample: `packages/i18n/test/hermes-entry.ts` is not shipped
 * (rootDir=src, files=["dist"]) and still runs on Hermes as the release-blocking stage-6 vector
 * entry. Exempting all of `test/` would un-guard exactly that file, and it is not covered
 * elsewhere: for the vector bundle, lock 1 (tsconfig `types: []`) is off under test/, lock 3 (CI
 * stage 6) is still a placeholder — so this rule is the only lock left standing.
 *
 * Hence: `scripts/` (build tooling, never runs anywhere but Node) plus only `test/**\/*.test.*`
 * (the Node test lane — 08 §3.4's CI leg runs these packages' unit tests on Node by design). The
 * `.test.` suffix IS the Node-lane marker: a Hermes-bundled entry cannot carry a test-runner
 * import, which is why it never has one.
 */
const NODE_LANE_ONLY = /\/scripts\/|\/test\/.*\.test\.[tj]sx?$/;
const PLATFORM_FORBIDDEN = [
  /^node:/,
  /^react-native($|\/|-)/,
  /^expo($|\/|-)/,
  /^@expo\//,
  /^pg$/,
  /^hono($|\/)/,
  /^@hono\//,
  /^ws$/,
  /^@op-engineering\//,
  // Crypto providers are BOUND, never imported, by platform-free packages: core declares
  // CryptoPort and test-support/harness/apps-server bind noble, apps/mobile binds
  // quick-crypto (08 §3.3 matrix; D8). noble in core would also be pure-JS crypto on a
  // Hermes hot path — 100x+ too slow, forbidden outright by 08 §2.6.
  /^@noble\//,
];

function workspaceOf(filename) {
  const normalized = String(filename ?? '').replace(/\\/g, '/');
  const match = normalized.match(/(?:^|\/)(apps|packages|tooling)\/([^/]+)\//);
  return match ? `${match[1]}/${match[2]}` : null;
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Import-boundary matrix (ai-docs/08-stack-and-repo.md §3.3–3.4): platform-free packages, DB-driver locks, screens split, type-only app edge',
    },
    messages: {
      forbiddenEverywhere: "'{{source}}' is forbidden: {{reason}}",
      dbDriver:
        "Only {{owner}} may import the DB driver '{{source}}' (08-stack-and-repo §3.3 — nothing outside the wrappers touches a driver).",
      dbDriverTestOnly:
        "'{{source}}' is test-only (08-stack-and-repo §2.5) and must never reach shipping source — import it from a test/ or scripts/ file, and inject the driver into the code under test.",
      nodeInHermesSource:
        "'{{source}}': {{workspace}} is Hermes-only — Node builtins do not exist on device (08-stack-and-repo §3.2). Files under test/ and scripts/ may use them; shipping source may not.",
      dbClientTypeOnly:
        "'{{source}}': @bolusi/test-support may import @bolusi/db-client TYPE-ONLY (08-stack-and-repo §3.3 hard rule 7) — the conformance suite types against the one DbDriver interface, but must carry no runtime edge to it. Use `import type`, and let the runner inject the driver handle.",
      screensOutsideMobile:
        "'{{source}}': */screens subpaths are Hermes-only UI and may be imported only from apps/mobile (08-stack-and-repo §3.2 modules row).",
      serverImport:
        "'{{source}}': @bolusi/server may be value-imported only by @bolusi/harness; the sole app→app edge is a type-only import of '@bolusi/server/client' (08-stack-and-repo §4.3).",
      stylingLib: "'{{source}}' is forbidden: {{reason}}.",
      appImport: "'{{source}}': nothing imports the mobile app (08-stack-and-repo §3.3).",
      platformFree:
        "'{{source}}' is platform-bound; {{workspace}} is platform-free — no node:*, react-native*, expo*, pg, hono*, ws, @op-engineering/*, @noble/* (08-stack-and-repo §3.4). Crypto providers are injected via CryptoPort, never imported (§3.3, D8).",
      dbServerDeepImport:
        "'{{source}}': deep imports into @bolusi/db-server are forbidden — forTenant() on the public entry is the ONLY way to query tenant tables; the raw db handle is not exported (FR-1039, 08-stack-and-repo §3.2).",
    },
    schema: [],
  },
  create(context) {
    const workspace = workspaceOf(context.filename);
    const filename = String(context.filename ?? '').replace(/\\/g, '/');

    function check(node, source, importKind) {
      // 1. Banned packages, anywhere.
      const banReason = FORBIDDEN_EVERYWHERE.get(source);
      if (banReason) {
        context.report({
          node,
          messageId: 'forbiddenEverywhere',
          data: { source, reason: banReason },
        });
        return;
      }
      // 1b. Styling/animation libraries, anywhere (design-system §7 lint (c) + 08 §2.6). Matched on
      // the package root so subpath imports are caught too.
      const stylingReason = STYLING_FORBIDDEN.get(packageRoot(source));
      if (stylingReason) {
        context.report({ node, messageId: 'stylingLib', data: { source, reason: stylingReason } });
        return;
      }
      // 2. DB-driver locks.
      const driverKey = source.startsWith('@op-engineering/')
        ? '@op-engineering/op-sqlite'
        : source;
      const owners = DB_DRIVER_OWNERS.get(driverKey);
      if (owners) {
        const owned = owners.find((entry) => entry.workspace === workspace);
        if (!owned) {
          context.report({
            node,
            messageId: 'dbDriver',
            data: { source, owner: owners.map((entry) => entry.workspace).join(' / ') },
          });
          return;
        }
        // Owned, but test-only: shipping source in the owning workspace is still barred.
        if (owned.testOnly && !isOutsideShippingSource(filename)) {
          context.report({ node, messageId: 'dbDriverTestOnly', data: { source } });
          return;
        }
      }

      // 2b. Hermes-only workspaces: no Node builtins in shipping source.
      if (
        workspace &&
        NODE_FREE_SOURCE.has(workspace) &&
        /^node:/.test(source) &&
        !isOutsideShippingSource(filename)
      ) {
        context.report({ node, messageId: 'nodeInHermesSource', data: { source, workspace } });
        return;
      }
      // 2c. test-support → db-client is TYPE-ONLY (08 §3.3 hard rule 7).
      // Nothing else enforces it: `consistent-type-imports` does not fire on a genuine
      // value import, `verbatimModuleSyntax` only preserves what you write, and the
      // shipping-deps test reads `dependencies` of shipping workspaces only. Without this
      // prong, `import { DbOpenError } from '@bolusi/db-client'` in test-support/src would
      // put a runtime edge into its emitted JS with nothing objecting.
      if (
        workspace === 'packages/test-support' &&
        (source === '@bolusi/db-client' || source.startsWith('@bolusi/db-client/')) &&
        importKind !== 'type'
      ) {
        context.report({ node, messageId: 'dbClientTypeOnly', data: { source } });
        return;
      }
      // 3. */screens subpaths only from apps/mobile.
      if (/\/screens(\/|$)/.test(source) && workspace !== 'apps/mobile') {
        context.report({ node, messageId: 'screensOutsideMobile', data: { source } });
        return;
      }
      // 4. @bolusi/server: harness-only value import; type-only ./client subpath elsewhere.
      if (source === '@bolusi/server' || source.startsWith('@bolusi/server/')) {
        const allowed =
          workspace === 'packages/harness' ||
          (importKind === 'type' && source === '@bolusi/server/client');
        if (!allowed) {
          context.report({ node, messageId: 'serverImport', data: { source } });
          return;
        }
      }
      // 5. Nothing imports the mobile app.
      if (source === '@bolusi/mobile' || source.startsWith('@bolusi/mobile/')) {
        context.report({ node, messageId: 'appImport', data: { source } });
        return;
      }
      // 6. Platform-free workspaces (modules screens files exempt).
      if (
        workspace &&
        PLATFORM_FREE.has(workspace) &&
        !(workspace === 'packages/modules' && /\/screens\//.test(filename)) &&
        !NODE_LANE_ONLY.test(filename) &&
        PLATFORM_FORBIDDEN.some((re) => re.test(source))
      ) {
        context.report({ node, messageId: 'platformFree', data: { source, workspace } });
        return;
      }
      // 7. forTenant-only / no-raw-db-handle import lock.
      if (source.startsWith('@bolusi/db-server/') && workspace !== 'packages/db-server') {
        // EXCEPTION: the test-only lane seam `@bolusi/db-server/testing[/budget]` may be imported by
        // NON-shipping files (tests, harness helpers, vitest configs) so apps/server's L3 suites
        // reach real PG16 WITHOUT importing `pg` — the seam owns the `pg.Pool`, so `pg` stays locked
        // to db-server (task 81's boundary ruling: option (c)). This does NOT weaken FR-1039, which
        // is about the PRODUCTION raw handle: `isOutsideShippingSource` keeps every SHIPPING file
        // banned, so no production code can reach the raw-`Kysely<DB>` test factory. Same shape as
        // the `testOnly` DB-driver grants above (better-sqlite3 for core/db-client test code).
        const isTestingSeam =
          source === '@bolusi/db-server/testing' || source.startsWith('@bolusi/db-server/testing/');
        if (isTestingSeam && isOutsideShippingSource(filename)) {
          return;
        }
        context.report({ node, messageId: 'dbServerDeepImport', data: { source } });
      }
    }

    return {
      ImportDeclaration(node) {
        if (typeof node.source.value === 'string') {
          check(node, node.source.value, node.importKind ?? 'value');
        }
      },
      ImportExpression(node) {
        if (node.source.type === 'Literal' && typeof node.source.value === 'string') {
          check(node, node.source.value, 'value');
        }
      },
      ExportNamedDeclaration(node) {
        if (node.source && typeof node.source.value === 'string') {
          check(node, node.source.value, node.exportKind ?? 'value');
        }
      },
      ExportAllDeclaration(node) {
        if (node.source && typeof node.source.value === 'string') {
          check(node, node.source.value, node.exportKind ?? 'value');
        }
      },
    };
  },
};
