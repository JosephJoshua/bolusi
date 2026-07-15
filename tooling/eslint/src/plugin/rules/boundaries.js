// bolusi/boundaries — whole-repo rule; the importer's workspace is derived from the file path.
// IMPLEMENTED DEPTH (deny-list half of 08 §3.3/§3.4/§2.6):
//   1. §2.6 banned packages everywhere (@hono/node-ws, expo-background-fetch,
//      expo-file-system/legacy, kysely-expo)
//   2. DB-driver locks (op-sqlite → db-client only; pg → db-server only;
//      better-sqlite3 → harness only)
//   3. */screens subpaths importable only from apps/mobile
//   4. @bolusi/server edge (harness value-import only; type-only ./client elsewhere)
//   5. nothing imports @bolusi/mobile
//   6. §3.4 platform-free deny prefixes for core/schemas/i18n/modules-manifest
//      (incl. @noble/* — crypto providers are injected via CryptoPort, never imported;
//      added by task 03, the task that introduced noble to the repo)
//   7. forTenant-only / no-raw-db-handle lock: no deep imports into @bolusi/db-server (FR-1039)
// NOT YET IMPLEMENTED: the full §3.3 POSITIVE allow-matrix ("anything not listed is
// forbidden" — e.g. schemas importing @bolusi/core would pass today). Owner: task 28
// (security-sweep) hardens this rule to the full matrix, or earlier if a task adds a
// new inter-package edge that the deny-list cannot see.

const FORBIDDEN_EVERYWHERE = new Map([
  ['@hono/node-ws', 'deprecated — upgradeWebSocket comes from @hono/node-server 2.x (08 §2.6)'],
  ['expo-background-fetch', 'deprecated — use expo-background-task (08 §2.6)'],
  ['expo-file-system/legacy', 'legacy re-exports throw at runtime in SDK 57 (08 §2.2)'],
  ['kysely-expo', 'rejected — we own the op-sqlite dialect shim (08 §2.6)'],
]);

// DB drivers may be imported only by their owning wrapper (08 §3.3 hard rule 2).
const DB_DRIVER_OWNERS = new Map([
  ['@op-engineering/op-sqlite', 'packages/db-client'],
  ['pg', 'packages/db-server'],
  ['better-sqlite3', 'packages/harness'],
]);

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
      screensOutsideMobile:
        "'{{source}}': */screens subpaths are Hermes-only UI and may be imported only from apps/mobile (08-stack-and-repo §3.2 modules row).",
      serverImport:
        "'{{source}}': @bolusi/server may be value-imported only by @bolusi/harness; the sole app→app edge is a type-only import of '@bolusi/server/client' (08-stack-and-repo §4.3).",
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
      // 2. DB-driver locks.
      const driverKey = source.startsWith('@op-engineering/')
        ? '@op-engineering/op-sqlite'
        : source;
      const owner = DB_DRIVER_OWNERS.get(driverKey);
      if (owner && workspace !== owner) {
        context.report({ node, messageId: 'dbDriver', data: { source, owner } });
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
