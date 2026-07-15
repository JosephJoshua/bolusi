// The client append path (04-module-contract §5.1 steps 4–6; 05-operation-log §1, §5).
//
// One transaction that: reads the device chain head, and per draft — generates a UUIDv7,
// enforces genesis rules, allocates the next `seq`/`previousHash`, completes+signs the op,
// inserts it born `syncStatus = 'local'`, then invokes the injected projection-apply seam.
// Append and projection are ATOMIC (04 §5.1 steps 5–6): the seam throwing rolls the whole
// command back — no op row, chain head unchanged.
//
// PORT-BASED BY NECESSITY: @bolusi/core is platform-free and may not import @bolusi/db-client
// (08 §3.3). The store is an injected abstraction; db-client binds the real op-sqlite
// transaction to it downstream (task 15 / apps/mobile). The projection engine is task 08 —
// it plugs into `applyProjection`. Everything effectful (clock, rng/id, crypto, location,
// store) is injected, so the whole path is deterministic under a seed (T-6) and the tamper
// scenarios (CHAOS-05/06) stay buildable.
import type { Location, SignedOperation } from '@bolusi/schemas';

import type { CryptoPort } from '../crypto/port.js';
import { assertGenesisRules, nextChainPosition, type ChainHead } from './chain.js';
import { completeDraft, type OpDraft } from './draft.js';

/** A completed op row ready to persist: the signed op + its verbatim JCS (10-db §2.1). */
export interface OpRow {
  readonly op: SignedOperation;
  readonly signedCoreJcs: string;
}

/** The transactional store surface the append path needs (implemented over db-client downstream). */
export interface OpAppendTx {
  /** The device's chain head, or `null` when the device has no ops yet (genesis). */
  readChainHead(deviceId: string): Promise<ChainHead | null>;
  /** Whether an op with this `id` already exists locally — the dedup key (05 §5). */
  hasOp(id: string): Promise<boolean>;
  /** Insert a completed op row, born `syncStatus = 'local'` (03 §3 birth state). */
  insertOp(row: OpRow): Promise<void>;
}

export interface OpAppendStore {
  /** Run `fn` inside one transaction; ANY throw rolls it back (atomicity, 04 §5.1). */
  transaction<T>(fn: (tx: OpAppendTx) => Promise<T>): Promise<T>;
}

/**
 * The projection-apply seam (04 §5.1 step 6). Task 08 plugs the real engine in; it runs
 * inside the same transaction as the insert, so a throw here rolls back the append too.
 */
export type ProjectionApply = (op: SignedOperation) => void | Promise<void>;

/** The per-command actor/device context (from the command runtime's `ctx`, 04 §5.2). */
export interface AppendContext {
  readonly tenantId: string;
  readonly storeId: string | null;
  readonly userId: string;
  readonly deviceId: string;
  /** The device's Ed25519 signing seed (from the keystore port). */
  readonly secretKey: Uint8Array;
}

export interface AppendLocalOpsOptions {
  readonly store: OpAppendStore;
  /** One command's op drafts, appended in order as a contiguous run of the device chain. */
  readonly drafts: readonly OpDraft[];
  readonly context: AppendContext;
  readonly crypto: CryptoPort;
  /** UUIDv7 source (injected — deterministic in tests, T-6). */
  readonly newId: () => string;
  /** ms-epoch clock; stamped ONCE for the whole command (04 §5.2). */
  readonly now: () => number;
  /** Resolved best-available fix, or null; never blocks (04 §5.1 / 05 §2.1). */
  readonly location: Location | null;
  readonly applyProjection: ProjectionApply;
}

export type AppendedOp =
  | {
      readonly status: 'appended';
      readonly op: SignedOperation;
      readonly signedCoreJcs: string;
      readonly seq: number;
    }
  /** The generated `id` already existed locally — inert no-op (05 §5): not inserted, not applied. */
  | { readonly status: 'duplicate'; readonly id: string };

export interface AppendLocalOpsResult {
  readonly ops: readonly AppendedOp[];
}

/**
 * Append one command's ops locally, atomically with projection application (04 §5.1).
 *
 * @throws {GenesisRuleError} if the first op on the device is not a valid genesis op.
 * @throws {JcsInputError | ZodError} if a draft cannot be completed into a §2.1 core.
 * @throws whatever `applyProjection` throws — rolling the whole command back.
 */
export async function appendLocalOps(
  options: AppendLocalOpsOptions,
): Promise<AppendLocalOpsResult> {
  const { store, drafts, context, crypto, applyProjection } = options;

  return store.transaction(async (tx) => {
    const timestamp = options.now(); // one stamp for the whole command (04 §5.2)
    let head = await tx.readChainHead(context.deviceId);
    const appended: AppendedOp[] = [];

    for (const draft of drafts) {
      const id = options.newId();

      // Dedup by id (05 §5): a pre-existing id is inert — no insert, no projection apply,
      // no chain advance. Command ids are fresh, so this is the idempotency backstop
      // (a replayed/known op), not the common path.
      if (await tx.hasOp(id)) {
        appended.push({ status: 'duplicate', id });
        continue;
      }

      assertGenesisRules(draft, head, context.deviceId);
      const { seq, previousHash } = nextChainPosition(head);

      const completed = completeDraft(
        draft,
        {
          id,
          tenantId: context.tenantId,
          storeId: context.storeId,
          userId: context.userId,
          deviceId: context.deviceId,
          seq,
          previousHash,
          timestamp,
          location: options.location,
        },
        context.secretKey,
        crypto,
      );

      await tx.insertOp({ op: completed.op, signedCoreJcs: completed.jcs });
      await applyProjection(completed.op);

      head = { seq, hash: completed.op.hash };
      appended.push({
        status: 'appended',
        op: completed.op,
        signedCoreJcs: completed.jcs,
        seq,
      });
    }

    return { ops: appended };
  });
}
