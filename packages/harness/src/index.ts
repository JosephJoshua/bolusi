// @bolusi/harness — the chaos harness (testing-guide Part B). Node-only, test-only machinery:
// the real `@bolusi/server` in-process on PGlite plus N `VirtualDevice`s (real `@bolusi/core`
// runtime + projection engine + sync loop), the convergence oracle over task-08's `digestModule`,
// FaultFetch, the raw-wire tamper client, and the CHAOS-01..12 catalog (in `scenarios/`). The
// harness owns NO protocol logic (T-7) — it WIRES the production packages.
export const PACKAGE_NAME = '@bolusi/harness' as const;

export { openMemoryDriver } from './driver.js';
export { VirtualDevice, type DeviceIdentity, type ExtraModule } from './device.js';
export { mintIdentities, type RunIdentities } from './identities.js';
export { buildGrantAllEvaluator } from './permissions.js';
export { openClientDb, insertPulledOp, readWireOps, type ClientDbHandle } from './client-db.js';
export {
  canonicalFold,
  assertConvergence,
  assertBothFoldPaths,
  notesRows,
  type NotesRow,
  type Replica,
} from './oracle.js';
export {
  CI_SEEDS,
  NIGHTLY_SEED_COUNT,
  nightlySeeds,
  reproductionCommand,
  resolveSeeds,
  seedTag,
  withSeed,
} from './reporter.js';
export { CI_VOLUMES, activeVolumes, scaled, type Volumes } from './volumes.js';
export { runConvergence, type ConvergenceOptions, type ConvergenceResult } from './convergence.js';
export { toProjectionManifest, notesProjectionManifest } from './manifest.js';
export {
  HarnessServer,
  type HarnessSurfacedConflict,
  type HarnessSystemKeyStore,
  type HarnessSystemSigner,
  type SeededServerDevice,
  type SystemDeviceSeed,
} from './server.js';
export {
  FaultFetch,
  NetworkDroppedError,
  type CapturedRequest,
  type FaultPoint,
  type FetchLike,
  type ScheduledFault,
} from './fault-fetch.js';
export { leakedEncodings, privateKeyEncodings } from './key-leak-scan.js';
export {
  CaptureSurface,
  HttpTransport,
  pullDevice,
  pushDevice,
  ScriptedTransport,
  SILENT_SURFACE,
} from './transport.js';
