// PIN set / change / reset flows + the pending verifier-POST queue (api/02-auth §6.6, §5.4).
//
// TWO LAYERS, and the split is the point:
//   - The COMMANDS (`changePin`/`resetPin`/`clearPinLockout`) are `CommandDefinition`s run through
//     the ONE command runtime (task 10). Their permission is checked at the single enforcement point
//     (02-permissions §4); their handlers are PURE — they emit `{ targetUserId, verifierRef }` and
//     NOTHING else. No salt, no hash: an op payload carrying verifier material would be an
//     unrotatable secret in an append-only log (D11, api/02-auth §6.2).
//   - The ORCHESTRATORS are "the offline PIN command handlers" 02-permissions §5.4.6 rule 6 names:
//     they run the KDF, apply the §5.4.6 targeting restrictions that need the directory, write the
//     local verifier at the emitted op's `asOf`, clear the target's lockout, and queue the POST.
//
// The client arm of the anti-escalation rules lives here; the server push-validates the same rules
// (§6.3) as the backstop against a tampered client that skips this layer.
import { sql, type Kysely } from 'kysely';

import { utf8ToBytes } from '../crypto/bytes.js';
import type { AppendedOp } from '../oplog/append.js';
import type { CryptoPort, KdfParams } from '../crypto/port.js';
import { DomainError } from '../errors/domain-error.js';
import type { CommandContext, InputParser } from '../runtime/ctx.js';
import type {
  CommandDefinition,
  CommandHandlerResult,
  CommandOutcome,
} from '../runtime/execute.js';
import type { CommandRuntime } from '../runtime/execute.js';
import type { ClockPort, IdSource } from '../runtime/ports.js';
import { DEFAULT_KDF_PARAMS } from '../crypto/port.js';
import { PIN_KDF_BOUNDS } from './constants.js';
import { clearLockout, resetForNewVerifier } from './lockout.js';
import { AUTH_ENTITY, AUTH_OP, AUTH_PERMISSION } from './operations.js';
import {
  assertNewPin,
  attemptLockKey,
  verifyPin,
  withAttemptLock,
  type LockedOutEmitter,
} from './pin-verify.js';
import type { PinVerifierUploadPort, PinVerifierUploadResult } from './ports.js';
import {
  deleteMeta,
  FIRST_PIN_USER_META_KEY,
  holdsMainOwnerRole,
  readMeta,
  readPinAttempt,
  readVerifier,
  refFromOp,
  sealedVerifierValues,
  userInDirectory,
  verifierFromRow,
  writePinAttempt,
  writeVerifier,
  type StoredVerifierRow,
} from './repo.js';
import {
  chooseEffectiveVerifier,
  hashNewPin,
  type CanonicalRef,
  type PinVerifier,
} from './verifier.js';

// ── strict input parsers (Zod's behaviour, without importing Zod — 08 §3.3) ──────────────────────

class PinInputError extends Error {
  readonly issues: readonly { path: readonly string[]; code: string }[];
  constructor(issues: readonly { path: readonly string[]; code: string }[]) {
    super('pin command input rejected');
    this.issues = issues;
  }
}

function strictUuidFields<T>(keys: readonly string[]): InputParser<T> {
  return {
    parse(raw: unknown): T {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new PinInputError([{ path: [], code: 'invalid_type' }]);
      }
      const value = raw as Record<string, unknown>;
      const issues: { path: readonly string[]; code: string }[] = [];
      for (const extra of Object.keys(value).filter((k) => !keys.includes(k))) {
        issues.push({ path: [extra], code: 'unrecognized_keys' });
      }
      for (const key of keys) {
        if (typeof value[key] !== 'string' || (value[key] as string).length === 0) {
          issues.push({ path: [key], code: 'invalid_type' });
        }
      }
      if (issues.length > 0) throw new PinInputError(issues);
      return value as T;
    },
  };
}

// ── command inputs ───────────────────────────────────────────────────────────────────────────────

export interface PinChangeInput {
  readonly targetUserId: string;
  readonly verifierRef: string;
}
export interface ClearLockoutInput {
  readonly targetUserId: string;
}

const pinChangeInput = strictUuidFields<PinChangeInput>(['targetUserId', 'verifierRef']);
const clearLockoutInput = strictUuidFields<ClearLockoutInput>(['targetUserId']);

// ── the three commands (api/02-auth §6.3) — pure handlers, verifier-free payloads ─────────────────

/**
 * `auth.changePin` (permission `auth.pin_change`, every role). SELF-ONLY: the handler rejects a
 * non-self target with `restriction_violated` (02-permissions §5.4.6) — this check is IN the pure
 * handler, so it runs on every execution and a client that calls `execute` directly cannot skip it.
 *
 * The handler is pure and cannot emit, so it only DECLARES the denial by throwing; the command
 * runtime EMITS the `auth.permission_denied` op (reason `restriction_violated`) when it sees this
 * throw (02 §7 amended "Emitted by") — so this restriction denial is audited like any other.
 */
export const changePinCommand: CommandDefinition<PinChangeInput> = {
  name: 'changePin',
  permission: AUTH_PERMISSION.pinChange,
  input: pinChangeInput,
  handler: (input, ctx): CommandHandlerResult => {
    if (input.targetUserId !== ctx.userId) {
      throw restrictionViolated(
        'changePin',
        'auth.pin_change may target only the acting user (02-permissions §5.4.6)',
      );
    }
    return { ops: [emitPinChanged(ctx, AUTH_OP.pinChanged, input)] };
  },
};

/** `auth.resetPin` (permission `auth.user_reset_pin`, owner roles). Targeting is orchestrator-side. */
export const resetPinCommand: CommandDefinition<PinChangeInput> = {
  name: 'resetPin',
  permission: AUTH_PERMISSION.userResetPin,
  input: pinChangeInput,
  handler: (input, ctx): CommandHandlerResult => ({
    ops: [emitPinChanged(ctx, AUTH_OP.pinReset, input)],
  }),
};

/** `auth.clearPinLockout` (permission `auth.pin_unlock`, owner roles). Empty payload (§6.2). */
export const clearPinLockoutCommand: CommandDefinition<ClearLockoutInput> = {
  name: 'clearPinLockout',
  permission: AUTH_PERMISSION.pinUnlock,
  input: clearLockoutInput,
  handler: (input, ctx): CommandHandlerResult => ({
    ops: [
      ctx.op({
        type: AUTH_OP.pinLockoutCleared,
        entityType: AUTH_ENTITY.userCredential,
        entityId: input.targetUserId,
        payload: {},
      }),
    ],
  }),
};

function emitPinChanged(ctx: CommandContext, type: string, input: PinChangeInput) {
  return ctx.op({
    type,
    entityType: AUTH_ENTITY.userCredential,
    entityId: input.targetUserId,
    // EXACTLY `{ targetUserId, verifierRef }` — no salt/hash field exists (D11, §6.2).
    payload: { targetUserId: input.targetUserId, verifierRef: input.verifierRef },
  });
}

// ── the pending verifier-POST queue (api/02-auth §5.4) ────────────────────────────────────────────

/** A verifier awaiting `POST /v1/users/:userId/pin-verifier` on next online contact. */
export interface PendingVerifier {
  /** The TARGET whose verifier this is — the `:userId` in the POST path. */
  readonly userId: string;
  /**
   * The user the POST acts AS — `X-Acting-User` (api/02-auth §6.6). Equals `userId` for a self-change
   * (`setFirstPin`/`changePin`), but is the RESETTING OWNER for an owner reset, whom the server checks
   * for `auth.user_reset_pin`. Carried here so the drain sends the actor, not the target — sending the
   * target on a reset would bypass the server's reset-permission check (task 186b-2).
   */
  readonly actorUserId: string;
  readonly verifierRef: string;
  readonly verifier: PinVerifier;
}

/** One drain attempt's outcome for a queued verifier. */
export type DrainOutcome =
  | { readonly verifierRef: string; readonly sent: true; readonly result: PinVerifierUploadResult }
  | { readonly verifierRef: string; readonly sent: false; readonly error: unknown };

/**
 * The verifier-POST queue (api/02-auth §5.4), one `pending_pin_verifiers` row per verifier. A verifier
 * computed offline is POSTed on next online contact; the server applies the §5.3 greatest-`asOf`
 * rule, so an `applied: false` answer is TERMINAL-idempotent — the row is deleted and never retried
 * (no rollback, no loop). A network error leaves it queued for the next contact. The rows are on disk
 * because the PIN op syncs on its own: a queue lost to an app kill would leave the server with the op
 * but never the verifier, so no other device would ever learn the new PIN. Because the POST is
 * idempotent, replaying it after a crash converges. `salt`, `params` and `hash` are sealed at rest.
 *
 * Keyed by `verifierRef`: every change mints a new ref, so two changes to one user queue two rows and
 * the server keeps the newer by `asOf`.
 */
export async function enqueuePendingVerifier<DB>(
  db: Kysely<DB>,
  item: PendingVerifier,
): Promise<void> {
  await sql`
    INSERT INTO pending_pin_verifiers
      (verifier_ref, user_id, actor_user_id,
       algo, salt, params, hash, as_of_timestamp, as_of_device_id, as_of_seq)
    VALUES (${item.verifierRef}, ${item.userId}, ${item.actorUserId},
            ${sealedVerifierValues(db, item.verifier)})
    ON CONFLICT (verifier_ref) DO NOTHING
  `.execute(db);
}

/** Every verifier still waiting for its POST, oldest change first. */
export async function readPendingVerifiers<DB>(db: Kysely<DB>): Promise<PendingVerifier[]> {
  const rows = await sql<
    StoredVerifierRow & { verifierRef: string; userId: string; actorUserId: string }
  >`
    SELECT verifier_ref AS "verifierRef", user_id AS "userId", actor_user_id AS "actorUserId",
           algo, salt, params, hash,
           as_of_timestamp AS "asOfTimestamp",
           as_of_device_id AS "asOfDeviceId",
           as_of_seq AS "asOfSeq"
    FROM pending_pin_verifiers
    ORDER BY as_of_timestamp, as_of_device_id, as_of_seq
  `.execute(db);
  return rows.rows.map((row) => ({
    userId: row.userId,
    actorUserId: row.actorUserId,
    verifierRef: row.verifierRef,
    verifier: verifierFromRow(row, 'pending_pin_verifiers'),
  }));
}

/** POST every pending verifier. Terminal on any HTTP answer; a thrown transport error keeps the row. */
export async function drainPendingVerifiers<DB>(
  db: Kysely<DB>,
  upload: PinVerifierUploadPort,
): Promise<DrainOutcome[]> {
  const outcomes: DrainOutcome[] = [];
  for (const item of await readPendingVerifiers(db)) {
    try {
      const result = await upload.upload(
        item.userId,
        item.verifierRef,
        item.verifier,
        item.actorUserId,
      );
      // Terminal: applied true OR false (§5.4).
      await sql`DELETE FROM pending_pin_verifiers WHERE verifier_ref = ${item.verifierRef}`.execute(
        db,
      );
      outcomes.push({ verifierRef: item.verifierRef, sent: true, result });
    } catch (error) {
      outcomes.push({ verifierRef: item.verifierRef, sent: false, error }); // stays queued
    }
  }
  return outcomes;
}

// ── orchestrators (the "offline PIN command handlers", 02-permissions §5.4.6) ─────────────────────

export interface PinFlowDeps<DB> {
  readonly runtime: CommandRuntime;
  readonly db: Kysely<DB>;
  readonly crypto: CryptoPort;
  readonly clock: ClockPort;
  readonly idSource: IdSource;
  readonly deviceId: string;
  /** The KDF profile a new verifier is built with. Defaults to the §5.3 default; the floor (or any
   *  in-bounds profile) may be swapped in (D12) — the value is never hardcoded past this seam. */
  readonly kdfParams?: KdfParams;
  /** For the current-PIN verify in `changePin` — the `auth.pin_locked_out` emission. */
  readonly emitter: LockedOutEmitter;
}

/**
 * First PIN (api/02-auth §6.6): the bundle row had `pinVerifier: null`. The current-PIN check is
 * SKIPPED (no verifier exists at any `asOf`). Emits `auth.pin_changed`, writes the local verifier,
 * queues the POST.
 *
 * Only for the owner who enrolled this device (`FIRST_PIN_USER_META_KEY`). A phone that is offline or
 * behind can show "no PIN" for a colleague who made one elsewhere; a self-made PIN there would sign a
 * coworker in as them and, once synced, replace their real PIN. So every other first PIN comes from an
 * owner through `resetPin`, typed by the colleague.
 */
let firstPinChain: Promise<void> = Promise.resolve();

export async function setFirstPin<DB>(
  deps: PinFlowDeps<DB>,
  input: { readonly userId: string; readonly pin: string },
): Promise<PendingVerifier> {
  // Serialized, so two quick taps cannot both pass the checks below and emit two first PINs. Not the
  // attempt lock: `emitVerifierChange` takes that one inside, and it does not nest.
  const run = firstPinChain.then(async () => {
    assertNewPin(input.pin);
    // Only a user with NO PIN yet. Without this, anyone at the counter could replace a colleague's PIN
    // through the first-PIN path and sign in as them; an existing PIN changes only via `changePin`
    // (knowing the current one) or an owner's `resetPin`.
    if ((await readVerifier(deps.db, input.userId)) !== null) {
      throw new DomainError(
        'INVALID_TRANSITION',
        { reason: 'pin_already_set' },
        'this user already has a PIN — use change or owner reset (api/02-auth §6.6)',
      );
    }
    if ((await readMeta(deps.db, FIRST_PIN_USER_META_KEY)) !== input.userId) {
      throw new DomainError(
        'INVALID_TRANSITION',
        { reason: 'first_pin_needs_owner' },
        'only the enrolling owner makes their own first PIN; an owner makes everyone else’s',
      );
    }
    const pending = await emitVerifierChange(deps, {
      actorUserId: input.userId,
      targetUserId: input.userId,
      newPin: input.pin,
      command: changePinCommand,
    });
    await deleteMeta(deps.db, FIRST_PIN_USER_META_KEY);
    return pending;
  });
  firstPinChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** The one user who may make their own first PIN on this device, if any (see `setFirstPin`). */
export function firstPinUserOnThisDevice<DB>(db: Kysely<DB>): Promise<string | null> {
  return readMeta(db, FIRST_PIN_USER_META_KEY);
}

/**
 * Change own PIN (api/02-auth §6.6). Verifies the CURRENT PIN locally FIRST (gated by the lockout
 * machine — a wrong current PIN burns an attempt), then emits `auth.pin_changed`.
 *
 * @throws {DomainError} `NOT_AUTHENTICATED` when the current PIN is wrong; `PIN_LOCKED` /
 *   `PIN_RATE_LIMITED` when the current-PIN attempt is gated.
 */
export async function changePin<DB>(
  deps: PinFlowDeps<DB>,
  input: { readonly userId: string; readonly currentPin: string; readonly newPin: string },
): Promise<PendingVerifier> {
  assertNewPin(input.newPin);
  const verified = await verifyPin(
    {
      db: deps.db,
      crypto: deps.crypto,
      clock: deps.clock,
      deviceId: deps.deviceId,
      emitter: deps.emitter,
    },
    { userId: input.userId, pin: input.currentPin },
  );
  if (!verified.ok) {
    throw new DomainError(
      'NOT_AUTHENTICATED',
      { reason: 'current_pin_incorrect' },
      'current PIN is incorrect — change refused (api/02-auth §6.6)',
    );
  }
  return emitVerifierChange(deps, {
    actorUserId: input.userId,
    targetUserId: input.userId,
    newPin: input.newPin,
    command: changePinCommand,
  });
}

/**
 * Owner PIN reset (api/02-auth §6.6). Applies the §5.4.6 targeting restrictions (target present in
 * the directory) and the §6.6 privileged-target rule (resetting a main_owner-role holder requires
 * the actor to hold main_owner) BEFORE the command runs, then emits `auth.pin_reset`. Clears the
 * target's lockout. Works offline; the POST rides the next online contact.
 *
 * @throws {DomainError} `PERMISSION_DENIED` `restriction_violated` on a targeting/privileged-target
 *   violation; `PERMISSION_DENIED` (with `auth.permission_denied` emitted) when the actor lacks
 *   `auth.user_reset_pin` (raised inside `execute`).
 */
export async function resetPin<DB>(
  deps: PinFlowDeps<DB>,
  input: { readonly actorUserId: string; readonly targetUserId: string; readonly newPin: string },
): Promise<PendingVerifier> {
  assertNewPin(input.newPin);
  if (!(await userInDirectory(deps.db, input.targetUserId))) {
    return deps.runtime.denyRestriction(
      input.actorUserId,
      resetPinCommand.permission,
      resetPinCommand.name,
      'target is not in this device’s directory (§5.4.6)',
    );
  }
  const targetIsMainOwner = await holdsMainOwnerRole(deps.db, input.targetUserId);
  if (targetIsMainOwner && !(await holdsMainOwnerRole(deps.db, input.actorUserId))) {
    return deps.runtime.denyRestriction(
      input.actorUserId,
      resetPinCommand.permission,
      resetPinCommand.name,
      'resetting a main_owner-role holder requires the actor to hold main_owner (§6.6)',
    );
  }
  return emitVerifierChange(deps, {
    actorUserId: input.actorUserId,
    targetUserId: input.targetUserId,
    newPin: input.newPin,
    command: resetPinCommand,
  });
}

/**
 * Owner unlock (api/02-auth §6.5, 03-state-machines §9.2: `locked_out → unlocked`). Requires the
 * target to be locked (else `INVALID_TRANSITION` — nothing to clear) and present in the directory
 * (§5.4.6). Emits `auth.pin_lockout_cleared` and resets the target's counter. Offline-capable.
 *
 * @throws {DomainError} `PERMISSION_DENIED` `restriction_violated` (target absent); `INVALID_TRANSITION`
 *   (target not locked); `PERMISSION_DENIED` (+ denial op) when the actor lacks `auth.pin_unlock`.
 */
export async function clearPinLockoutFlow<DB>(
  deps: PinFlowDeps<DB>,
  input: { readonly actorUserId: string; readonly targetUserId: string },
): Promise<CommandOutcome> {
  if (!(await userInDirectory(deps.db, input.targetUserId))) {
    return deps.runtime.denyRestriction(
      input.actorUserId,
      clearPinLockoutCommand.permission,
      clearPinLockoutCommand.name,
      'target is not in this device’s directory (§5.4.6)',
    );
  }
  // The read→gate→write on `pin_attempt_state` is the SAME read-modify-write `verifyPin` serializes
  // (pin-verify.ts): read the row, decide the transition on it, write the result. Run it under the
  // one attempt lock for `(targetUserId, deviceId)`, or an owner's clear races a concurrent losing
  // attempt — last-write-wins on the counter, and `auth.pin_locked_out` can fire for a user whose row
  // then reads 0 (F7). Same key, one lock domain — never a second copy (§2.8).
  return withAttemptLock(attemptLockKey(input.targetUserId, deps.deviceId), async () => {
    const row = await readPinAttempt(deps.db, input.targetUserId, deps.deviceId);
    // Validate the transition on the PRE-command row; clearLockout throws INVALID_TRANSITION unless
    // locked, so a no-op clear never emits an op.
    const cleared = clearLockout(row, input.targetUserId, deps.deviceId);
    const ctx = deps.runtime.createContext(input.actorUserId);
    const outcome = await deps.runtime.execute(
      clearPinLockoutCommand,
      { targetUserId: input.targetUserId },
      ctx,
    );
    await writePinAttempt(deps.db, cleared);
    return outcome;
  });
}

/**
 * The shared change/reset body: hash the new PIN, mint the `verifierRef`, and run the command. In the
 * op's own transaction, place the verifier at the op's canonical `asOf` (§5.3), queue the POST and
 * merge it locally (greatest-`asOf`). Then clear the target's lockout (§6.5).
 */
async function emitVerifierChange<DB>(
  deps: PinFlowDeps<DB>,
  args: {
    readonly actorUserId: string;
    readonly targetUserId: string;
    readonly newPin: string;
    readonly command: CommandDefinition<PinChangeInput>;
  },
): Promise<PendingVerifier> {
  // The KDF runs BEFORE the command, so the expensive part is done when the transaction opens.
  const salt = deps.crypto.randomBytes(PIN_KDF_BOUNDS.saltBytes); // 16 FRESH bytes (SEC-AUTH-06)
  const material = await hashNewPin(
    deps.crypto,
    utf8ToBytes(args.newPin),
    deps.kdfParams ?? DEFAULT_KDF_PARAMS,
    salt,
  );
  const verifierRef = deps.idSource();
  const ctx = deps.runtime.createContext(args.actorUserId);
  const placed: { pending?: PendingVerifier } = {};
  await deps.runtime.execute(args.command, { targetUserId: args.targetUserId, verifierRef }, ctx, {
    // The queued upload and the local verifier commit WITH the op. The op syncs on its own, so an
    // op that landed without its queued verifier would give the server a PIN change it can never
    // apply, and no other device would learn the new PIN.
    withinAppend: async (ops) => {
      const verifier: PinVerifier = { ...material, asOf: refFromAppended(ops) };
      const pending = {
        userId: args.targetUserId,
        actorUserId: args.actorUserId,
        verifierRef,
        verifier,
      };
      placed.pending = pending;
      await enqueuePendingVerifier(deps.db, pending);
      const existing = await readVerifier(deps.db, args.targetUserId);
      await writeVerifier(
        deps.db,
        args.targetUserId,
        chooseEffectiveVerifier(existing, verifier) ?? verifier,
      );
    },
  });
  const { pending } = placed;
  if (pending === undefined) {
    throw new Error('expected the PIN op to be appended (api/02-auth §6.6)');
  }

  // A new verifier clears the target's lockout and counter (§6.5) — the auth runtime, not an applier,
  // touches pin_attempt_state (03 §9.2). Under the SAME attempt lock as `verifyPin`: this reset would
  // otherwise clobber (or be clobbered by) a concurrent losing attempt's counter write — the same
  // TOCTOU class one file away (F7). Same key, one lock domain (§2.8).
  await withAttemptLock(attemptLockKey(args.targetUserId, deps.deviceId), () =>
    writePinAttempt(deps.db, resetForNewVerifier(args.targetUserId, deps.deviceId)),
  );
  return pending;
}

function refFromAppended(ops: readonly AppendedOp[]): CanonicalRef {
  const appended = ops[0];
  if (appended === undefined || appended.status !== 'appended') {
    throw new Error('expected the PIN op to be appended (api/02-auth §6.6)');
  }
  return refFromOp({
    timestamp: appended.op.timestamp,
    deviceId: appended.op.deviceId,
    seq: appended.seq,
  });
}

/**
 * Build a §5.4.6 restriction denial as a `DomainError` — for a check that runs INSIDE a pure command
 * handler (`changePinCommand`), which cannot emit. Throwing it DECLARES the denial; the command
 * runtime recognises `reason: 'restriction_violated'` and EMITS the `auth.permission_denied` op
 * (02 §7 amended). The orchestrators (reset/clear), which run OUTSIDE a pure handler, instead call
 * `runtime.denyRestriction` directly — both routes reach the one enforcement point / one emitter.
 */
function restrictionViolated(target: string, detail: string): DomainError {
  return new DomainError('PERMISSION_DENIED', { target, reason: 'restriction_violated' }, detail);
}
