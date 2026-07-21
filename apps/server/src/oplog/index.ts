// @bolusi/server op-acceptance pipeline (05 §8–9, 10-db §3). Library layer — zero Hono/HTTP
// imports (enforced by the scoped no-restricted-imports rule on src/oplog/**). Task 16 wires
// `processPushBatch` to POST /v1/sync/push; task 17 drives `appendSystemOp` for conflict emission.
export { processPushBatch } from './pipeline.js';
export { serverCryptoPort } from './crypto.js';
export { appendSystemOp } from './system-op.js';
export type {
  AppendSystemOpDeps,
  AppendSystemOpInput,
  AppendSystemOpResult,
  SystemSigner,
} from './system-op.js';
export { allocateServerSeq, lockTenantCounter } from './server-seq.js';
export { isFoldableSchemaVersion } from './schema-version.js';
export { isClockSkewed, SKEW_BASE_MS } from './skew.js';
export { ANOMALY_KINDS, type AnomalyKind } from './anomalies.js';
export type {
  DeviceRecord,
  OpRegistry,
  OplogPipelineDeps,
  ProcessPushResult,
  PushBatch,
  PushIdentity,
  PushOpResult,
  RegistryResolution,
} from './types.js';
