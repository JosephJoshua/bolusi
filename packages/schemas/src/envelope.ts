// Signed-core envelope (05-operation-log §2.1–2.2). This is the hashed, signed,
// immutable layer — bookkeeping lives in ./bookkeeping.ts and is NEVER merged here.
import { z } from 'zod';

import { zBase64, zMsEpoch, zSha256Hex, zUuid, zUuidV7 } from './primitives.js';

/** `previousHash` of a device's genesis op (`seq: 1`): 64 zeros (05 §2.1). */
export const GENESIS_PREVIOUS_HASH = '0'.repeat(64);

export const OP_SOURCES = ['ui', 'agent', 'api', 'system'] as const;
export const zOpSource = z.enum(OP_SOURCES);
export type OpSource = z.infer<typeof zOpSource>;

/**
 * Best-available location fix (05 §2.1; never blocks — PRD-009 FR-802).
 * Strict: part of the hashed core, so unknown keys reject. lat/lng/accuracyMeters
 * are finite doubles by nature (GPS), not money — hence z.float64(), which is also
 * stricter than z.number() here: it rejects NaN/Infinity, so every admitted value
 * stays JCS-serializable (05 §3).
 *
 * `bolusi/no-float-money` DOES flag z.float64() everywhere (08 §5.2); these three
 * properties pass only via the rule's single explicit carve-out — allowlisted file
 * (this one) AND allowlisted property name (lat/lng/accuracyMeters), wired in
 * tooling/eslint/src/index.js. The carve-out is legitimate because location rides in
 * the signed ENVELOPE, not the payload, and 05 §3's no-floats rule is scoped to
 * payloads: the same `lat: z.float64()` in a module payload schema is still an error.
 * Renaming any of these to a money-ish name re-arms the rule on this file.
 */
export const zLocation = z.strictObject({
  lat: z.float64(),
  lng: z.float64(),
  accuracyMeters: z.float64(),
});
export type Location = z.infer<typeof zLocation>;

/**
 * Signed core (05 §2.1) — strict; unknown keys reject.
 *
 * Absent-vs-null (05 §3): nullable fields (`storeId`, `location`,
 * `agentConversationId`) are ALWAYS present, explicitly null. `.nullable()` only —
 * `.optional()` must never appear here (the JCS hash preimage has no optional keys).
 * Spec defaults (`source: "ui"`, `agentInitiated: false`, `agentConversationId: null`)
 * are applied by the op builder in @bolusi/core at append time, never by this
 * schema — an absent key must FAIL parse.
 */
export const zSignedCore = z.strictObject({
  id: zUuidV7,
  tenantId: zUuid,
  storeId: zUuid.nullable(),
  userId: zUuid,
  deviceId: zUuid,
  seq: z.number().int().min(1),
  type: z.string().min(1),
  entityType: z.string().min(1),
  entityId: zUuidV7,
  schemaVersion: z.number().int().min(1),
  payload: z.looseObject({}),
  timestamp: zMsEpoch,
  location: zLocation.nullable(),
  source: zOpSource,
  agentInitiated: z.boolean(),
  agentConversationId: z.string().nullable(),
  previousHash: zSha256Hex,
});
export type SignedCore = z.infer<typeof zSignedCore>;

/**
 * Signed operation (05 §2.2): the core plus the derived, immutable `hash`
 * (SHA-256 over the JCS serialization of the core) and `signature` (Ed25519 over
 * the raw 32-byte hash). Strict — this exact shape is what the client quarantine
 * path verifies pulled ops against (api/01 §4.2).
 */
export const zSignedOperation = z.strictObject({
  ...zSignedCore.shape,
  hash: zSha256Hex,
  signature: zBase64,
});
export type SignedOperation = z.infer<typeof zSignedOperation>;
