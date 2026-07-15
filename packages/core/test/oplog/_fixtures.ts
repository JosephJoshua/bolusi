// Shared test fixtures for the append path (testing-guide T-3 unique-per-seed, T-6
// determinism, T-7 fakes only at I/O boundaries). Everything is seeded: crypto is real
// (@noble via the CryptoPort), the clock/rng/id source are injected, and the "database" is
// an in-memory store that faithfully models the operations-table invariants (id PK, unique
// (device_id, seq), transactional rollback) so L1 exercises the REAL append/chain/sign
// logic without a driver (the real op-sqlite integration is L2/L4 + CHAOS, task 15/26).
import {
  appendLocalOps,
  createUuidV7Generator,
  type AppendContext,
  type ChainHead,
  type CryptoPort,
  type OpAppendStore,
  type OpAppendTx,
  type OpDraft,
  type OpRow,
  type ProjectionApply,
} from '@bolusi/core';
import type { SignedOperation } from '@bolusi/schemas';
import { mulberry32, randomBytes as prngBytes, type Prng } from '@bolusi/test-support';
import { noblePort } from '@bolusi/test-support';

export interface FakeClock {
  now(): number;
  advance(ms: number): void;
  set(ms: number): void;
}

export function makeFakeClock(startMs: number): FakeClock {
  let value = startMs;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
    set: (ms: number) => {
      value = ms;
    },
  };
}

/**
 * In-memory op store modelling the operations table's write invariants. `insertOp` rejects
 * a duplicate `id` (PK) or a duplicate `(deviceId, seq)` (the unique chain index, 10-db
 * §9.2) exactly as SQLite would. `transaction` snapshots and restores on any throw, so the
 * atomicity contract (04 §5.1) is real, not mocked away.
 */
export class InMemoryOpStore implements OpAppendStore {
  private rows = new Map<string, OpRow>();
  private chainKeys = new Set<string>();

  private static chainKey(deviceId: string, seq: number): string {
    return `${deviceId}#${seq}`;
  }

  private makeTx(): OpAppendTx {
    return {
      readChainHead: (deviceId: string): Promise<ChainHead | null> => {
        let head: ChainHead | null = null;
        for (const { op } of this.rows.values()) {
          if (op.deviceId !== deviceId) continue;
          if (head === null || op.seq > head.seq) head = { seq: op.seq, hash: op.hash };
        }
        return Promise.resolve(head);
      },
      hasOp: (id: string): Promise<boolean> => Promise.resolve(this.rows.has(id)),
      insertOp: (row: OpRow): Promise<void> => {
        const { id, deviceId, seq } = row.op;
        if (this.rows.has(id)) {
          return Promise.reject(new Error(`UNIQUE constraint failed: operations.id (${id})`));
        }
        const chainKey = InMemoryOpStore.chainKey(deviceId, seq);
        if (this.chainKeys.has(chainKey)) {
          return Promise.reject(
            new Error(`UNIQUE constraint failed: operations.device_id, operations.seq`),
          );
        }
        this.rows.set(id, row);
        this.chainKeys.add(chainKey);
        return Promise.resolve();
      },
    };
  }

  async transaction<T>(fn: (tx: OpAppendTx) => Promise<T>): Promise<T> {
    const rowsSnapshot = new Map(this.rows);
    const chainSnapshot = new Set(this.chainKeys);
    try {
      return await fn(this.makeTx());
    } catch (error) {
      this.rows = rowsSnapshot;
      this.chainKeys = chainSnapshot;
      throw error;
    }
  }

  /** All stored rows, ascending by (deviceId, seq) — for assertions only. */
  all(): OpRow[] {
    return [...this.rows.values()].sort((a, b) =>
      a.op.deviceId === b.op.deviceId
        ? a.op.seq - b.op.seq
        : a.op.deviceId < b.op.deviceId
          ? -1
          : 1,
    );
  }

  forDevice(deviceId: string): OpRow[] {
    return this.all().filter((r) => r.op.deviceId === deviceId);
  }

  count(): number {
    return this.rows.size;
  }
}

export interface Fixture {
  readonly crypto: CryptoPort;
  readonly prng: Prng;
  readonly clock: FakeClock;
  readonly newId: () => string;
  readonly secretKey: Uint8Array;
  readonly publicKey: Uint8Array;
  readonly tenantId: string;
  readonly storeId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly store: InMemoryOpStore;
  readonly context: AppendContext;
  /** A note-creation draft with unique per-call payload values (T-3). */
  noteDraft(overrides?: Partial<OpDraft>): OpDraft;
  /** The device's genesis enrollment draft (05 §9.5). */
  genesisDraft(overrides?: Partial<OpDraft>): OpDraft;
}

/** Build a fully-seeded fixture. Two calls with the same seed reproduce bit-for-bit (T-6). */
export function makeFixture(seed: number, startMs = 1_726_000_000_000): Fixture {
  const prng = mulberry32(seed);
  const crypto = noblePort;
  const clock = makeFakeClock(startMs);

  // A dedicated generator for STABLE identity ids (minted once, before the clock moves).
  const identityGen = createUuidV7Generator({
    now: () => startMs,
    randomBytes: (n) => prngBytes(prng, n),
  });
  const tenantId = identityGen();
  const storeId = identityGen();
  const userId = identityGen();
  const deviceId = identityGen();

  const keypair = crypto.ed25519Keygen(prngBytes(prng, 32));

  // The op/entity id source used during appends — reads the (advancing) FakeClock (T-6).
  const newId = createUuidV7Generator({
    now: () => clock.now(),
    randomBytes: (n) => prngBytes(prng, n),
  });

  const context: AppendContext = {
    tenantId,
    storeId,
    userId,
    deviceId,
    secretKey: keypair.secretKey,
  };

  let noteN = 0;
  return {
    crypto,
    prng,
    clock,
    newId,
    secretKey: keypair.secretKey,
    publicKey: keypair.publicKey,
    tenantId,
    storeId,
    userId,
    deviceId,
    store: new InMemoryOpStore(),
    context,
    noteDraft(overrides?: Partial<OpDraft>): OpDraft {
      noteN += 1;
      return {
        type: 'notes.note_created',
        entityType: 'note',
        entityId: newId(),
        schemaVersion: 1,
        payload: { title: `note-${seed}-${noteN}`, body: `body-${seed}-${noteN}` },
        ...overrides,
      };
    },
    genesisDraft(overrides?: Partial<OpDraft>): OpDraft {
      return {
        type: 'auth.device_enrolled',
        entityType: 'device',
        entityId: deviceId,
        schemaVersion: 1,
        payload: { enrolledDeviceId: deviceId },
        ...overrides,
      };
    },
  };
}

/**
 * Append one command's drafts against the fixture, with a counting projection spy. Callers
 * can supply their own `newId` (to force a duplicate id) or `applyProjection` (to throw).
 */
export async function appendCommand(
  fixture: Fixture,
  drafts: readonly OpDraft[],
  options?: { newId?: () => string; applyProjection?: ProjectionApply },
): Promise<{
  appliedOps: readonly SignedOperation[];
  result: Awaited<ReturnType<typeof appendLocalOps>>;
}> {
  const appliedOps: SignedOperation[] = [];
  const result = await appendLocalOps({
    store: fixture.store,
    drafts,
    context: fixture.context,
    crypto: fixture.crypto,
    newId: options?.newId ?? fixture.newId,
    now: () => fixture.clock.now(),
    location: null,
    applyProjection: async (op) => {
      appliedOps.push(op);
      if (options?.applyProjection) await options.applyProjection(op);
    },
  });
  return { appliedOps, result };
}
