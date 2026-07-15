// Operation.syncStatus machine (03-state-machines §3) — client-local bookkeeping
// (05-operation-log §2.3), never signed, never server-side. Encoded ONCE here as const
// data; the transition layer that applies it lives in ../oplog/bookkeeping.ts, and the
// parity test asserts this table equals 03 §3 (drift fails CI, 03 §1).
import type { StateMachineDefinition } from './executor.js';

/** The three status values (03 §3 / §2 enum registry). */
export type OpSyncStatus = 'local' | 'synced' | 'rejected';

/**
 * Events driving the machine (03 §3 "Event / trigger" column). All are delivered by the
 * sync engine on a server push result (api/01-sync §3):
 *  - `accepted` / `duplicate`: server took the op → `synced`.
 *  - `rejected`: server refused it (any 05 §8 code) → `rejected`.
 *  - `chain_gap`: `CHAIN_GAP` — NOT an error; the op stays `local` and is resent (05 §8).
 */
export type OpSyncEvent = 'accepted' | 'duplicate' | 'rejected' | 'chain_gap';

/**
 * The transition table, verbatim from 03 §3.
 *
 * - `local` +`accepted`/`duplicate` → `synced`; +`rejected` → `rejected`; +`chain_gap` →
 *   `local` (self-loop: no transition, not an error).
 * - `synced` +`accepted`/`duplicate` → `synced` (self-loop: idempotent no-op — a retried
 *   ack for an already-synced op, 03 §3). No `rejected` entry: `synced → rejected` is
 *   INVALID.
 * - `rejected`: terminal — every event is INVALID (`rejected → synced` and re-rejection
 *   are both expressed as absent entries; a rejected op is never re-pushed, 03 §3).
 */
export const OP_SYNC_STATUS_MACHINE: StateMachineDefinition<OpSyncStatus, OpSyncEvent> = {
  id: 'op_sync_status',
  states: ['local', 'synced', 'rejected'],
  initial: ['local', 'synced'],
  terminal: ['synced', 'rejected'],
  transitions: {
    local: {
      accepted: 'synced',
      duplicate: 'synced',
      rejected: 'rejected',
      chain_gap: 'local',
    },
    synced: {
      accepted: 'synced',
      duplicate: 'synced',
    },
    rejected: {},
  },
};
