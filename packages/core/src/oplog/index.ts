// The client append path (05-operation-log §1–§5; 04-module-contract §5.1). Draft
// completion + signing, per-device chaining + genesis, atomic append + projection seam,
// the syncStatus bookkeeping mutator, and chain/tamper verification.
export {
  completeDraft,
  type CompletedOp,
  type DraftCompletionContext,
  type OpDraft,
} from './draft.js';
export {
  assertGenesisRules,
  GENESIS_OP_TYPE,
  GenesisRuleError,
  nextChainPosition,
  type ChainHead,
  type ChainPosition,
  type GenesisRuleCode,
} from './chain.js';
export {
  appendLocalOps,
  type AppendContext,
  type AppendedOp,
  type AppendLocalOpsOptions,
  type AppendLocalOpsResult,
  type OpAppendStore,
  type OpAppendTx,
  type OpRow,
  type ProjectionApply,
} from './append.js';
export {
  markSyncResult,
  resolveSyncTransition,
  type BookkeepingPatch,
  type MarkSyncResultInput,
  type OpBookkeepingDatabase,
  type OpBookkeepingRow,
  type SyncResultEvent,
  type SyncTransition,
} from './bookkeeping.js';
export {
  verifyChain,
  verifyOpDetailed,
  type ChainVerifyResult,
  type ChainViolation,
  type ChainViolationCode,
} from './verify.js';
