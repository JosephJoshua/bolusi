// Shared state-machine executor + the machines encoded as const data (03-state-machines
// §1). Runtime-internal machines transition only through `runTransition`; each machine's
// table is asserted equal to its 03-state-machines section by a parity test.
export { runTransition, type StateMachineDefinition, type TransitionResult } from './executor.js';
export { OP_SYNC_STATUS_MACHINE, type OpSyncEvent, type OpSyncStatus } from './op-sync-status.js';
