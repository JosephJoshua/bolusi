/**
 * The `userPinVerifiers` INSERT row, built in one place (task 208).
 *
 * This row sits on the PIN-auth boundary and was hand-built twice, field for field: once by
 * `apps/server/src/routes/users.ts` `writeVerifier` (the canonical writer) and once by
 * `packages/harness/src/harness-provision.ts` `seedOwnerPin`, which seeds the verifier the emulator
 * lane's on-device unlock depends on. The harness copy even cited its twin in a comment — which is
 * precisely how copies drift (the 2026-07-26 audit found the citing comment is the tell, not the
 * excuse), and here drift would be SILENT: the copy was an inline object literal with no shared type,
 * so a server-side row-shape change would not have failed the harness build. The lane would have kept
 * seeding a verifier production no longer writes, and nothing would have gone red.
 *
 * SCOPE — the ROW, not the statement. The two call sites genuinely differ in their statement:
 * `writeVerifier` UPSERTs (`.onConflict(...).doUpdateSet(...)`, because a user may re-set a PIN),
 * while the harness plain-INSERTs (a fresh lane owner has no conflict to resolve). Only the row is
 * shared; each caller still owns its own statement.
 */

/**
 * The verifier fields this row is built from — structural on purpose.
 *
 * `@bolusi/core`'s `PinVerifier` satisfies it, and so does the server's validated
 * `PutPinVerifierReq['verifier']`. Naming either concrete type here instead would make
 * `@bolusi/db-server` depend on that package purely to describe a parameter — this package sits
 * BELOW both and should not reach up into them for a type it can state structurally.
 *
 * (An earlier version of this comment claimed the two differ on `p` — core pinning `1` while the
 * wire type allowed a `number`. That was wrong: `packages/schemas/src/auth.ts` pins `p: z.literal(1)`
 * too. Corrected rather than deleted, because a plausible-sounding false reason in a comment is the
 * thing that survives review.)
 */
export interface PinVerifierRowInput {
  /** 16 CSPRNG bytes, base64 — a NEW salt on every set/change/reset (SEC-AUTH-06). */
  readonly saltB64: string;
  /** argon2 memory cost in KiB. */
  readonly mKiB: number;
  /** argon2 iterations. */
  readonly t: number;
  /** argon2 lanes. */
  readonly p: number;
  /** 32 bytes, base64. */
  readonly hashB64: string;
  /** The verifier's canonical position (api/02-auth §5.3 merge rule). */
  readonly asOf: {
    readonly timestamp: number;
    readonly deviceId: string;
    readonly seq: number;
  };
}

/** Which user, in which tenant, the verifier belongs to. */
export interface PinVerifierRowOwner {
  readonly userId: string;
  readonly tenantId: string;
}

/**
 * Map a validated verifier onto its `userPinVerifiers` row.
 *
 * The `params` cast is kept HERE, once, rather than at each call site: Kysely types the generated
 * jsonb column opaquely, so the `{ m, t, p }` map cannot be assigned to it without one. One cast in
 * one builder is the honest shape — two casts in two copies is how the two drift apart.
 */
export function buildPinVerifierRow(verifier: PinVerifierRowInput, owner: PinVerifierRowOwner) {
  return {
    userId: owner.userId,
    tenantId: owner.tenantId,
    algo: 'argon2id' as const,
    salt: verifier.saltB64,
    params: { m: verifier.mKiB, t: verifier.t, p: verifier.p } as never,
    hash: verifier.hashB64,
    asOfTimestamp: BigInt(verifier.asOf.timestamp),
    asOfDeviceId: verifier.asOf.deviceId,
    asOfSeq: BigInt(verifier.asOf.seq),
  };
}
