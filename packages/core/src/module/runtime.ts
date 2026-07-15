// Wiring a build's modules into a running pair of runtimes (04-module-contract §1/§5/§6).
//
// WHY THIS FACTORY EXISTS RATHER THAN LETTING EACH CALLER COMPOSE. The command and query runtimes
// are mutually dependent, and the dependency is not symmetric:
//
//   CommandRuntime needs a QueryExecutorPort   — 04 §5.2: handlers read via `ctx.query`.
//   QueryRuntime   needs the enforcement point — 02 §4: ONE control, and the CommandRuntime owns
//                                                the op-emission channel the denial op rides on.
//
// Every consumer (the app, the harness, every test) would otherwise solve that knot the same way,
// and one of them would eventually solve it by giving the query runtime its OWN evaluator — which
// type-checks, passes its tests, and quietly creates a second enforcement point (runtime/enforce.ts
// explains what that costs). Composing it once here is CLAUDE.md §2.8 applied to wiring.
import { CommandRuntime, type CommandRuntimeOptions } from '../runtime/execute.js';
import type { CommandIdentity, QueryExecutorPort, QueryHandle } from '../runtime/ctx.js';
import { QueryRuntime } from '../query/execute.js';
import type { ProjectionDb } from '../projection/manifest.js';
import type { ModuleRegistry } from './registry.js';

/**
 * Everything `createModuleRuntime` needs beyond the modules: the CommandRuntime's ports, minus the
 * two things this factory derives from the module list (`operations`) or builds itself
 * (`queryExecutor`).
 */
export type ModuleRuntimeOptions = Omit<CommandRuntimeOptions, 'operations' | 'queryExecutor'>;

/** A wired build: the registries plus the two runtimes, sharing one enforcement point. */
export interface ModuleRuntime<DB> {
  readonly registry: ModuleRegistry<DB>;
  readonly commands: CommandRuntime;
  readonly queries: QueryRuntime<DB>;
}

/**
 * Wire the runtimes over an ALREADY-ASSEMBLED registry (04 §1).
 *
 * WHY IT TAKES A REGISTRY AND NOT A MODULE LIST. The permission evaluator (task 09) is constructed
 * FROM the assembled permission registry and is an input here — so the caller must assemble first
 * regardless. Taking the module list would mean assembling twice, and the second assembly's
 * registry (the one the runtime enforces against) would be a DIFFERENT object from the one the
 * evaluator resolves ids in. They would agree today, being pure functions of the same list, and
 * "these two registries agree" is not a property anything checks. Passing the registry makes them
 * the same object by construction.
 *
 * Assembly has therefore already thrown on any 02 §3.2 / 04 §1 defect by the time this runs: a
 * `ModuleRuntime` that exists is one whose modules all resolved.
 */
export function createModuleRuntime<DB>(
  registry: ModuleRegistry<DB>,
  db: ProjectionDb<DB>,
  options: ModuleRuntimeOptions,
): ModuleRuntime<DB> {
  // The knot, tied in one place. `queryRuntime` is assigned immediately below, and nothing can
  // execute a query in between: `createCommandContext` only ever calls this port from inside a
  // handler, which needs an `execute` call, which needs this function to have returned.
  //
  // The null check is not ceremony — it is what makes a future refactor that DOES manage to call
  // it early fail loudly instead of silently skipping the permission check. Fail closed: an
  // unwired query runtime denies, it does not pass through.
  let queryRuntime: QueryRuntime<DB> | null = null;
  const queryExecutor: QueryExecutorPort = {
    execute<TInput, TOutput>(
      query: QueryHandle<TInput, TOutput>,
      input: TInput,
      identity: CommandIdentity,
    ): Promise<TOutput> {
      if (queryRuntime === null) {
        throw new Error(
          'query runtime is not wired yet — a query ran before createModuleRuntime returned (04 §6)',
        );
      }
      return queryRuntime.execute(query, input, identity);
    },
  };

  const commands = new CommandRuntime({
    ...options,
    operations: registry.operations,
    queryExecutor,
  });

  queryRuntime = new QueryRuntime<DB>({ db, enforcement: commands.enforcementPoint });

  return { registry, commands, queries: queryRuntime };
}
