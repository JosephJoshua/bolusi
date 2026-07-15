// Operation.syncStatus machine (03-state-machines §3) — parity with the doc table + the
// shared executor's transition/no-op/invalid semantics.
//
// The parity oracle below is transcribed VERBATIM from 03 §3 as an INDEPENDENT second
// encoding: the point of a parity test is that two encodings of the same table agree, so
// drift in either (the const in op-sync-status.ts, or this oracle) fails CI (03 §1).
// The oracle enumerates EVERY (state × event) pair and its denominator is asserted (T-14),
// so a starved comparison cannot pass green having checked a fraction of the matrix.
import {
  DomainError,
  OP_SYNC_STATUS_MACHINE,
  runTransition,
  type OpSyncEvent,
  type OpSyncStatus,
} from '@bolusi/core';
import { describe, expect, it } from 'vitest';

const STATES: readonly OpSyncStatus[] = ['local', 'synced', 'rejected'];
const EVENTS: readonly OpSyncEvent[] = ['accepted', 'duplicate', 'rejected', 'chain_gap'];

// 03 §3, transcribed independently. `null` = INVALID_TRANSITION (no table entry).
// A `to` equal to its `from` is a self-loop (idempotent no-op / "no transition").
const ORACLE: Record<OpSyncStatus, Record<OpSyncEvent, OpSyncStatus | null>> = {
  local: { accepted: 'synced', duplicate: 'synced', rejected: 'rejected', chain_gap: 'local' },
  synced: { accepted: 'synced', duplicate: 'synced', rejected: null, chain_gap: null },
  rejected: { accepted: null, duplicate: null, rejected: null, chain_gap: null },
};

const ORACLE_TERMINAL: readonly OpSyncStatus[] = ['synced', 'rejected'];
const ORACLE_BIRTH: readonly OpSyncStatus[] = ['local', 'synced'];

describe('op_sync_status machine — parity with 03-state-machines §3', () => {
  it('encodes exactly the three status values and their birth/terminal classification', () => {
    expect([...OP_SYNC_STATUS_MACHINE.states].sort()).toEqual([...STATES].sort());
    expect([...OP_SYNC_STATUS_MACHINE.initial].sort()).toEqual([...ORACLE_BIRTH].sort());
    expect([...OP_SYNC_STATUS_MACHINE.terminal].sort()).toEqual([...ORACLE_TERMINAL].sort());
    expect(OP_SYNC_STATUS_MACHINE.id).toBe('op_sync_status');
  });

  it('matches the doc transition table on every one of the 12 state×event pairs', () => {
    let pairsChecked = 0;
    for (const from of STATES) {
      for (const event of EVENTS) {
        const expected = ORACLE[from][event];
        const actual = OP_SYNC_STATUS_MACHINE.transitions[from][event];
        expect(actual ?? null, `(${from}, ${event})`).toBe(expected);
        pairsChecked += 1;
      }
    }
    // Denominator guard (T-14): the whole 3×4 matrix, or the comparison proved nothing.
    expect(pairsChecked).toBe(STATES.length * EVENTS.length);
  });
});

describe('runTransition executor over op_sync_status', () => {
  it('reports a real transition as changed for each state-advancing pair', () => {
    for (const from of STATES) {
      for (const event of EVENTS) {
        const to = ORACLE[from][event];
        if (to === null || to === from) continue;
        const result = runTransition(OP_SYNC_STATUS_MACHINE, from, event);
        expect(result, `(${from}, ${event})`).toEqual({ to, changed: true });
      }
    }
  });

  it('reports a self-loop as a no-op (changed=false) for local+chain_gap and synced acks', () => {
    for (const from of STATES) {
      for (const event of EVENTS) {
        const to = ORACLE[from][event];
        if (to === null || to !== from) continue;
        const result = runTransition(OP_SYNC_STATUS_MACHINE, from, event);
        expect(result, `(${from}, ${event})`).toEqual({ to: from, changed: false });
      }
    }
  });

  it('throws INVALID_TRANSITION for every pair the doc marks invalid, with machine/from/event details', () => {
    let invalidChecked = 0;
    for (const from of STATES) {
      for (const event of EVENTS) {
        if (ORACLE[from][event] !== null) continue;
        let thrown: unknown;
        try {
          runTransition(OP_SYNC_STATUS_MACHINE, from, event);
        } catch (error) {
          thrown = error;
        }
        expect(thrown, `(${from}, ${event}) must throw`).toBeInstanceOf(DomainError);
        expect((thrown as DomainError).code).toBe('INVALID_TRANSITION');
        expect((thrown as DomainError).details).toEqual({
          machine: 'op_sync_status',
          from,
          event,
        });
        invalidChecked += 1;
      }
    }
    // The invalid set is fixed at 6 (synced×{rejected,chain_gap} + rejected×all four).
    expect(invalidChecked).toBe(6);
  });
});
