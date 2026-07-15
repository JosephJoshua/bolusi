// The query runtime (04-module-contract §6) — typed reads, permission-checked identically to
// commands (02 §4), with data-gating inside the handler (02 §9, FR-1029).
//
// This is the real implementation behind the `QueryExecutorPort` seam task 10 declared. Task 10's
// note on that seam is the whole design brief: "queries are permission-checked identically to
// commands (02 §4), and that check is the EXECUTOR's job — routing a read through a seam does not
// authorize it."
//
// THE SEQUENCE, mirroring 04 §5.1 for reads:
//   1. input = query.input.parse(rawInput)         strict → VALIDATION_FAILED
//   2. requirePermission(query.permission)         fail closed → PERMISSION_DENIED + denial op
//                                                  (surface: 'query', target: the query name)
//   3. rows = query.handler(input, qctx)           gating happens HERE (02 §9), not in the UI
//
// WHY A DENIAL IS AN ERROR AND NEVER `{ rows: [] }`. FR-1036 / security-guide §2.2: an empty page
// leaks "the store exists and is quiet", and — worse — it is indistinguishable from the legitimate
// empty page (02 §9's own table lists both outcomes, and they must not collide). The check runs at
// the shared enforcement point, which throws; there is no code path here that converts a denial
// into a result.
//
// WHY THIS IS NOT ALSO THE GATING LAYER. It cannot be: which COLUMNS a caller may see is a fact
// about the module's rows, known only to the module (02 §9.1 — "the handler consults
// `qctx.hasPermission(...)` and shapes the row"). What this file owns is making the primitive
// available and making the entry check unskippable. Column gating that lived here would have to
// post-process rows the handler already built — i.e. fetch-then-hide, which is the exact thing
// §9.2 forbids ("a gated field is ABSENT from the row object — never null, never masked").
import type { Kysely } from 'kysely';

import { DomainError } from '../errors/domain-error.js';
import type {
  CommandIdentity,
  InvocationMeta,
  QueryExecutorPort,
  QueryHandle,
} from '../runtime/ctx.js';
import { defaultInvocation } from '../runtime/ctx.js';
import type { PermissionEnforcementPoint } from '../runtime/enforce.js';
import { readOnlyDb, type QueryContext } from './qctx.js';

/**
 * A query as the runtime sees it: task 10's `QueryHandle` (permission + input + inference carrier)
 * plus the two things executing one actually needs — its NAME, for the denial op's `target` (02 §7),
 * and a handler typed against `qctx`.
 */
export interface ExecutableQuery<TInput, TOutput, DB> extends QueryHandle<TInput, TOutput> {
  /** The manifest key (04 §6: `queries: { listNotes: {...} }`). `defineModule` fills it in. */
  readonly name: string;
  readonly handler: (input: TInput, qctx: QueryContext<DB>) => TOutput | Promise<TOutput>;
}

export interface QueryRuntimeOptions<DB> {
  /**
   * The projection handle (04 §2). Wrapped read-only per query — the runtime holds the writable
   * handle so that appliers (which legitimately write) keep theirs, and hands handlers a guarded
   * view they cannot unwrap.
   */
  readonly db: Kysely<DB>;
  /** THE control (02 §4), shared with the command runtime. See runtime/enforce.ts. */
  readonly enforcement: PermissionEnforcementPoint;
}

/**
 * The query runtime — one per device, alongside one `CommandRuntime`.
 *
 * Implements `QueryExecutorPort`, so `ctx.query(...)` inside a command handler (04 §5.2: "reads
 * only via ctx.query — the same query layer the UI uses") routes here and is permission-checked
 * exactly as a UI read is. That is the property that makes the V2 agent safe by construction
 * (FR-1028): it calls queries directly and never sees a button, and this is the layer that stops
 * it.
 */
export class QueryRuntime<DB> implements QueryExecutorPort {
  readonly #db: Kysely<DB>;
  readonly #enforcement: PermissionEnforcementPoint;

  constructor(options: QueryRuntimeOptions<DB>) {
    this.#db = options.db;
    this.#enforcement = options.enforcement;
  }

  /**
   * Execute a query (04 §6).
   *
   * @throws {DomainError} `VALIDATION_FAILED` (step 1, incl. a malformed cursor and `limit > 100`),
   *   `PERMISSION_DENIED` (step 2 — never an empty result), or whatever the handler throws.
   */
  async execute<TInput, TOutput>(
    query: QueryHandle<TInput, TOutput>,
    rawInput: TInput,
    identity: CommandIdentity,
    invocation: InvocationMeta = defaultInvocation(),
  ): Promise<TOutput> {
    const executable = query as ExecutableQuery<TInput, TOutput, DB>;
    // A query reaching the runtime without a name is a `defineModule` bug, not a caller error — but
    // it would silently produce a denial op whose `target` is `undefined`, i.e. an audit record
    // that cannot say what was attempted (02 §7). Name it loudly instead.
    const target = executable.name;
    if (typeof target !== 'string' || target.length === 0) {
      throw new DomainError(
        'VALIDATION_FAILED',
        { issue: 'query has no name' },
        'query has no name — defineModule fills it from the manifest key (04 §6); a denial op needs it for `target` (02 §7)',
      );
    }

    // Step 1 — strict parse. Rejects unknown keys, `limit > 100` (the schema's `.max(100)`,
    // 04 §6), and anything else the module declared. The handler is never reached.
    let input: TInput;
    try {
      input = executable.input.parse(rawInput);
    } catch (cause) {
      // A cursor the module's schema already rejected as a typed DomainError (query/cursor.ts
      // decodes inside handlers, but a module may also validate in its schema) must not be
      // re-wrapped into a less specific error.
      if (cause instanceof DomainError) throw cause;
      throw new DomainError(
        'VALIDATION_FAILED',
        { query: target, issue: describeParseFailure(cause) },
        `input rejected by ${target}.input (04 §6)`,
      );
    }

    // Step 2 — THE control (02 §4). Awaited, unconditional, ahead of the handler. A denial throws
    // and emits the denial op with `surface: 'query'` and `target` = this query's name (02 §7).
    await this.#enforcement.requirePermission(
      identity,
      executable.permission,
      target,
      'query',
      invocation,
    );

    // Step 3 — the handler, with the §6 qctx and nothing else.
    return executable.handler(input, this.#contextFor(identity));
  }

  /** Build the §6 `qctx` — exactly `{ db, tenantId, storeId, userId, hasPermission }`. */
  #contextFor(identity: CommandIdentity): QueryContext<DB> {
    // FROZEN, like `ctx` (runtime/ctx.ts): a minted context is a statement of who is asking, and a
    // handler that reassigned `qctx.userId` and saw its gating still evaluated for the real user
    // would be a confusing bug report. In strict mode the assignment throws at the mistake instead.
    return Object.freeze({
      db: readOnlyDb(this.#db),
      tenantId: identity.tenantId,
      storeId: identity.storeId,
      userId: identity.userId,
      // Bound to the identity the RUNTIME established, never re-read off the qctx's own fields —
      // same rule as `execute`'s use of the ctx brand. A handler cannot ask "may SOMEBODY ELSE see
      // this?"; it can only ask about the caller.
      hasPermission: (permissionId: string): boolean =>
        this.#enforcement.hasPermission(identity, permissionId),
    });
  }
}

/**
 * A compact, structured description of a parse failure (mirrors runtime/execute.ts).
 *
 * `path` and `code` ONLY. Zod's `message`/`keys` can quote caller-supplied text, and `details` is
 * surfaced to logs (03 §12) — this is how a rejected value ends up in a log file.
 */
function describeParseFailure(cause: unknown): string {
  const issues =
    typeof cause === 'object' && cause !== null
      ? (cause as { issues?: unknown }).issues
      : undefined;
  if (Array.isArray(issues)) {
    return issues
      .map((issue: unknown) => {
        const { path, code } = (issue ?? {}) as { path?: unknown; code?: unknown };
        const where = Array.isArray(path) && path.length > 0 ? path.join('.') : '(root)';
        return `${where}: ${String(code ?? 'invalid')}`;
      })
      .join('; ');
  }
  return cause instanceof Error ? cause.name : 'parse failed';
}
