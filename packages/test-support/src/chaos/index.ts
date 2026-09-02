// @bolusi/test-support/chaos — the PLATFORM- and DOMAIN-free convergence rig (task 181).
//
// This is the shared body of the CHAOS-01 convergence workload: the `VirtualDevice` (real
// `@bolusi/core` runtime + projection engine), the canonical-fold oracle over task-08's
// `digestModule`, the disorder orchestrator, and the deterministic identity/permission builders.
// It reaches NO `node:` builtin and NO better-sqlite3/`@bolusi/modules` value — the DB engine and
// the module trio arrive through `ConvergenceSeams` (seams.ts). So this subpath bundles on Hermes
// for the on-device rig (apps/mobile CHAOS-01) AND runs under Node behind the harness's `NODE_SEAMS`
// shim — ONE implementation, two bindings (§2.8). The `chaos-bundle-safe.test.ts` guard proves the
// no-`node:` claim doesn't rot.
export { insertPulledOp, readWireOps, type ClientDbHandle } from './client-db.js';
export type { ConvergenceSeams } from './seams.js';
export { mintIdentities, type RunIdentities } from './identities.js';
export { buildGrantAllEvaluator } from './permissions.js';
export { toProjectionManifest } from './manifest.js';
export { VirtualDevice, type DeviceIdentity, type ExtraModule } from './device.js';
export {
  canonicalFold,
  assertConvergence,
  assertBothFoldPaths,
  notesRows,
  type NotesRow,
  type Replica,
} from './oracle.js';
export { runConvergence, type ConvergenceOptions, type ConvergenceResult } from './convergence.js';
