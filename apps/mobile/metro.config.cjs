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

module.exports = config;
