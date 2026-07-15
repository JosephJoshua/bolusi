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
import type { Kysely } from 'kysely';

import { utf8ToBytes } from '../crypto/bytes.js';
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
import { assertPinFormat, verifyPin, type LockedOutEmitter } from './pin-verify.js';
import type { PinVerifierUploadPort, PinVerifierUploadResult } from './ports.js';
import {
  holdsMainOwnerRole,
  readPinAttempt,
  readVerifier,
  refFromOp,
  userInDirectory,
  writePinAttempt,
  writeVerifier,
} from './repo.js';
import {
  buildPinVerifier,
  chooseEffectiveVerifier,
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
 */
export const changePinCommand: CommandDefinition<PinChangeInput> = {
  name: 'changePin',
  permission: AUTH_PERMISSION.pinChange,
  input: pinChangeInput,
  handler: (input, ctx): CommandHandlerResult => {
    if (input.targetUserId !== ctx.userId) {
      throw new DomainError(
        'PERMISSION_DENIED',
        { target: 'changePin', reason: 'restriction_violated' },
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
  readonly userId: string;
  readonly verifierRef: string;
  readonly verifier: PinVerifier;
}

/** One drain attempt's outcome for a queued verifier. */
export type DrainOutcome =
  | { readonly verifierRef: string; readonly sent: true; readonly result: PinVerifierUploadResult }
  | { readonly verifierRef: string; readonly sent: false; readonly error: unknown };

/**
 * The verifier-POST queue (api/02-auth §5.4). A verifier computed offline is POSTed on next online
 * contact; the server applies the §5.3 greatest-`asOf` rule, so an `applied: false` answer is
 * TERMINAL-idempotent — the queue drops the item and never retries (no rollback, no loop). A network
 * error leaves it queued for the next contact; because the POST is idempotent, replaying it after a
 * crash converges.
 *
 * Keyed by `verifierRef`, so a change followed by another change to the same user leaves only the
 * latest pending (the older ref is superseded — the server would answer `applied: false` anyway).
 */
export class PinVerifierQueue {
  readonly #pending = new Map<string, PendingVerifier>();

  enqueue(item: PendingVerifier): void {
    this.#pending.set(item.verifierRef, item);
  }

  get pending(): readonly PendingVerifier[] {
    return [...this.#pending.values()];
  }

  get size(): number {
    return this.#pending.size;
  }

  /** POST every pending verifier. Terminal on any HTTP answer; a thrown transport error re-queues. */
  async drain(upload: PinVerifierUploadPort): Promise<DrainOutcome[]> {
    const outcomes: DrainOutcome[] = [];
    for (const item of [...this.#pending.values()]) {
      try {
        const result = await upload.upload(item.userId, item.verifierRef, item.verifier);
        this.#pending.delete(item.verifierRef); // terminal: applied true OR false (§5.4)
        outcomes.push({ verifierRef: item.verifierRef, sent: true, result });
      } catch (error) {
        outcomes.push({ verifierRef: item.verifierRef, sent: false, error }); // stays queued
      }
    }
    return outcomes;
  }
}

// ── orchestrators (the "offline PIN command handlers", 02-permissions §5.4.6) ─────────────────────

export interface PinFlowDeps<DB> {
  readonly runtime: CommandRuntime;
  readonly db: Kysely<DB>;
  readonly crypto: CryptoPort;
  readonly clock: ClockPort;
  readonly idSource: IdSource;
  readonly deviceId: string;
  readonly queue: PinVerifierQueue;
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
 */
export async function setFirstPin<DB>(
  deps: PinFlowDeps<DB>,
  input: { readonly userId: string; readonly pin: string },
): Promise<PendingVerifier> {
  assertPinFormat(input.pin);
  return emitVerifierChange(deps, {
    actorUserId: input.userId,
    targetUserId: input.userId,
    newPin: input.pin,
    command: changePinCommand,
  });
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
  assertPinFormat(input.newPin);
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
  assertPinFormat(input.newPin);
  if (!(await userInDirectory(deps.db, input.targetUserId))) {
    throw restrictionViolated('resetPin', 'target is not in this device’s directory (§5.4.6)');
  }
  const targetIsMainOwner = await holdsMainOwnerRole(deps.db, input.targetUserId);
  if (targetIsMainOwner && !(await holdsMainOwnerRole(deps.db, input.actorUserId))) {
    throw restrictionViolated(
      'resetPin',
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
    throw restrictionViolated(
      'clearPinLockout',
      'target is not in this device’s directory (§5.4.6)',
    );
  }
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
}

/**
 * The shared change/reset body: mint the `verifierRef`, run the command (append the op), then build
 * the verifier at the op's canonical `asOf` (§5.3), merge it locally (greatest-`asOf`), clear the
 * target's lockout (§6.5), and queue the POST.
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
  const verifierRef = deps.idSource();
  const ctx = deps.runtime.createContext(args.actorUserId);
  const outcome = await deps.runtime.execute(
    args.command,
    { targetUserId: args.targetUserId, verifierRef },
    ctx,
  );
  const asOf = refFromAppended(outcome);

  const salt = deps.crypto.randomBytes(PIN_KDF_BOUNDS.saltBytes); // 16 FRESH bytes (SEC-AUTH-06)
  const verifier = await buildPinVerifier(
    deps.crypto,
    utf8ToBytes(args.newPin),
    deps.kdfParams ?? DEFAULT_KDF_PARAMS,
    salt,
    asOf,
  );
  const existing = await readVerifier(deps.db, args.targetUserId);
  const winner = chooseEffectiveVerifier(existing, verifier) ?? verifier;
  await writeVerifier(deps.db, args.targetUserId, winner);
  // A new verifier clears the target's lockout and counter (§6.5) — the auth runtime, not an applier,
  // touches pin_attempt_state (03 §9.2).
  await writePinAttempt(deps.db, resetForNewVerifier(args.targetUserId, deps.deviceId));

  const pending: PendingVerifier = { userId: args.targetUserId, verifierRef, verifier };
  deps.queue.enqueue(pending);
  return pending;
}

function refFromAppended(outcome: CommandOutcome): CanonicalRef {
  const appended = outcome.ops[0];
  if (appended === undefined || appended.status !== 'appended') {
    throw new Error('expected the PIN op to be appended (api/02-auth §6.6)');
  }
  return refFromOp({
    timestamp: outcome.timestamp,
    deviceId: appended.op.deviceId,
    seq: appended.seq,
  });
}

function restrictionViolated(target: string, detail: string): DomainError {
  return new DomainError('PERMISSION_DENIED', { target, reason: 'restriction_violated' }, detail);
}
