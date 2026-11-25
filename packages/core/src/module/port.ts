// A module's commands and queries bound to one signed-in user, by name and fully typed.
//
// Screens and other clients (mobile, desktop) call `port.query('listTickets', …)` and
// `port.run('openTicket', …)` instead of each app hand-writing one wrapper per command. The types
// come from the module definition itself, so a renamed command or a changed input is a compile
// error at every caller. Permission checks stay where they are: in the runtimes this delegates to.
import type { z } from 'zod';

import type { PermissionAllowance } from '../authz/limits.js';
import type { CommandIdentity, InputParser, QueryHandle } from '../runtime/ctx.js';
import type {
  CommandDefinition,
  CommandHandlerResult,
  CommandOutcome,
} from '../runtime/execute.js';
import { refusalKeyOf } from './op-rules.js';
import type { ModuleRuntime } from './runtime.js';

/** The commands and queries of a defined module, as `defineModule` returns them. */
export interface ModuleOperations {
  readonly commands: object;
  readonly queries: object;
}

/** What a caller passes: a zod schema's input type (defaults optional), else the parsed type. */
type CallerInput<D> = D extends { readonly input: infer P }
  ? P extends z.ZodType
    ? z.input<P>
    : P extends InputParser<infer T>
      ? T
      : never
  : never;

type QueryOutput<Q> = Q extends { readonly handler: (...args: never[]) => infer O }
  ? Awaited<O>
  : never;

type CommandResult<C> = C extends { readonly handler: (...args: never[]) => infer R }
  ? Awaited<R> extends CommandHandlerResult<infer T>
    ? T
    : never
  : never;

export type QueryName<M extends ModuleOperations> = keyof M['queries'] & string;
export type CommandName<M extends ModuleOperations> = keyof M['commands'] & string;

export interface ModulePort<M extends ModuleOperations> {
  /** The signed-in user every call runs as. */
  readonly userId: string;
  /** Run a query (04 §6). A denied read throws `PERMISSION_DENIED`, never returns empty. */
  query<K extends QueryName<M>>(
    name: K,
    input: CallerInput<M['queries'][K]>,
  ): Promise<QueryOutput<M['queries'][K]>>;
  /** Run a command (04 §5): append locally and project, then resolve the handler's result. */
  run<K extends CommandName<M>>(
    name: K,
    input: CallerInput<M['commands'][K]>,
  ): Promise<CommandResult<M['commands'][K]>>;
  /** Whether the user holds a permission; for showing actions, not for enforcing them. */
  hasPermission(permissionId: string): boolean;
  /**
   * Whether a colleague holds a permission in this store, for pickers such as "assign to a
   * technician". Same evaluator and scope as `hasPermission`, only for another user.
   */
  colleagueHasPermission(userId: string, permissionId: string): boolean;
  /**
   * The most the user may use a limited permission for, in rupiah per servisan (a discount, a
   * refund, a phone handed over unpaid): null when nothing limits them, 0 when they do not hold it.
   * For showing what is within reach; the op's rule decides on save.
   */
  limitOf(permissionId: string): number | null;
  /**
   * A fresh id from the runtime's id source. A form takes one up front for the record it will
   * create and keeps it in its draft, so a draft restored after the app died mid-submit cannot
   * create that record twice.
   */
  newId(): string;
}

export function bindModulePort<M extends ModuleOperations, DB>(
  module: M,
  runtime: ModuleRuntime<DB>,
  identity: CommandIdentity,
): ModulePort<M> {
  const ctx = runtime.commands.createContext(identity.userId);
  const queries = module.queries as Readonly<Record<string, QueryHandle<unknown, unknown>>>;
  const commands = module.commands as Readonly<Record<string, CommandDefinition<unknown, unknown>>>;
  return {
    userId: identity.userId,
    query: (name, input) =>
      runtime.queries.execute(queries[name]!, input, identity) as Promise<never>,
    run: async (name, input) => {
      const execute = (): Promise<CommandOutcome<unknown>> =>
        runtime.commands.execute(commands[name]!, input, ctx);
      const outcome = await retryAfterDecision(execute, () => {
        const ask = runtime.askDecision?.() ?? null;
        return ask === null ? Promise.resolve(false) : ask(identity.userId);
      });
      // A screen awaits the result to navigate (the new ticket's id); a handler that returned none
      // is a module bug, surfaced here rather than as `undefined` deep in a screen.
      if (outcome.result === undefined) {
        throw new Error(`command ${name} returned no result (04 §5.1); a handler must return one`);
      }
      return outcome.result as never;
    },
    hasPermission: (permissionId) =>
      runtime.commands.enforcementPoint.hasPermission(identity, permissionId),
    colleagueHasPermission: (userId, permissionId) =>
      runtime.commands.enforcementPoint.hasPermission({ ...identity, userId }, permissionId),
    limitOf: (permissionId) =>
      limitOfAllowance(runtime.commands.enforcementPoint.allowance(identity, permissionId)),
    newId: () => ctx.newId(),
  };
}

/** The refusal of a decision made on a shared device without the approval PIN (core runtime.ts). */
export const DECISION_NEEDS_PIN = 'platform.refusal.decisionNeedsPin';

/**
 * Run `attempt`; when it is refused for want of the approval PIN, `ask` for it, and run once more if
 * a decision session opened. Every app runs its commands through this, so no screen has to remember
 * to ask. A second refusal reaches the caller.
 */
export async function retryAfterDecision<T>(
  attempt: () => Promise<T>,
  ask: () => Promise<boolean>,
): Promise<T> {
  try {
    return await attempt();
  } catch (error) {
    if (refusalKeyOf(error) !== DECISION_NEEDS_PIN || !(await ask())) throw error;
    return attempt();
  }
}

/** `ModulePort.limitOf` from an allowance: 0 when not held, null when not limited. */
export function limitOfAllowance(allowance: PermissionAllowance): number | null {
  return allowance.allowed ? allowance.limit : 0;
}
