// Per-device chain positioning + genesis rules (05-operation-log §2.1, §4, §9.5).
//
// The chain is per-DEVICE and spans users (a PIN switch does not break it, 05 §4). This
// module derives the next op's `seq`/`previousHash` from the device's chain head and
// enforces the genesis rule: the ONLY valid first op on a device is `auth.device_enrolled`
// at `seq = 1`, `previousHash` = 64 zeros, `entityId` = the device's own id (05 §9.5).
import { GENESIS_PREVIOUS_HASH } from '@bolusi/schemas';

/** A device's chain head: the highest-seq op it holds, and that op's hash. */
export interface ChainHead {
  readonly seq: number;
  readonly hash: string;
}

/** The `seq`/`previousHash` the next op on this device must carry. */
export interface ChainPosition {
  readonly seq: number;
  readonly previousHash: string;
}

/** The one op type the runtime appends as a device's genesis (04 §5.1 sanctioned emission). */
export const GENESIS_OP_TYPE = 'auth.device_enrolled';

/**
 * The next chain position after `head`.
 * Genesis (`head === null`): `seq = 1`, `previousHash` = 64 zeros (05 §2.1). Otherwise
 * `seq = head.seq + 1`, `previousHash = head.hash`.
 */
export function nextChainPosition(head: ChainHead | null): ChainPosition {
  if (head === null) return { seq: 1, previousHash: GENESIS_PREVIOUS_HASH };
  return { seq: head.seq + 1, previousHash: head.hash };
}

export type GenesisRuleCode =
  /** First op on the device is not the genesis enrollment op (05 §9.5). */
  | 'NON_GENESIS_FIRST_OP'
  /** A second `auth.device_enrolled` on a device that already has a chain (05 §9.5). */
  | 'GENESIS_ON_NON_EMPTY_CHAIN'
  /** Genesis op whose `entityId` is not the device's own id (05 §9.5). */
  | 'GENESIS_ENTITY_MISMATCH';

/** A genesis-rule violation. Typed + greppable; nothing is inserted when it is thrown. */
export class GenesisRuleError extends Error {
  override readonly name = 'GenesisRuleError';
  readonly code: GenesisRuleCode;

  constructor(code: GenesisRuleCode, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Enforce the genesis rules for the op about to be appended (05 §9.5). Called BEFORE the
 * op is completed/inserted, so a violation leaves the log untouched.
 *
 * @throws {GenesisRuleError}
 */
export function assertGenesisRules(
  op: { readonly type: string; readonly entityId: string },
  head: ChainHead | null,
  deviceId: string,
): void {
  const isGenesisType = op.type === GENESIS_OP_TYPE;

  if (head === null) {
    if (!isGenesisType) {
      throw new GenesisRuleError(
        'NON_GENESIS_FIRST_OP',
        `the first op on a device must be ${GENESIS_OP_TYPE} (05 §9.5), got ${op.type}`,
      );
    }
    if (op.entityId !== deviceId) {
      throw new GenesisRuleError(
        'GENESIS_ENTITY_MISMATCH',
        `${GENESIS_OP_TYPE} entityId must equal the device id (05 §9.5)`,
      );
    }
    return;
  }

  if (isGenesisType) {
    throw new GenesisRuleError(
      'GENESIS_ON_NON_EMPTY_CHAIN',
      `${GENESIS_OP_TYPE} is only valid as the device genesis op (05 §9.5); the chain already has ${head.seq} op(s)`,
    );
  }
}
