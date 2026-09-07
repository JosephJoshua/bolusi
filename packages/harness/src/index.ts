// @bolusi/harness — the chaos harness (testing-guide Part B). Node-only, test-only machinery:
// the real `@bolusi/server` in-process on PGlite plus N `VirtualDevice`s (real `@bolusi/core`
// runtime + projection engine + sync loop), the convergence oracle over task-08's `digestModule`,
// FaultFetch, the raw-wire tamper client, and the CHAOS-01..12 catalog (in `scenarios/`). The
// harness owns NO protocol logic (T-7) — it WIRES the production packages.
export const PACKAGE_NAME = '@bolusi/harness' as const;

export { openMemoryDriver } from '@bolusi/sqlite-test-driver';
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
export {
  NIGHTLY_X4_SEED_CAPS,
  X4_SEED_CAP_ENV,
  isNightlyX4Lane,
  nightlyX4Seeds,
  x4SeedCap,
  type X4CappedScenario,
} from './nightly-scale.js';
export { runConvergence, type ConvergenceOptions, type ConvergenceResult } from './convergence.js';
export { toProjectionManifest, notesProjectionManifest } from './manifest.js';
export {
  HarnessServer,
  startHarnessServer,
  type HarnessForTenant,
  type HarnessSurfacedConflict,
  type HarnessSystemKeyStore,
  type HarnessSystemSigner,
  type RunningHarnessServer,
  type SeededServerDevice,
  type SystemDeviceSeed,
} from './server.js';
export { createPgliteAuthDirectory, type PgliteAuthDirectory } from './production-auth.js';
export {
  LANE_OTP,
  LANE_OWNER_LOGIN,
  LANE_OWNER_NAME,
  LANE_PIN,
  LANE_STORE_NAME,
  LANE_TENANT_NAME,
  provisionHarnessOwner,
  seedOwnerPin,
  type ProvisionableServer,
} from './harness-provision.js';
export {
  assertLaneLoopbackBind,
  formatLaneReady,
  LANE_LOOPBACK,
  LANE_PORT,
  LANE_READY_MARKER,
  parseLaneReady,
  provisionLaneOwner,
  type LaneCredentials,
  type LaneReady,
} from './serve-lane.js';
export { describeDeviceHandoff, socketBaseFetch, type DeviceHandoff } from './net-server.js';
// A tenant's system actor + device — HOST-ONLY setup the chaos-net child seeds so CHAOS-07's real
// conflict-detection pipeline has a signer whose key matches `devices.signing_key_public`. It lives
// here (not the bundle-safe rig) because the device never mints or sees the system key (§2.8).
export {
  mintSystemDevice,
  systemSignerKeyStore,
  type SystemDeviceIdentity,
} from './system-identity.js';
// The canonical CHAOS-03/06/07 run parameters (seed + volume + device count), surfaced on the Node
// aggregator so the chaos-net child server (scripts/harness-chaos-server.mjs) seeds the SAME
// identities each on-device runner derives from the SAME seed (§2.8 / T-6: one source, two
// bindings). They still LIVE in the bundle-safe rig — this only re-exports, it does not redefine.
// CHAOS-06/07 carry their device counts as SEPARATE constants (not on the options object, unlike
// CHAOS-03's `DEFAULT_CHAOS03_OPTIONS.deviceCount`), so the child must mint those counts.
export {
  DEFAULT_CHAOS03_OPTIONS,
  DEFAULT_CHAOS03_SEED,
  DEFAULT_CHAOS06_OPTIONS,
  DEFAULT_CHAOS06_SEED,
  CHAOS06_DEVICE_COUNT,
  DEFAULT_CHAOS07_OPTIONS,
  DEFAULT_CHAOS07_SEED,
  CHAOS07_DEVICE_COUNT,
} from '@bolusi/test-support/chaos';
export {
  FaultFetch,
  NetworkDroppedError,
  type CapturedRequest,
  type FaultPoint,
  type FetchLike,
  type ScheduledFault,
} from './fault-fetch.js';
export { leakedEncodings, privateKeyEncodings } from './key-leak-scan.js';
export { rawPush, type RawPushResult } from './raw-wire.js';
export { HarnessMediaTransport } from './media-transport.js';
export {
  CaptureSurface,
  HttpTransport,
  pullDevice,
  pushDevice,
  ScriptedTransport,
  SILENT_SURFACE,
} from './transport.js';
