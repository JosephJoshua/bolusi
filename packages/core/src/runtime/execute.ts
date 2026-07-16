// The command runtime (04-module-contract §5.1) — THE only write path, and the single
// enforcement point for authorization (02-permissions §4).
//
// It composes three finished layers and adds no logic of its own to any of them:
//   the permission evaluator (task 09, ../authz)   — DECIDES. This file never re-derives a scope,
//                                                    never re-reads the directory, never builds a
//                                                    second registry (CLAUDE.md §2.8).
//   the op append path (task 06, ../oplog)         — completes, signs, chains, inserts.
//   the projection engine (task 08, ../projection) — applies, inside the append's transaction.
//
// THE SEQUENCE (§5.1), in this order, always:
//   1. input = command.input.parse(rawInput)      strict Zod → VALIDATION_FAILED
//   2. requirePermission(command.permission)      fail closed → PERMISSION_DENIED + denial op
//   3. result = command.handler(input, ctx)       PURE: reads via ctx.query only
//   4. complete drafts with EVERY §2.1 field      one timestamp stamp; location via the port
//   5. append locally          ┐ atomic
//   6. apply projections       ┘ one transaction
//   7. schedule sync (debounced)
//
// WHY STEP 2 DOES NOT CALL `ctx.requirePermission`. §5.1 writes the step as
// `ctx.requirePermission(command.permission)`, and this file deliberately does NOT do that. `ctx`
// is an ARGUMENT to `execute`, so anything ctx-shaped can be passed — including a ctx whose
// `requirePermission` is a no-op and whose `userId` is someone else's. Routing THE control through
// a caller-supplied object would make the one thing 02 §4 calls "the only control" overridable by
// its own caller. So step 2 calls the runtime's own evaluator directly, and the ctx is checked for
// this runtime's brand first (a foreign ctx denies). `ctx.requirePermission` remains, delegating to
// the identical internal function, for handlers that need a second input-dependent check — one
// implementation, two entry points.
//
// WHY A DENIAL IS AN ERROR AND NEVER AN EMPTY RESULT. 02 §4 / FR-1036: an empty result leaks "the
// store exists and is quiet". Every denial path here throws.
import type { Location, OpSource } from '@bolusi/schemas';

import {
  DenialEmitter,
  PERMISSION_DENIAL_ENTITY_TYPE,
  PERMISSION_DENIED_OP_TYPE,
  type DenialSurface,
} from '../authz/denials.js';
import type { PermissionEvaluator } from '../authz/memo.js';
import { DomainError } from '../errors/domain-error.js';
// Type-only, and therefore erased: the module layer imports this file for `CommandHandlerResult`,
// so a value import here would be a genuine ESM cycle. `import type` makes the edge disappear at
// runtime (verbatimModuleSyntax keeps it honest).
import type { OperationScope } from '../module/define-module.js';
import type { OperationRegistry } from '../module/registry.js';
import {
  appendLocalOps,
  type AppendContext,
  type AppendedOp,
  type OpAppendStore,
  type ProjectionApply,
} from '../oplog/append.js';
import type { OpDraft } from '../oplog/draft.js';
import type { CryptoPort } from '../crypto/port.js';
import {
  createCommandContext,
  CTX_RUNTIME_BRAND,
  defaultInvocation,
  isOwnContext,
  type BrandedCommandContext,
  type CommandContext,
  type CommandIdentity,
  type InputParser,
  type InvocationMeta,
  type QueryExecutorPort,
} from './ctx.js';
import type {
  ClockPort,
  IdSource,
  LocationPort,
  SigningKeyPort,
  SyncSchedulerPort,
} from './ports.js';
import { PermissionEnforcementPoint } from './enforce.js';
import {
  assertSanctionedEmission,
  type SanctionedRuntimeEmissionType,
} from './runtime-emissions.js';

/**
 * The device's fixed scope (05 §2.1 attribution; 02 §5.2's v0 rule).
 *
 * **Held at CONSTRUCTION, not passed per command — deliberately.** 02 §5.2 is normative: the
 * evaluation store is the enrolled device's store, ALWAYS. If the caller supplied `storeId` per
 * command it could hand one store to the permission check and another to the envelope, and
 * "an op's recorded scope always equals the scope it was authorized in" would be a convention
 * someone has to honor instead of a fact. One field feeds both. The FR-1034 store switcher is v1
 * and will change this deliberately, not by accident.
 *
 * `userId` is NOT here: it is the one part of the identity that legitimately changes at runtime
 * (user switching, FR-1014), so it arrives with the context.
 */
export interface DeviceIdentity {
  readonly tenantId: string;
  /** Null = a tenant-scoped device context (05 §2.1). */
  readonly storeId: string | null;
  readonly deviceId: string;
}

/** What a handler returns (04 §5.1): op drafts + an optional typed result. */
export interface CommandHandlerResult<TResult = void> {
  readonly ops: readonly OpDraft[];
  readonly result?: TResult;
}

/**
 * A command (04 §5). The static `permission` declaration is what registry assembly resolves
 * (02 §3.2 rule 3) and what step 2 enforces.
 */
export interface CommandDefinition<TInput = unknown, TResult = void> {
  /**
   * The command's name — the manifest key (`commands: { createNote: {...} }`, 04 §5). Task 11's
   * `defineModule` populates it from that key; it is required here because the denial op's
   * `target` field (02 §7) names the command that was denied, and an audit record that cannot say
   * WHAT was attempted is not much of an audit record.
   */
  readonly name: string;
  /** The permission this command requires (04 §5, 02 §3.2 rule 3). */
  readonly permission: string;
  /** Strict Zod schema (04 §5.1 step 1). Unknown key / wrong type → VALIDATION_FAILED. */
  readonly input: InputParser<TInput>;
  /** PURE (04 §5.2): no clock, no db, no network, no nested commands. */
  readonly handler: (
    input: TInput,
    ctx: CommandContext,
  ) => CommandHandlerResult<TResult> | Promise<CommandHandlerResult<TResult>>;
}

/** What `execute` returns: the appended ops and the handler's optional typed result. */
export interface CommandOutcome<TResult = void> {
  readonly ops: readonly AppendedOp[];
  readonly result: TResult | undefined;
  /** The single §5.2 stamp applied to every op of this command. */
  readonly timestamp: number;
}

/** An op the runtime appends without a command (04 §5.1's five sanctioned emissions). */
export interface RuntimeEmissionDraft {
  /** Compile-time restricted to the five; `assertSanctionedEmission` is the runtime backstop. */
  readonly type: SanctionedRuntimeEmissionType;
  readonly entityType: string;
  readonly entityId: string;
  /**
   * The emission's payload version.
   *
   * NOT resolved from the 04 §3 operation registry the way `ctx.op()` is — deliberately, for now.
   * The five sanctioned types are appended by the runtime BEFORE any module could own them, and no
   * v0 manifest declares them yet: `auth.*` op types arrive with the auth module (tasks 13/25),
   * which will declare `auth.permission_denied` alongside the `auth_permission_denials` applier
   * (02 §7). WHEN THAT LANDS, this field should resolve from the registry exactly as `ctx.op()`
   * does, and this default deleted — otherwise the same op type has two answers about its version
   * (CLAUDE.md §2.8). Flagged for tasks 13/25; not silently left as "fine".
   */
  readonly schemaVersion?: number;
  readonly payload: Record<string, unknown>;
  /**
   * The op's `userId` (05 §2.1). Explicit because the five do not share one answer: a lockout op
   * is attributed to the locked-out user, a denial to the denied actor, a user-switch to the user
   * being switched to.
   */
  readonly userId: string;
  readonly source?: OpSource;
  readonly agentInitiated?: boolean;
  readonly agentConversationId?: string | null;
}

export interface CommandRuntimeOptions {
  readonly device: DeviceIdentity;
  /** DECIDES authorization (task 09). The runtime calls it; it never re-implements it. */
  readonly evaluator: PermissionEvaluator;
  /**
   * The 04 §3 operation registry — resolves each op type's declared `schemaVersion` for `ctx.op()`.
   *
   * REQUIRED, not optional. An optional registry would need a fallback, and the only available
   * fallback is the `1` that task 10 left as a stopgap for exactly this task to remove — i.e. the
   * second answer CLAUDE.md §2.8 forbids, reintroduced as a default parameter. A runtime that
   * cannot say what version an op type is at cannot mint that op.
   */
  readonly operations: OperationRegistry;
  readonly store: OpAppendStore;
  readonly crypto: CryptoPort;
  readonly clock: ClockPort;
  readonly idSource: IdSource;
  readonly location: LocationPort;
  readonly signingKey: SigningKeyPort;
  readonly queryExecutor: QueryExecutorPort;
  /** Task 08's engine plugs in here; it runs INSIDE the append transaction (§5.1 steps 5–6). */
  readonly applyProjection: ProjectionApply;
  readonly syncScheduler: SyncSchedulerPort;
  /** Overrides the §7 denial-throttle window. For the suite's boundary cases only. */
  readonly denialThrottleWindowMs?: number;
}

/**
 * The command runtime. One instance per device.
 *
 * Everything effectful is injected (08 §3.2), so the whole runtime is constructible from a
 * FakeClock + seeded IdSource and reproduces byte-for-byte per seed (testing-guide T-6) — which is
 * what every CHAOS scenario's simulator is built on.
 */
export class CommandRuntime {
  readonly #device: DeviceIdentity;
  readonly #evaluator: PermissionEvaluator;
  readonly #operations: OperationRegistry;
  readonly #store: OpAppendStore;
  readonly #crypto: CryptoPort;
  readonly #clock: ClockPort;
  readonly #idSource: IdSource;
  readonly #location: LocationPort;
  readonly #signingKey: SigningKeyPort;
  readonly #queryExecutor: QueryExecutorPort;
  readonly #applyProjection: ProjectionApply;
  readonly #syncScheduler: SyncSchedulerPort;
  readonly #denialEmitter: DenialEmitter;
  /**
   * THE single control (02 §4), shared with the query runtime — see runtime/enforce.ts for why it
   * is one object rather than one per surface.
   */
  readonly #enforcement: PermissionEnforcementPoint;
  /** Identity of THIS runtime, for the ctx brand (ctx.ts). A fresh object per instance. */
  readonly #brand: object = {};

  constructor(options: CommandRuntimeOptions) {
    this.#device = options.device;
    this.#evaluator = options.evaluator;
    this.#operations = options.operations;
    this.#store = options.store;
    this.#crypto = options.crypto;
    this.#clock = options.clock;
    this.#idSource = options.idSource;
    this.#location = options.location;
    this.#signingKey = options.signingKey;
    this.#queryExecutor = options.queryExecutor;
    this.#applyProjection = options.applyProjection;
    this.#syncScheduler = options.syncScheduler;

    // The emitter is constructed HERE, with its port bound to this runtime's emission channel —
    // it is not an injectable option. Task 09 owns the payload and the throttle ("decides WHETHER
    // to emit, never HOW"); this binding is the HOW. Injecting a pre-built emitter would let a
    // caller supply one whose port silently drops the op, turning the denial audit trail
    // (02 §7, FR-1045) off from the outside without changing a line of this file.
    this.#denialEmitter = new DenialEmitter(
      {
        emit: async (payload, context) => {
          await this.#emitSanctioned({
            type: PERMISSION_DENIED_OP_TYPE,
            entityType: PERMISSION_DENIAL_ENTITY_TYPE,
            entityId: this.#idSource(),
            payload: { ...payload },
            userId: context.userId,
            // §7: mirror the denied attempt's attribution — a denied agent attempt must be
            // visible AS one (ARCH-001 §9.3).
            source: asOpSource(context.source),
            agentInitiated: context.agentInitiated,
            agentConversationId: context.agentConversationId ?? null,
          });
        },
      },
      {
        now: () => this.#clock.now(),
        ...(options.denialThrottleWindowMs !== undefined
          ? { windowMs: options.denialThrottleWindowMs }
          : {}),
      },
    );

    this.#enforcement = new PermissionEnforcementPoint(this.#evaluator, this.#denialEmitter);
  }

  /** The denial emitter's throttle state — for diagnostics and for the suite's denominator (T-14). */
  get denialEmitter(): DenialEmitter {
    return this.#denialEmitter;
  }

  /**
   * THE enforcement point (02 §4), for the query runtime to share.
   *
   * Exposing it grants no authority: every method on it consults this runtime's real evaluator, so
   * a holder can only ask the question, never decide the answer. What it DOES do is guarantee the
   * query surface is checked by the same object as the command surface — same evaluator reference,
   * same §7 throttle memory (runtime/enforce.ts).
   */
  get enforcementPoint(): PermissionEnforcementPoint {
    return this.#enforcement;
  }

  /**
   * Build a `ctx` for the active user (04 §5.2).
   *
   * `userId` is the only per-context identity input — the device scope is fixed at construction
   * (see `DeviceIdentity`). `invocation` carries the 05 §2.1 attribution defaults unless the
   * caller is the agent (ARCH-001 §9.3).
   */
  createContext(userId: string, invocation?: Partial<InvocationMeta>): BrandedCommandContext {
    return this.#contextFor(userId, '(ad-hoc)', { ...defaultInvocation(), ...invocation });
  }

  #contextFor(userId: string, target: string, invocation: InvocationMeta): BrandedCommandContext {
    return createCommandContext(
      {
        identity: this.#identityFor(userId),
        newId: this.#idSource,
        resolveSchemaVersion: (type) => this.#resolveSchemaVersion(type),
        resolveScope: (type) => this.#resolveScope(type),
        requirePermission: (identity, permissionId, tgt, surface) =>
          this.#requirePermission(identity, permissionId, tgt, surface, invocation),
        queryExecutor: this.#queryExecutor,
        invocation,
        brand: this.#brand,
      },
      target,
    );
  }

  /**
   * The op type's declared `schemaVersion` (04 §3) — the operation registry's answer.
   *
   * FAILS CLOSED on an unregistered type, before anything is appended. An unregistered type has no
   * declared version AND no applier (both come from the same 04 §3 declaration), so an op of that
   * type would append, sync to every device, and be folded by nobody — a permanent silent hole in
   * every projection, discoverable only by noticing data that never appears. Guessing `1` here is
   * how that op gets written.
   */
  #resolveSchemaVersion(type: string): number {
    const version = this.#operations.schemaVersionFor(type);
    if (version === undefined) {
      throw new DomainError(
        'VALIDATION_FAILED',
        { opType: type, issue: 'op type not declared by any registered module' },
        `op type ${type} is not in the operation registry (04 §3) — declare it in the module's \`operations\` block, with its schemaVersion, reversal and applier. An op type with no applier folds into nothing on every device.`,
      );
    }
    return version;
  }

  /**
   * The op type's declared envelope scope (01 §6) — the same registry entry `#resolveSchemaVersion`
   * reads.
   *
   * FAILS CLOSED on an unregistered type for the same reason that one does, and the failure is
   * unreachable in practice precisely because it does: `ctx.op()` resolves the version first, so an
   * undeclared type has already thrown by the time scope is asked for. It is written as a throw
   * rather than a `?? 'store'` fallback anyway — defaulting the scope of a type nobody declared
   * would silently record a tenant-scoped op in a store (or the reverse), permanently, in a signed
   * append-only log.
   */
  #resolveScope(type: string): OperationScope {
    const scope = this.#operations.scopeFor(type);
    if (scope === undefined) {
      throw new DomainError(
        'VALIDATION_FAILED',
        { opType: type, issue: 'op type not declared by any registered module' },
        `op type ${type} is not in the operation registry (04 §3) — its envelope scope (01 §6) is undeclared.`,
      );
    }
    return scope;
  }

  #identityFor(userId: string): CommandIdentity {
    return {
      tenantId: this.#device.tenantId,
      storeId: this.#device.storeId,
      userId,
      deviceId: this.#device.deviceId,
    };
  }

  /**
   * Execute a command — the 04 §5.1 sequence. See the file header for the step list and for why
   * step 2 does not route through `ctx`.
   *
   * @throws {DomainError} `VALIDATION_FAILED` (step 1), `PERMISSION_DENIED` (step 2), or whatever
   *   the handler throws (04 §5.2: typed DomainError).
   */
  async execute<TInput, TResult>(
    command: CommandDefinition<TInput, TResult>,
    rawInput: unknown,
    ctx: CommandContext,
  ): Promise<CommandOutcome<TResult>> {
    // Step 0 — provenance. A ctx this runtime did not mint has an identity this runtime never
    // established, so there is nothing trustworthy to evaluate the permission against. Fail closed
    // (02 §5.2 step 7): deny, do not "probably fine" it. This is what stops a hand-rolled ctx from
    // walking a handler past step 2 with a borrowed userId.
    if (!isOwnContext(ctx, this.#brand)) {
      throw new DomainError(
        'PERMISSION_DENIED',
        { target: command.name, reason: 'evaluation_error' },
        'ctx was not created by this CommandRuntime (04 §5.2)',
      );
    }
    // BOTH recovered from the brand — never re-read off the ctx's own fields.
    //
    // `identity` decides what the permission is evaluated against and what every op is attributed
    // to; `invocation` decides how a denial op is attributed (02 §7). Same rule for both: an input
    // to an authorization decision comes from the binding THIS runtime minted, not from a property
    // of the object the call site handed back. `ctx.userId` is the §5.2 handler-facing copy of the
    // same value, and is deliberately not the source here.
    //
    // Neither is a discovered hole — the ctx is frozen and `createContext(userId)` takes the user
    // as an argument, so the trust boundary is "whoever holds the runtime instance names the
    // acting user" either way. It is that the decision path should not read a field a caller could
    // ever reach, so this stays correct if the freeze is lost or a field is added.
    const { identity, invocation } = ctx[CTX_RUNTIME_BRAND];

    // Step 1 — strict parse. An unknown key or a wrong type is VALIDATION_FAILED, and the handler
    // is never reached: nothing is appended and no projection moves.
    let input: TInput;
    try {
      input = command.input.parse(rawInput);
    } catch (cause) {
      throw new DomainError(
        'VALIDATION_FAILED',
        { command: command.name, issue: describeParseFailure(cause) },
        `input rejected by ${command.name}.input (04 §5.1 step 1)`,
      );
    }

    // Step 2 — THE control (02 §4). Unconditional, awaited, and ahead of the handler. There is no
    // flag, no fast path and no caller-supplied hook that can skip it: it is a direct call to this
    // runtime's own evaluator, and a denial throws before step 3 exists.
    await this.#requirePermission(
      identity,
      command.permission,
      command.name,
      'command',
      invocation,
    );

    // Step 3 — the handler. PURE (§5.2): its whole surface is the ctx built here.
    const handlerCtx = this.#contextFor(ctx.userId, command.name, invocation);
    const handlerResult = await command.handler(input, handlerCtx);

    // Steps 4–6 — completion + atomic append + projection.
    //
    // The `location` port is read EXACTLY ONCE per command, here, and never retried or polled: it
    // returns the best fix it already has or null, and null never blocks (04 §5.1, PRD-009
    // FR-802). The `timestamp` is stamped once for the whole command by `appendLocalOps` (04 §5.2
    // atomic stamp) — every draft of this command shares it.
    const location: Location | null = this.#location.getBestFix();
    const timestamp = this.#clock.now();

    const appendContext: AppendContext = {
      tenantId: identity.tenantId,
      storeId: identity.storeId,
      userId: identity.userId,
      deviceId: identity.deviceId,
      secretKey: this.#signingKey.getSigningKey(),
    };

    const { ops } = await appendLocalOps({
      store: this.#store,
      drafts: handlerResult.ops,
      context: appendContext,
      crypto: this.#crypto,
      newId: this.#idSource,
      // One stamp for the whole command (§5.2): a constant, not a clock read per draft.
      now: () => timestamp,
      location,
      applyProjection: this.#applyProjection,
    });

    // Step 7 — schedule sync (debounced; task 15 owns the loop). AFTER the transaction committed,
    // and never inside it: a locally durable op is already a successful command, and sync
    // scheduling must not be able to fail one. A throw here would roll back nothing (the
    // transaction is closed) but would report a failure to a caller whose write DID land.
    this.#syncScheduler.schedule();

    return { ops, result: handlerResult.result, timestamp };
  }

  /**
   * Append one of the five sanctioned runtime emissions (04 §5.1) — no command, no permission
   * check, by design (02 §4; see runtime-emissions.ts for why each of the five is exempt).
   *
   * @throws {RuntimeEmissionError} when `type` is not sanctioned — before anything is appended.
   */
  async emitRuntimeOp(draft: RuntimeEmissionDraft): Promise<readonly AppendedOp[]> {
    return this.#emitSanctioned(draft);
  }

  async #emitSanctioned(draft: RuntimeEmissionDraft): Promise<readonly AppendedOp[]> {
    // Deny by default, BEFORE any store work: a rejected type leaves the log untouched.
    assertSanctionedEmission(draft.type);

    const timestamp = this.#clock.now();
    const location = this.#location.getBestFix();
    const { ops } = await appendLocalOps({
      store: this.#store,
      drafts: [
        {
          type: draft.type,
          entityType: draft.entityType,
          entityId: draft.entityId,
          schemaVersion: draft.schemaVersion ?? 1,
          payload: draft.payload,
          source: draft.source ?? 'system',
          agentInitiated: draft.agentInitiated ?? false,
          agentConversationId: draft.agentConversationId ?? null,
        },
      ],
      context: {
        tenantId: this.#device.tenantId,
        storeId: this.#device.storeId,
        userId: draft.userId,
        deviceId: this.#device.deviceId,
        secretKey: this.#signingKey.getSigningKey(),
      },
      crypto: this.#crypto,
      newId: this.#idSource,
      now: () => timestamp,
      location,
      applyProjection: this.#applyProjection,
    });
    this.#syncScheduler.schedule();
    return ops;
  }

  /**
   * The single enforcement point (02 §4) — called by step 2 and by `ctx.requirePermission` alike.
   *
   * Delegates to `PermissionEnforcementPoint`, which is the ONE implementation and is shared with
   * the query runtime (runtime/enforce.ts explains why it is shared rather than duplicated). This
   * method stays as the runtime's internal entry point so step 2's call site reads as the §5.1
   * sequence it implements.
   */
  #requirePermission(
    identity: CommandIdentity,
    permissionId: string,
    target: string,
    surface: DenialSurface,
    invocation: InvocationMeta,
  ): Promise<void> {
    return this.#enforcement.requirePermission(identity, permissionId, target, surface, invocation);
  }
}

/** The 05 §2.1 `source` values. Local to the narrowing below; @bolusi/schemas owns the schema. */
const OP_SOURCES: readonly string[] = ['ui', 'agent', 'api', 'system'];

/**
 * Narrow task 09's `DenialEmissionContext.source` (typed `string`) to an `OpSource`.
 *
 * It is always a real `OpSource` in practice — the runtime supplies it from `InvocationMeta` — so
 * this is a boundary assertion, not a conversion. It falls back to `"system"` rather than
 * throwing: a malformed source must not be able to suppress a denial op (02 §7 — the denial log
 * must not be deniable), and an attribution of "system" is a visibly wrong answer rather than a
 * missing record.
 */
function asOpSource(source: string): OpSource {
  return (OP_SOURCES.includes(source) ? source : 'system') as OpSource;
}

/**
 * A compact, structured description of a parse failure for the `VALIDATION_FAILED` details.
 *
 * Zod's `ZodError` carries `issues`; anything else contributes its message. Deliberately does NOT
 * pass the raw error through: `details` is surfaced to logs/telemetry (03 §12), and a schema error
 * can quote the rejected input verbatim — which is how a mistyped PIN ends up in a log file.
 */
function describeParseFailure(cause: unknown): string {
  const issues =
    typeof cause === 'object' && cause !== null
      ? (cause as { issues?: unknown }).issues
      : undefined;
  if (Array.isArray(issues)) {
    return issues
      .map((issue: unknown) => {
        // `path` and `code` ONLY. Zod's `message` and `keys` can quote caller-supplied text (a
        // rejected value, an unrecognized key name); `path` is schema structure and `code` is a
        // fixed enum, so neither can carry data. This is the whole reason the issue is
        // reconstructed rather than passed through.
        const { path, code } = (issue ?? {}) as { path?: unknown; code?: unknown };
        const where = Array.isArray(path) && path.length > 0 ? path.join('.') : '(root)';
        return `${where}: ${String(code ?? 'invalid')}`;
      })
      .join('; ');
  }
  return cause instanceof Error ? cause.name : 'parse failed';
}
