// Adversarial signed-op builders for the SERVER push-validation surface (task 07; 05 §8–9).
//
// The committed JSON fixtures in packages/core/test/oplog/fixtures/tamper/ are the CLIENT
// verifyChain artifact — a device pubkey + hand-tampered ops. The SERVER pipeline needs more:
// a coherent directory world (tenant/store/user/device ids + a real Ed25519 keypair) whose
// ops seed rows AND push cleanly, so a tamper rejection is ATTRIBUTABLE — structurally valid
// except for the single tampered thing (testing-guide T-14b). These builders produce exactly
// that, deterministically from a seed, via the PRODUCTION sign path (`signOp` + a CryptoPort).
//
// Shared by tasks 03/05/07/15/26 (the task-07 file lists this as the reusable artifact).
import { bytesToBase64, GENESIS_OP_TYPE, hashSignedCore, signOp } from '@bolusi/core';
import type { CryptoPort } from '@bolusi/core';
import { GENESIS_PREVIOUS_HASH } from '@bolusi/schemas';
import type { OpSource, SignedCore, SignedOperation } from '@bolusi/schemas';

import { mulberry32, type Prng } from '../determinism/prng.js';

const HEX = '0123456789abcdef';

function hex(prng: Prng, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += HEX[Math.floor(prng() * 16)];
  return out;
}

/** FNV-1a 32-bit — a stable string→uint32 seed (no crypto needed; determinism is the point). */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** A syntactically valid UUIDv7 (`zUuidV7` accepts it) whose time field encodes `ms`. */
export function uuidV7(prng: Prng, ms: number): string {
  const timeHex = Math.floor(ms).toString(16).padStart(12, '0').slice(-12);
  const variant = HEX[8 + Math.floor(prng() * 4)];
  return `${timeHex.slice(0, 8)}-${timeHex.slice(8, 12)}-7${hex(prng, 3)}-${variant}${hex(prng, 3)}-${hex(prng, 12)}`;
}

/** A syntactically valid RFC 9562 v4 UUID — tenant/store/user/device ids. */
export function uuidV4(prng: Prng): string {
  const variant = HEX[8 + Math.floor(prng() * 4)];
  return `${hex(prng, 8)}-${hex(prng, 4)}-4${hex(prng, 3)}-${variant}${hex(prng, 3)}-${hex(prng, 12)}`;
}

/** The directory identity a built chain belongs to — enough to seed the server tables. */
export interface ChainWorld {
  readonly tenantId: string;
  readonly storeId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly secretKey: Uint8Array;
  readonly publicKey: Uint8Array;
  /** base64 of `publicKey` — what `devices.signing_key_public` stores (10-db §4). */
  readonly publicKeyB64: string;
}

/**
 * Deterministic world (ids + Ed25519 keypair) from a uint32 seed.
 *
 * Every id is a UUIDv7: 10-db §2 makes v7 the id format system-wide, and the envelope REQUIRES it
 * where an id lands in `entityId` (`zUuidV7`) — the genesis op sets `entityId = deviceId`, and the
 * pin ops set `entityId` = a target userId. A v4 id there fails `zSignedCore.parse` inside
 * `hashSignedCore`, which would surface as BAD_SIGNATURE and make every tamper test reject for the
 * wrong reason.
 */
export function makeWorld(seed: number, crypto: CryptoPort): ChainWorld {
  const prng = mulberry32(seed);
  // Derive the key seed from the harness seed (as VirtualDevice does, testing-guide §3.1) so the
  // keypair is reproducible and independent of id generation.
  const keySeed = crypto.sha256(
    new Uint8Array([seed & 0xff, (seed >>> 8) & 0xff, (seed >>> 16) & 0xff, (seed >>> 24) & 0xff]),
  );
  const { secretKey, publicKey } = crypto.ed25519Keygen(keySeed);
  const at = 1_726_000_000_000;
  return {
    tenantId: uuidV7(prng, at),
    storeId: uuidV7(prng, at + 1),
    userId: uuidV7(prng, at + 2),
    deviceId: uuidV7(prng, at + 3),
    secretKey,
    publicKey,
    publicKeyB64: bytesToBase64(publicKey),
  };
}

export interface OpSpec {
  readonly type: string;
  readonly entityType: string;
  readonly entityId?: string;
  readonly payload: Record<string, unknown>;
  readonly storeId?: string | null;
  readonly userId?: string;
  readonly deviceId?: string;
  readonly timestamp?: number;
  readonly source?: OpSource;
}

/**
 * Builds a valid, correctly-chained, correctly-signed op sequence for one device via the
 * PRODUCTION `signOp` path — the same code the client append path uses. Maintains
 * `seq`/`previousHash`/`hash` so the emitted ops satisfy the server chain check by
 * construction; a test then tampers exactly one thing.
 */
export class ChainBuilder {
  private head: { seq: number; hash: string } | null = null;
  private clock: number;
  /**
   * The id stream. Seeded from the world's deviceId — NOT from `seq` — so two worlds never mint
   * the same op id for the same position (testing-guide T-3: shared literals make tests pass by
   * coincidence; here they would also collide on the `operations` primary key).
   */
  private readonly ids: Prng;
  readonly ops: SignedOperation[] = [];

  constructor(
    private readonly world: ChainWorld,
    private readonly crypto: CryptoPort,
    startTimestamp = 1_726_000_000_000,
  ) {
    this.clock = startTimestamp;
    this.ids = mulberry32(fnv1a(world.deviceId));
  }

  /** The genesis op (`auth.device_enrolled`, seq 1, entityId = deviceId) — 05 §9.5. */
  genesis(overrides: Partial<OpSpec> = {}): SignedOperation {
    return this.append({
      type: GENESIS_OP_TYPE,
      entityType: 'device',
      entityId: this.world.deviceId,
      payload: {
        storeId: this.world.storeId,
        deviceName: 'device',
        devicePublicKeyB64: this.world.publicKeyB64,
      },
      ...overrides,
    });
  }

  /** Append one op, chaining + signing it. Returns the finished `SignedOperation`. */
  append(spec: OpSpec): SignedOperation {
    const seq = this.head === null ? 1 : this.head.seq + 1;
    const previousHash = this.head === null ? GENESIS_PREVIOUS_HASH : this.head.hash;
    const timestamp = spec.timestamp ?? (this.clock += 1_000);

    const core: SignedCore = {
      id: uuidV7(this.ids, timestamp + seq),
      tenantId: this.world.tenantId,
      storeId: spec.storeId === undefined ? this.world.storeId : spec.storeId,
      userId: spec.userId ?? this.world.userId,
      deviceId: spec.deviceId ?? this.world.deviceId,
      seq,
      type: spec.type,
      entityType: spec.entityType,
      entityId: spec.entityId ?? uuidV7(this.ids, timestamp + seq * 7),
      schemaVersion: 1,
      payload: spec.payload,
      timestamp,
      location: null,
      source: spec.source ?? 'ui',
      agentInitiated: false,
      agentConversationId: null,
      previousHash,
    };

    const op = signOp(core, this.world.secretKey, this.crypto);
    this.ops.push(op);
    this.head = { seq, hash: op.hash };
    return op;
  }
}

/**
 * Strip the derived §2.2 fields, leaving exactly the §2.1 signed core — the JCS/hash preimage.
 *
 * A named helper rather than `const { hash: _h, signature: _s, ...core } = op`: that idiom binds
 * two variables nobody reads, which `@typescript-eslint/no-unused-vars` rejects (the repo runs it
 * at error with no underscore escape hatch). One helper, used everywhere a core is needed.
 */
export function toSignedCore(op: SignedOperation): SignedCore {
  const core: Partial<SignedOperation> = { ...op };
  delete core.hash;
  delete core.signature;
  return core as SignedCore;
}

/** Re-sign a (possibly altered) core with `secretKey`, producing a VALID hash + signature. */
export function resign(
  op: SignedOperation,
  secretKey: Uint8Array,
  crypto: CryptoPort,
): SignedOperation {
  return signOp(toSignedCore(op), secretKey, crypto);
}

/** Recompute a valid hash for a core (used when forging a signature over a genuine hash). */
export function validHashOf(op: SignedOperation, crypto: CryptoPort): string {
  return hashSignedCore(toSignedCore(op), crypto).hashHex;
}
