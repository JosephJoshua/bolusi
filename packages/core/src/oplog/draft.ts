// Op-draft completion (04-module-contract §5.1 step 4; 05-operation-log §2.1–2.2, §3).
//
// A command handler emits DRAFTS (type/entity/payload — the parts it controls, 04 §5.1);
// the runtime completes each into a fully-signed core with EVERY §2.1 field, then hashes
// (JCS → SHA-256) and signs (Ed25519 over the raw 32-byte hash). The verbatim JCS text is
// returned alongside the op so the store persists it as `signed_core_jcs` (10-db §2.1) —
// re-serializing from typed columns can change bytes and break genuine signatures (05 §3).
//
// Absent-vs-null (05 §3): nullable fields are ALWAYS present-and-null here; there are no
// optional keys in the preimage. The non-JSON guard (undefined/NaN/Infinity/BigInt/
// function/symbol/exotic object anywhere in the core) is enforced by `hashSignedCore`
// BEFORE canonicalization via the JCS input guard (03's `JcsInputError`) — a bad payload
// throws, never silently mints a wrong hash.
import type { Location, OpSource, SignedCore, SignedOperation } from '@bolusi/schemas';

import { bytesToBase64 } from '../crypto/bytes.js';
import type { CryptoPort } from '../crypto/port.js';
import { hashSignedCore } from '../crypto/signed-core.js';

/**
 * The parts of an op a command handler controls (04 §5.1). Everything else is stamped by
 * the runtime. `payload` is Zod-validated against the module registry BEFORE it reaches
 * here (04 §3) — this layer's job is completion + signing, not payload schema validation.
 */
export interface OpDraft {
  readonly type: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly schemaVersion: number;
  readonly payload: Record<string, unknown>;
  /**
   * The envelope scope, RESOLVED from the op type's 04 §3 declaration (01 §6) — `null` for a
   * tenant-scoped type, the device's store otherwise.
   *
   * Optional, and `undefined` means "inherit the append context's storeId" — the same
   * `undefined = inherit` idiom `source`/`agentInitiated` below already use, and exactly the
   * behaviour every draft had before tenant-scoped types existed. `null` is NOT inherit: it is the
   * declared tenant scope, which is why the two are distinguished here rather than collapsed
   * (absent-vs-null, 05 §3).
   *
   * A handler never sets this: `ctx.op()` fills it from the registry, like `schemaVersion`.
   */
  readonly storeId?: string | null;
  /** Default `"ui"` (05 §2.1). */
  readonly source?: OpSource;
  /** Default `false` (05 §2.1; ARCH-001 §9.3). */
  readonly agentInitiated?: boolean;
  /** Default `null` (05 §2.1). */
  readonly agentConversationId?: string | null;
}

/** The runtime-stamped envelope fields a completed op needs on top of the draft (04 §5.1). */
export interface DraftCompletionContext {
  readonly id: string;
  readonly tenantId: string;
  readonly storeId: string | null;
  readonly userId: string;
  readonly deviceId: string;
  readonly seq: number;
  readonly previousHash: string;
  /** One ms-epoch stamp for the whole command (04 §5.2 — handlers have no clock). */
  readonly timestamp: number;
  /** From `LocationPort.getBestFix()`, already resolved; `null` never blocks (04 §5.1). */
  readonly location: Location | null;
}

/** A signed op plus its verbatim JCS preimage (persisted as `signed_core_jcs`, 10-db §2.1). */
export interface CompletedOp {
  readonly op: SignedOperation;
  readonly jcs: string;
}

/**
 * Complete + sign a draft.
 *
 * @throws {ZodError} if the assembled core is not exactly a §2.1 signed core.
 * @throws {JcsInputError} if any value in the core (typically `payload`) cannot be
 *   canonicalized — thrown BEFORE canonicalization, never a silent drop (05 §3).
 */
export function completeDraft(
  draft: OpDraft,
  ctx: DraftCompletionContext,
  secretKey: Uint8Array,
  crypto: CryptoPort,
): CompletedOp {
  const core: SignedCore = {
    id: ctx.id,
    tenantId: ctx.tenantId,
    storeId: ctx.storeId,
    userId: ctx.userId,
    deviceId: ctx.deviceId,
    seq: ctx.seq,
    type: draft.type,
    entityType: draft.entityType,
    entityId: draft.entityId,
    schemaVersion: draft.schemaVersion,
    payload: draft.payload,
    timestamp: ctx.timestamp,
    location: ctx.location,
    source: draft.source ?? 'ui',
    agentInitiated: draft.agentInitiated ?? false,
    agentConversationId: draft.agentConversationId ?? null,
    previousHash: ctx.previousHash,
  };

  // hashSignedCore parses zSignedCore (strict — absent-vs-null enforced, unknown keys
  // rejected) and runs the JCS input guard before canonicalizing (05 §3).
  const { jcs, hash, hashHex } = hashSignedCore(core, crypto);
  const signature = crypto.sign(hash, secretKey); // raw 32-byte digest is the message (05 §2.2)

  return { op: { ...core, hash: hashHex, signature: bytesToBase64(signature) }, jcs };
}
