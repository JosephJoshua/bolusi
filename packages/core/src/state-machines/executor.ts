// The single shared state-machine executor (03-state-machines §1, §15). Every
// runtime-internal machine in 03-state-machines is encoded once as const data and
// transitions ONLY through this function; an invalid `(machine, from, event)` triple
// throws `DomainError('INVALID_TRANSITION', { machine, from, event })` — dev builds crash
// loudly, production logs and leaves the machine unchanged (the caller decides which).
//
// "Terminal" is expressed, not asserted: a terminal state simply has no outgoing entries,
// so every event on it is INVALID_TRANSITION. A self-loop (`to === from`) is a legal
// no-op — `changed: false` — never a transition with side effects (03 §3's idempotent
// `accepted`/`duplicate` on an already-`synced` op, and `local`+`chain_gap`).
import { DomainError } from '../errors/domain-error.js';

/**
 * A transition table: `transitions[from][event] = to`. A missing `from` row or `event` key
 * is an invalid transition. Encoding a table is the parity contract (03 §1) — a test
 * asserts each table equals its 03-state-machines section.
 */
export interface StateMachineDefinition<TState extends string, TEvent extends string> {
  /** Stable machine id — surfaced in `DomainError.details.machine`. */
  readonly id: string;
  /** Every state value. */
  readonly states: readonly TState[];
  /** Birth states (not transitions) — where entities enter the machine (03 §3). */
  readonly initial: readonly TState[];
  /** Terminal states — no outgoing transitions exist in the table. */
  readonly terminal: readonly TState[];
  /** The transition table. */
  readonly transitions: Readonly<Record<TState, Readonly<Partial<Record<TEvent, TState>>>>>;
}

export interface TransitionResult<TState extends string> {
  /** The resulting state. */
  readonly to: TState;
  /**
   * `false` when `to === from` — a self-loop / idempotent no-op that must NOT re-apply
   * side effects (03 §3). `true` for a real transition.
   */
  readonly changed: boolean;
}

/**
 * Resolve one transition, or throw `INVALID_TRANSITION`.
 *
 * @throws {DomainError} code `INVALID_TRANSITION`, details `{ machine, from, event }`.
 */
export function runTransition<TState extends string, TEvent extends string>(
  machine: StateMachineDefinition<TState, TEvent>,
  from: TState,
  event: TEvent,
): TransitionResult<TState> {
  const to = machine.transitions[from]?.[event];
  if (to === undefined) {
    throw new DomainError('INVALID_TRANSITION', { machine: machine.id, from, event });
  }
  return { to, changed: to !== from };
}
