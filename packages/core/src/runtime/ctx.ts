// The command context (04-module-contract §5.2) — the ENTIRE surface a handler may touch.
//
// §5.2 lists it exhaustively: `tenantId, storeId, userId, deviceId`, `op()`, `newId()`,
// `requirePermission()`, `query()`. This file builds exactly that and nothing more, and the suite
// pins the key set — because the interesting property of `ctx` is what is ABSENT from it:
//
//   NO clock      — the runtime stamps `timestamp` once per command (§5.2). A handler that could
//                   read a clock could stamp two ops in one command with different times.
//   NO db handle  — reads go through `query()` only (§5.2), the same query layer the UI uses. A
//                   handler holding a Kysely instance could write behind the op log's back, and
//                   the op log is the only write path (§5.1).
//   NO execute    — a handler cannot invoke another command. Nested commands would make the
//                   permission check, the timestamp stamp, and the transaction boundary all
//                   re-entrant, and "one command = one atomic stamp" would stop being true.
//   NO network    — no transport, no fetch. Handler output is op drafts + an optional result.
//
// These absences are the whole of §5.2's purity rule, and they are enforced three ways: this type
// (compile time), `bolusi/no-clock-in-handlers` (lint), and the purity-guard suite that poisons
// the globals for the duration of handler invocation (runtime). None of the three is sufficient
// alone — a cast defeats the type, a dynamic access defeats the lint, and lint cannot see a
// transitive import.
import type { OpSource } from '@bolusi/schemas';

import type { DenialSurface } from '../authz/denials.js';
import type { OpDraft } from '../oplog/draft.js';
import type { IdSource } from './ports.js';

/**
 * Who is acting, and in which scope (05 §2.1 attribution fields).
 *
 * **v0 rule (02-permissions §5.2, normative):** `storeId` is the enrolled device's store, always.
 * The runtime evaluates permissions in this scope AND stamps it onto every op it appends, so an
 * op's recorded scope always equals the scope it was authorized in. The FR-1034 store switcher is
 * v1 — until then these cannot drift apart, because there is one field feeding both.
 */
export interface CommandIdentity {
  readonly tenantId: string;
  /** Null = a tenant-scoped op (05 §2.1), e.g. `platform.user_locale_changed`. */
  readonly storeId: string | null;
  /** The acting human. Never null, never a shared account (05 §2.1). */
  readonly userId: string;
  /** The originating enrolled device (05 §2.1). */
  readonly deviceId: string;
}

/** A strict parser for a command/query input — structurally satisfied by a Zod schema's `.parse`.
 *
 * Declared structurally rather than as `z.ZodType` because @bolusi/core may not import zod (08
 * §3.3: core imports `schemas` + canonicalize + kysely types, nothing else). Modules own their
 * input schemas and pass them in; the runtime only needs "something that parses or throws".
 */
export interface InputParser<TInput> {
  /** @throws whatever the schema throws — the runtime maps it to `VALIDATION_FAILED` (04 §5.1). */
  parse(raw: unknown): TInput;
}

/**
 * The handler-visible shape of a query (04 §6). Task 11 lands `defineModule` and the real query
 * runtime; this is the slice `ctx.query()` needs — the permission it requires plus the types that
 * make the call site typed. Task 11's full query definition satisfies it structurally.
 */
export interface QueryHandle<TInput, TOutput> {
  readonly permission: string;
  readonly input: InputParser<TInput>;
  /** Carries `TOutput` for inference; the runtime never calls it — the executor does. */
  readonly handler: (...args: never[]) => TOutput | Promise<TOutput>;
}

/**
 * The injected query runtime (04 §6). Task 11 owns the real one — queries are permission-checked
 * identically to commands (02 §4), and that check is the EXECUTOR's job, not this file's: routing
 * a read through a seam does not authorize it.
 */
export interface QueryExecutorPort {
  execute<TInput, TOutput>(
    query: QueryHandle<TInput, TOutput>,
    input: TInput,
    identity: CommandIdentity,
  ): Promise<TOutput>;
}

/**
 * Invocation-level attribution (05 §2.1 `source` / `agentInitiated` / `agentConversationId`).
 *
 * WHY THIS IS A PROPERTY OF THE INVOCATION AND NOT OF A DRAFT. "Was this the UI or the agent?" is
 * known at the CALL, not inside the handler — and it must be answerable when the handler never
 * runs at all: 02 §7 requires a denial op to MIRROR the denied attempt's `source`/`agentInitiated`
 * so that a denied agent attempt is visible AS one (ARCH-001 §9.3). A draft-level-only field could
 * not do that, because a denied command produces no drafts.
 *
 * Defaults are the 05 §2.1 defaults, applied once here (`defaultInvocation`) rather than at each
 * call site.
 */
export interface InvocationMeta {
  /** Default `"ui"`. */
  readonly source: OpSource;
  /** Default `false` (ARCH-001 §9.3 — present from day one). */
  readonly agentInitiated: boolean;
  /** Default `null`. */
  readonly agentConversationId: string | null;
}

/** The 05 §2.1 defaults. One definition; `createContext` applies it when a caller omits meta. */
export function defaultInvocation(): InvocationMeta {
  return { source: 'ui', agentInitiated: false, agentConversationId: null };
}

/** What `ctx.op()` accepts — the parts of an op a handler controls (04 §5.1). */
export interface OpDraftInput {
  readonly type: string;
  readonly entityType: string;
  readonly entityId: string;
  /**
   * Defaults to `1`.
   *
   * **LOCAL STOPGAP — task 11.** 04 §3's operation registry declares the current `schemaVersion`
   * per op type, and once `defineModule` lands (task 11) the runtime resolves it FROM that
   * registry and this default must be DELETED, not kept alongside as a second answer to the same
   * question (CLAUDE.md §2.8). Until then `1` matches both the 04 §5 example (which omits the
   * field entirely) and the fact that v0 has shipped no v2 payload.
   */
  readonly schemaVersion?: number;
  readonly payload: Record<string, unknown>;
  /** Overrides the invocation's `source` (05 §2.1). Omit to inherit it. */
  readonly source?: OpSource;
  /** Overrides the invocation's `agentInitiated` (05 §2.1; ARCH-001 §9.3). Omit to inherit it. */
  readonly agentInitiated?: boolean;
  /** Overrides the invocation's `agentConversationId` (05 §2.1). Omit to inherit it. */
  readonly agentConversationId?: string | null;
}

/**
 * `ctx` (04 §5.2). The complete handler surface — see the file header for what is deliberately
 * absent and why.
 */
export interface CommandContext extends CommandIdentity {
  /**
   * Build an op draft (04 §5). PURE: it mints a draft object and nothing else — it does not
   * append, does not stamp a timestamp, and does not touch the store. The handler returns its
   * drafts; the runtime completes and appends them (§5.1 steps 4–6).
   */
  op(draft: OpDraftInput): OpDraft;
  /** A fresh UUIDv7 from the injected IdSource (05 §2.1; T-6). */
  newId(): string;
  /**
   * An ADDITIONAL permission check, beyond the command's declared one (04 §5.2).
   *
   * This is not the enforcement point. `execute` checks `command.permission` itself, through its
   * own evaluator reference, BEFORE the handler runs (04 §5.1 step 2) — a handler cannot reach
   * this method without having already passed that check, and a `ctx` whose `requirePermission`
   * was replaced cannot weaken it. Use this for a handler that needs a second, input-dependent
   * permission (e.g. a privileged target).
   *
   * @throws {DomainError} `PERMISSION_DENIED` — and emits the denial op, exactly as step 2 does.
   */
  requirePermission(permissionId: string): Promise<void>;
  /**
   * Read through the query layer (04 §5.2) — the same layer the UI uses. The only read seam a
   * handler has.
   */
  query<TInput, TOutput>(query: QueryHandle<TInput, TOutput>, input: TInput): Promise<TOutput>;
}

/**
 * The brand tying a `ctx` to the runtime that minted it.
 *
 * WHY. `execute(command, rawInput, ctx)` (04 §5.1) takes `ctx` as an ARGUMENT, so a caller can
 * hand it any object of the right shape — including one whose `requirePermission` is a no-op and
 * whose `userId` is someone else's. Step 2 not trusting `ctx.requirePermission` closes the first
 * half of that (the runtime calls its own evaluator); this brand closes the second: a `ctx` this
 * runtime did not mint is refused outright, so the identity the permission is evaluated against
 * is always an identity the runtime itself established. Fail closed (02 §5.2 step 7) means an
 * unrecognized ctx is an error, never a "probably fine".
 *
 * WHAT MAKES IT UNFORGEABLE — read this before simplifying `isOwnContext`.
 *
 * NOT the symbol's obscurity. The protection is OBJECT IDENTITY: `isOwnContext` compares
 * `binding.runtime === brand` against the minting runtime's `#brand`, a genuine `#private` field
 * that never leaves the instance. Possessing this symbol — or reading the binding off a real ctx —
 * buys an attacker nothing, because they still cannot produce that object. The suite drives
 * exactly that case (a caller holding the symbol, branding with their own object → refused).
 *
 * So a presence check (`CTX_RUNTIME_BRAND in ctx`) would be a REAL HOLE, not a shortcut: anyone
 * who can name the symbol could then stamp any object and walk a forged identity past step 2.
 * The `===` is the control; keep it.
 *
 * This symbol is additionally kept OFF the package's public surface (`runtime/index.ts` does not
 * re-export it) as defence in depth — narrower surface, fewer people relying on internals. That is
 * a second lock, not the first one, and `ctx-brand.test.ts` asserts BOTH: the export is absent AND
 * the symbol alone cannot forge a ctx. An earlier version of this comment claimed the non-export
 * was what made forgery impossible — while the symbol was in fact exported. Both halves are now
 * pinned by tests, because a security comment nobody can run is a claim, not a control.
 */
export const CTX_RUNTIME_BRAND = Symbol('bolusi.commandContext.runtime');

/**
 * What the brand carries: the minting runtime's identity, plus the invocation attribution the
 * runtime must recover from a ctx handed back to `execute` (02 §7 — the denial op mirrors it).
 *
 * It rides a SYMBOL key rather than a normal property so it stays off the §5.2 handler surface:
 * `Object.keys(ctx)` returns exactly the eight documented members, which is what lets the suite
 * pin that surface without special-casing runtime plumbing.
 */
export interface CommandContextBinding {
  /** The minting `CommandRuntime`'s brand object. */
  readonly runtime: object;
  /**
   * The identity this ctx was MINTED with — the one `execute` evaluates the permission against
   * and stamps onto every op.
   *
   * It rides the binding rather than being re-read from `ctx.userId` for the same reason
   * `invocation` does: both feed an authorization decision, so both come from what this runtime
   * established, not from a property the call site can restate. `ctx.userId` remains as the §5.2
   * handler-facing field and is the same value — but it is the COPY, not the source.
   *
   * This is belt-and-braces, not a discovered hole: `createContext(userId)` takes the acting user
   * as an argument, so the trust boundary is already "whoever holds the runtime instance names the
   * user". The point is that the decision path should not depend on a mutable field at all, so
   * that neither a future refactor nor a frozen-ness regression can turn a copy into an authority.
   */
  readonly identity: CommandIdentity;
  readonly invocation: InvocationMeta;
}

/** The runtime internals a `ctx` is bound to. Internal — never part of the handler surface. */
export interface CommandContextInternals {
  readonly identity: CommandIdentity;
  readonly newId: IdSource;
  /** The runtime's own check — the SAME function `execute` step 2 calls. One implementation. */
  readonly requirePermission: (
    identity: CommandIdentity,
    permissionId: string,
    target: string,
    surface: DenialSurface,
  ) => Promise<void>;
  readonly queryExecutor: QueryExecutorPort;
  /** Attribution for every op this invocation produces, and for its denial op (02 §7). */
  readonly invocation: InvocationMeta;
  /** Identifies the minting runtime (see `CTX_RUNTIME_BRAND`). */
  readonly brand: object;
}

/** A branded ctx, as seen by `execute`. */
export interface BrandedCommandContext extends CommandContext {
  readonly [CTX_RUNTIME_BRAND]: CommandContextBinding;
}

/** True when `ctx` was minted by the runtime identified by `brand`. */
export function isOwnContext(ctx: CommandContext, brand: object): ctx is BrandedCommandContext {
  const binding = (ctx as Partial<BrandedCommandContext>)[CTX_RUNTIME_BRAND];
  return typeof binding === 'object' && binding !== null && binding.runtime === brand;
}

/**
 * Build a `ctx` (04 §5.2). The handler-facing surface is exactly the §5.2 list; the brand is a
 * symbol key, invisible to `Object.keys`, so the suite's key-set pin reads the real surface.
 *
 * `target` names the command/query this ctx is executing, for the denial op's `target` field
 * (02 §7). It is set by `execute`; a ctx built for ad-hoc use carries the caller's label.
 */
export function createCommandContext(
  internals: CommandContextInternals,
  target: string,
): BrandedCommandContext {
  const { identity, invocation } = internals;

  // FROZEN (and the identity is captured in the binding above, not read back off these fields).
  //
  // A minted ctx is a statement of who is acting; nothing downstream should be able to edit it
  // after the fact. Freezing does not close a hole — `execute` decides from the binding, so
  // `ctx.userId = 'VICTIM'` was already inert — it closes the gap between what the object PERMITS
  // and what its comments IMPLY. A handler that silently mutated `ctx.userId` and saw its ops
  // still attributed correctly would be a confusing bug report; in strict mode (every file here is
  // an ES module) the assignment now throws at the point of the mistake instead.
  return Object.freeze({
    tenantId: identity.tenantId,
    storeId: identity.storeId,
    userId: identity.userId,
    deviceId: identity.deviceId,

    op(draft: OpDraftInput): OpDraft {
      return {
        type: draft.type,
        entityType: draft.entityType,
        entityId: draft.entityId,
        schemaVersion: draft.schemaVersion ?? 1,
        payload: draft.payload,
        // Attribution INHERITS from the invocation (05 §2.1; ARCH-001 §9.3) unless the handler
        // overrides it: an agent-initiated command's ops must be visible AS agent-initiated
        // without every handler remembering to say so. `invocation` already carries the §2.1
        // defaults (`defaultInvocation`), so these are always explicitly present — the
        // absent-vs-null rule (05 §3) is satisfied here rather than relying on the completion
        // layer's fallback.
        source: draft.source ?? invocation.source,
        agentInitiated: draft.agentInitiated ?? invocation.agentInitiated,
        agentConversationId: draft.agentConversationId ?? invocation.agentConversationId,
      };
    },

    newId: internals.newId,

    requirePermission(permissionId: string): Promise<void> {
      return internals.requirePermission(identity, permissionId, target, 'command');
    },

    query<TInput, TOutput>(query: QueryHandle<TInput, TOutput>, input: TInput): Promise<TOutput> {
      return internals.queryExecutor.execute(query, input, identity);
    },

    [CTX_RUNTIME_BRAND]: { runtime: internals.brand, identity, invocation },
  });
}
