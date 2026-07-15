// Operation.syncStatus bookkeeping (03-state-machines §3; 05-operation-log §2.3, §8).
// The pure `resolveSyncTransition` carries the substance: every valid transition, the
// idempotent self-loops, and every invalid pair throwing INVALID_TRANSITION. `markSyncResult`
// is the single sanctioned mutator — tested via a recording fake that captures the query it
// builds (the real op-sqlite execution is proven downstream in L2/L4 + CHAOS-05/06, task 26).
import {
  DomainError,
  markSyncResult,
  resolveSyncTransition,
  type MarkSyncResultInput,
  type OpBookkeepingDatabase,
  type OpSyncStatus,
  type SyncResultEvent,
} from '@bolusi/core';
import { REJECTION_CODES } from '@bolusi/schemas';
import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';

const SYNCED_AT = 1_726_000_000_777;

describe('resolveSyncTransition — valid transitions (03 §3)', () => {
  it('local + accepted → synced, stamping syncedAt and clearing rejection fields', () => {
    const t = resolveSyncTransition('local', { kind: 'accepted', syncedAt: SYNCED_AT });
    expect(t).toEqual({
      kind: 'transition',
      to: 'synced',
      patch: {
        syncStatus: 'synced',
        syncedAt: SYNCED_AT,
        rejectionCode: null,
        rejectionReason: null,
      },
    });
  });

  it('local + duplicate → synced, also stamping syncedAt (terminal-success)', () => {
    const t = resolveSyncTransition('local', { kind: 'duplicate', syncedAt: SYNCED_AT });
    expect(t.kind).toBe('transition');
    expect(t.to).toBe('synced');
    if (t.kind === 'transition') {
      expect(t.patch.syncStatus).toBe('synced');
      expect(t.patch.syncedAt).toBe(SYNCED_AT);
    }
  });

  it('local + rejected → rejected for EVERY 05 §8 code, setting code + reason atomically', () => {
    for (const code of REJECTION_CODES) {
      const t = resolveSyncTransition('local', {
        kind: 'rejected',
        rejectionCode: code,
        rejectionReason: `reason for ${code}`,
      });
      expect(t.kind, code).toBe('transition');
      if (t.kind === 'transition') {
        expect(t.to, code).toBe('rejected');
        expect(t.patch).toEqual({
          syncStatus: 'rejected',
          syncedAt: null,
          rejectionCode: code,
          rejectionReason: `reason for ${code}`,
        });
      }
    }
    // Denominator guard (T-14): all eight rejection codes were exercised.
    expect(REJECTION_CODES.length).toBe(8);
  });
});

describe('resolveSyncTransition — self-loop no-ops (not transitions, no side effects)', () => {
  it('local + chain_gap stays local with no write (CHAIN_GAP is not an error, 05 §8)', () => {
    expect(resolveSyncTransition('local', { kind: 'chain_gap' })).toEqual({
      kind: 'noop',
      to: 'local',
    });
  });

  it('synced + accepted is an idempotent no-op (retried ack for an already-synced op)', () => {
    expect(resolveSyncTransition('synced', { kind: 'accepted', syncedAt: SYNCED_AT })).toEqual({
      kind: 'noop',
      to: 'synced',
    });
  });

  it('synced + duplicate is an idempotent no-op', () => {
    expect(resolveSyncTransition('synced', { kind: 'duplicate', syncedAt: SYNCED_AT })).toEqual({
      kind: 'noop',
      to: 'synced',
    });
  });
});

describe('resolveSyncTransition — invalid transitions throw INVALID_TRANSITION', () => {
  const invalid: ReadonlyArray<readonly [OpSyncStatus, SyncResultEvent]> = [
    ['synced', { kind: 'rejected', rejectionCode: 'BAD_SIGNATURE', rejectionReason: 'x' }],
    ['synced', { kind: 'chain_gap' }],
    ['rejected', { kind: 'accepted', syncedAt: SYNCED_AT }],
    ['rejected', { kind: 'duplicate', syncedAt: SYNCED_AT }],
    ['rejected', { kind: 'rejected', rejectionCode: 'CHAIN_BROKEN', rejectionReason: 'x' }],
    ['rejected', { kind: 'chain_gap' }],
  ];

  it.each(invalid)('%s + %o → INVALID_TRANSITION', (from, event) => {
    let thrown: unknown;
    try {
      resolveSyncTransition(from, event);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DomainError);
    expect((thrown as DomainError).code).toBe('INVALID_TRANSITION');
    expect((thrown as DomainError).details).toEqual({
      machine: 'op_sync_status',
      from,
      event: event.kind,
    });
  });

  it('covers the fixed invalid set (denominator guard, T-14)', () => {
    expect(invalid.length).toBe(6);
  });
});

// ---- markSyncResult: the single sanctioned mutator, via a recording fake ----

interface RecordedUpdate {
  table: string;
  set: Record<string, unknown>;
  wheres: Array<[string, string, unknown]>;
  executed: boolean;
}

function recordingDb(): { db: Kysely<OpBookkeepingDatabase>; updates: RecordedUpdate[] } {
  const updates: RecordedUpdate[] = [];
  const fake = {
    updateTable(table: string) {
      const rec: RecordedUpdate = { table, set: {}, wheres: [], executed: false };
      updates.push(rec);
      const builder = {
        set(values: Record<string, unknown>) {
          rec.set = values;
          return builder;
        },
        where(col: string, op: string, val: unknown) {
          rec.wheres.push([col, op, val]);
          return builder;
        },
        execute() {
          rec.executed = true;
          return Promise.resolve([]);
        },
      };
      return builder;
    },
  };
  return { db: fake as unknown as Kysely<OpBookkeepingDatabase>, updates };
}

describe('markSyncResult — the single sanctioned bookkeeping mutator', () => {
  const call = (db: Kysely<OpBookkeepingDatabase>, input: MarkSyncResultInput): Promise<unknown> =>
    markSyncResult(db, input);

  it('writes only the four sanctioned bookkeeping columns on a real transition (08 §5.2)', async () => {
    const { db, updates } = recordingDb();
    await call(db, {
      id: 'op-1',
      currentStatus: 'local',
      event: { kind: 'accepted', syncedAt: SYNCED_AT },
    });

    expect(updates).toHaveLength(1);
    const [rec] = updates;
    expect(rec!.table).toBe('operations');
    expect(rec!.executed).toBe(true);
    expect(rec!.set).toEqual({
      syncStatus: 'synced',
      syncedAt: SYNCED_AT,
      rejectionCode: null,
      rejectionReason: null,
    });
    // Exactly the 08 §5.2 client bookkeeping columns — never serverSeq, never a signed-core column.
    expect(Object.keys(rec!.set).sort()).toEqual(
      ['syncStatus', 'syncedAt', 'rejectionCode', 'rejectionReason'].sort(),
    );
    // Guarded on the op id AND the observed status (optimistic).
    expect(rec!.wheres).toEqual([
      ['id', '=', 'op-1'],
      ['syncStatus', '=', 'local'],
    ]);
  });

  it('writes the rejection code + reason on a rejection', async () => {
    const { db, updates } = recordingDb();
    await call(db, {
      id: 'op-2',
      currentStatus: 'local',
      event: {
        kind: 'rejected',
        rejectionCode: 'CHAIN_BROKEN',
        rejectionReason: 'previousHash mismatch',
      },
    });
    expect(updates[0]!.set).toEqual({
      syncStatus: 'rejected',
      syncedAt: null,
      rejectionCode: 'CHAIN_BROKEN',
      rejectionReason: 'previousHash mismatch',
    });
  });

  it('performs NO write for a self-loop no-op (idempotent ack)', async () => {
    const { db, updates } = recordingDb();
    const result = await call(db, {
      id: 'op-3',
      currentStatus: 'synced',
      event: { kind: 'accepted', syncedAt: SYNCED_AT },
    });
    expect(updates, 'no query built for a no-op').toHaveLength(0);
    expect((result as { kind: string }).kind).toBe('noop');
  });

  it('performs NO write for a CHAIN_GAP (op stays local)', async () => {
    const { db, updates } = recordingDb();
    const result = await call(db, {
      id: 'op-4',
      currentStatus: 'local',
      event: { kind: 'chain_gap' },
    });
    expect(updates).toHaveLength(0);
    expect(result).toEqual({ kind: 'noop', to: 'local' });
  });

  it('throws INVALID_TRANSITION BEFORE any database call', async () => {
    const { db, updates } = recordingDb();
    await expect(
      call(db, {
        id: 'op-5',
        currentStatus: 'synced',
        event: { kind: 'rejected', rejectionCode: 'BAD_SIGNATURE', rejectionReason: 'x' },
      }),
    ).rejects.toBeInstanceOf(DomainError);
    expect(updates, 'no query issued when the transition is invalid').toHaveLength(0);
  });
});
