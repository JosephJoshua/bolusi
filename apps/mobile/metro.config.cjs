// Metro monorepo config (08 §4.2): watch the workspace, resolve hoisted deps, and keep
// package-exports resolution ON (required for @bolusi/modules subpath split + noble-style
// exports; RN 0.86 default).
const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.join(projectRoot, 'node_modules'),
  path.join(workspaceRoot, 'node_modules'),
];

// TypeScript-`.js`-specifier resolution for Metro (additive, platform-agnostic — task 116).
//
// This repo's TS source imports with explicit `.js` specifiers (NodeNext style, e.g.
// `import { switcherState } from './model.js'`). Metro's default resolver does NOT strip `.js` to
// find the `.ts`/`.tsx` source — it tries `model.js.ts`, `model.js`, … and gives up. tsc + vitest
// never exercised Metro, so this only surfaces the first time the app is actually bundled (here, for
// web). The fallback below runs ONLY when the default resolution throws, so a real `.js` file still
// resolves normally and native output is unchanged: it just lets a failed `foo.js` retry as
// `foo.ts`/`foo.tsx`. Belongs in the shared Metro config (not a web-only file) because Expo has one
// Metro config per app across every platform; the native bundle needs the same resolution.
const previousResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = previousResolveRequest ?? context.resolveRequest;
  if (moduleName.endsWith('.js') && (moduleName.startsWith('.') || moduleName.startsWith('/'))) {
    try {
      return resolve(context, moduleName, platform);
    } catch (error) {
      const base = moduleName.slice(0, -'.js'.length);
      for (const ext of ['.ts', '.tsx']) {
        try {
          return resolve(context, base + ext, platform);
        } catch {
          // keep trying the next candidate extension
        }
      }
      throw error;
    }
  }
  return resolve(context, moduleName, platform);
};

module.exports = config;
