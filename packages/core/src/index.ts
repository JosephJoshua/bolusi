// @bolusi/core — op log, projection engine, command runtime, sync client core, JCS,
// UUIDv7. PURE TS; every effect behind an injected port (08-stack-and-repo §3.2).
// Command runtime / sync loop land in later tasks.
export const PACKAGE_NAME = '@bolusi/core' as const;

export * from './authz/index.js';
export * from './crypto/index.js';
export * from './errors/domain-error.js';
export * from './state-machines/index.js';
export * from './ids/uuidv7.js';
export * from './oplog/index.js';
export * from './projection/index.js';
