// @bolusi/core — op log, projection engine, command runtime, sync client loop, JCS,
// UUIDv7. PURE TS; every effect behind an injected port (08-stack-and-repo §3.2).
export const PACKAGE_NAME = '@bolusi/core' as const;

export * from './auth/index.js';
export * from './authz/index.js';
export * from './crypto/index.js';
export * from './errors/domain-error.js';
export * from './state-machines/index.js';
export * from './ids/uuidv7.js';
export * from './oplog/index.js';
export * from './projection/index.js';
export * from './runtime/index.js';
export * from './module/index.js';
export * from './platform/index.js';
export * from './query/index.js';
export * from './sync/index.js';
