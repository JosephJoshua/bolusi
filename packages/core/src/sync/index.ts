// The client sync loop (api/01-sync §5–§7; machine 03-state-machines §10; staleness 03 §8).
//
// Explicit named exports, matching `projection/` and `oplog/` rather than the blanket `export *` of
// `auth/`: the internals below (raw-SQL row shapes, the batch helpers) are implementation, and a
// blanket re-export is how a private shape becomes someone's dependency without anyone deciding it.
export { SYNC_BACKOFF_SCHEDULE_MS, syncBackoffDelayMs } from './backoff.js';
export { readDeviceRegistry, replaceDeviceRegistry, type DeviceRegistryEntry } from './devices.js';
export { SYNC_LOOP_MACHINE, type SyncLoopEvent, type SyncLoopState } from './loop-machine.js';
export {
  SyncLoop,
  type SyncCycleStats,
  type SyncLoopOptions,
  type SyncTriggerReason,
} from './loop.js';
export {
  DEVICE_REVOKED_ERROR_CODE,
  SyncTransportError,
  type BundleRefreshOutcome,
  type BundleRefreshPort,
  type CancelTimer,
  type QuarantineReason,
  type SyncSurfacePort,
  type SyncSurfacing,
  type SyncTransportPort,
  type TimerPort,
} from './ports.js';
export {
  parsePullResponse,
  runPullPhase,
  type PullPhaseDeps,
  type PullPhaseResult,
} from './pull.js';
export {
  readPushBatch,
  rejectionLabelKey,
  runPushPhase,
  type PushPhaseDeps,
  type PushPhaseResult,
} from './push.js';
export {
  insertQuarantinedOp,
  QUARANTINE_LABEL_KEY,
  readQuarantinedOps,
  reconstructQuarantinedOp,
  signedCoreJcsOf,
  verifyPulledOp,
  type PulledOpVerification,
  type QuarantinedOp,
} from './quarantine.js';
export {
  pendingMediaCount,
  pendingOperationCount,
  readSyncState,
  writeSyncState,
  type SyncState,
  type SyncStatePatch,
} from './state.js';
export {
  STALENESS_STALE_MS,
  STALENESS_WARNING_MS,
  stalenessAgeMs,
  stalenessLevel,
  type StalenessInput,
  type StalenessLevel,
} from './staleness.js';
