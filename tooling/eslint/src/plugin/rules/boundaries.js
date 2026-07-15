// bolusi/boundaries — whole-repo rule; the importer's workspace is derived from the file path.
// IMPLEMENTED DEPTH (deny-list half of 08 §3.3/§3.4/§2.6):
//   1. §2.6 banned packages everywhere (@hono/node-ws, expo-background-fetch,
//      expo-file-system/legacy, kysely-expo)
//   2. DB-driver locks (op-sqlite → db-client only; pg → db-server only;
//      better-sqlite3 → harness, plus db-client TEST/TOOLING files only — it is the CI
//      adapter behind the driver-conformance suite and must never reach shipping source)
//   2b. db-client is Hermes-only: no node:* in its shipping source (08 §3.2)
//   3. */screens subpaths importable only from apps/mobile
//   4. @bolusi/server edge (harness value-import only; type-only ./client elsewhere)
//   5. nothing imports @bolusi/mobile
//   6. §3.4 platform-free deny prefixes for core/schemas/i18n/modules-manifest
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
// `testOnly` owners may import the driver from test/tooling files but NOT from shipping
// source: better-sqlite3 is test-only (08 §2.5) and backs both the harness's simulated
// devices and db-client's CI conformance adapter (testing-guide §2.3).
const DB_DRIVER_OWNERS = new Map([
  ['@op-engineering/op-sqlite', [{ workspace: 'packages/db-client' }]],
  ['pg', [{ workspace: 'packages/db-server' }]],
  [
    'better-sqlite3',
    [{ workspace: 'packages/harness' }, { workspace: 'packages/db-client', testOnly: true }],
  ],
]);

// Hermes-only workspaces: shipping source cannot use Node builtins (08 §3.2). Their
// test/tooling files legitimately do (in-memory adapters, codegen scripts).
const NODE_FREE_SOURCE = new Set(['packages/db-client']);

/** Test + tooling files: excluded from the "shipping source" locks above. */
function isTestOrToolingFile(filename) {
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
        "'{{source}}': {{workspace}} is Hermes-only — Node builtins do not exist on device (08-stack-and-repo §3.2). Test and tooling files may use them; shipping source may not.",
      screensOutsideMobile:
        "'{{source}}': */screens subpaths are Hermes-only UI and may be imported only from apps/mobile (08-stack-and-repo §3.2 modules row).",
      serverImport:
        "'{{source}}': @bolusi/server may be value-imported only by @bolusi/harness; the sole app→app edge is a type-only import of '@bolusi/server/client' (08-stack-and-repo §4.3).",
      appImport: "'{{source}}': nothing imports the mobile app (08-stack-and-repo §3.3).",
      platformFree:
        "'{{source}}' is platform-bound; {{workspace}} is platform-free — no node:*, react-native*, expo*, pg, hono*, ws, @op-engineering/* (08-stack-and-repo §3.4).",
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
        if (owned.testOnly && !isTestOrToolingFile(filename)) {
          context.report({ node, messageId: 'dbDriverTestOnly', data: { source } });
          return;
        }
      }

      // 2b. Hermes-only workspaces: no Node builtins in shipping source.
      if (
        workspace &&
        NODE_FREE_SOURCE.has(workspace) &&
        /^node:/.test(source) &&
        !isTestOrToolingFile(filename)
      ) {
        context.report({ node, messageId: 'nodeInHermesSource', data: { source, workspace } });
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
