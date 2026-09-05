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
export {
  HttpTransport,
  baseUrlFetch,
  pullDevice,
  pushDevice,
  SILENT_SURFACE,
  type FetchLike,
} from './transport.js';
export {
  runChaos03,
  evaluateChaos03,
  DEFAULT_CHAOS03_OPTIONS,
  DEFAULT_CHAOS03_SEED,
  type Chaos03Options,
  type Chaos03Net,
  type Chaos03Result,
  type Chaos03Verdict,
  type Chaos03DeviceObs,
} from './chaos03.js';
export {
  runChaos06,
  evaluateChaos06,
  CHAOS06_DEVICE_COUNT,
  DEFAULT_CHAOS06_OPTIONS,
  DEFAULT_CHAOS06_SEED,
  type Chaos06Options,
  type Chaos06Net,
  type Chaos06Result,
  type Chaos06Verdict,
  type Chaos06Obs,
} from './chaos06.js';
export {
  runChaos07,
  evaluateChaos07,
  CHAOS07_DEVICE_COUNT,
  DEFAULT_CHAOS07_OPTIONS,
  DEFAULT_CHAOS07_SEED,
  type Chaos07Options,
  type Chaos07Net,
  type Chaos07Result,
  type Chaos07Verdict,
  type Chaos07Obs,
} from './chaos07.js';
