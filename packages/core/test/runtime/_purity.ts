// The handler purity harness (04-module-contract §5.2): poison every ambient effect a handler
// could reach, for the duration of a call, then restore.
//
// HOME. Testing-guide §3.3 puts the shared determinism kit (PRNG, FakeClock, IdSource) in
// `@bolusi/test-support`, and task 26 owns consolidating it there. This wrapper lives in
// @bolusi/core's test tree for now because task 10's scope is the runtime, and because
// test-support's sibling subtrees are being edited by other tasks concurrently. It is a
// CANDIDATE FOR CONSOLIDATION into `@bolusi/test-support/determinism` alongside FakeClock —
// tasks 14 and 26 need exactly this to prove their own handlers pure. Move it, do not copy it
// (CLAUDE.md §2.8).
//
// RESTORATION IS THE HARD PART. These are process-wide globals: a poison that leaks past its
// call breaks every later test in the worker, including ones that have nothing to do with this
// file. Hence the `finally`, hence restoring the ORIGINAL descriptors rather than assigning
// plausible replacements, and hence purity.test.ts asserting restoration after a throwing body.

/** The ambient effects a pure handler must never reach (04 §5.2). The guard's denominator. */
export type PoisonedGlobal =
  | 'Date.now'
  | 'new Date'
  | 'Math.random'
  | 'fetch'
  | 'setTimeout'
  | 'setInterval'
  | 'performance.now';

/** Thrown when a handler reaches an ambient effect. Names the global, so the failure is legible. */
export class PurityViolationError extends Error {
  override readonly name = 'PurityViolationError';
  readonly effect: PoisonedGlobal;

  constructor(effect: PoisonedGlobal) {
    super(
      `handler reached ${effect} — handlers are pure and get no clock, no rng and no network (04-module-contract §5.2). The runtime stamps timestamp once per command; ids come from ctx.newId().`,
    );
    this.effect = effect;
  }
}

const violate = (effect: PoisonedGlobal): never => {
  throw new PurityViolationError(effect);
};

/**
 * Run `body` with the ambient clock, rng, network and timers poisoned; restore them afterwards
 * whether it returns, throws, or rejects.
 *
 * Sync and async bodies are both supported: an async body's poison holds until its promise
 * settles. That is deliberately wider than "the handler call" — the whole `execute` runs under it
 * — which is what lets `purity.test.ts` also prove the RUNTIME never reaches a global for its own
 * timestamp stamp.
 */
export function poisonAmbientEffects<T>(body: () => T): T {
  const original = {
    Date: globalThis.Date,
    random: Math.random,
    fetch: globalThis.fetch,
    setTimeout: globalThis.setTimeout,
    setInterval: globalThis.setInterval,
    performanceNow: globalThis.performance.now,
  };

  // `new Date()` and `Date.now()` are distinct reads of the clock and must BOTH be blocked: a
  // handler doing `new Date().getTime()` never touches `Date.now`.
  //
  // A Proxy rather than a subclass: `ConstructorParameters<typeof Date>` resolves to the LAST
  // overload (`[value]`), so a subclass constructor cannot even express the zero-argument call
  // that is the one being blocked — TS rejects `args.length === 0` as impossible. The Proxy sees
  // the real argument list, and leaves `new Date(ms)` (a pure conversion, no clock read) working.
  const PoisonedDate = new Proxy(original.Date, {
    construct(target, args: unknown[]) {
      if (args.length === 0) violate('new Date');
      return Reflect.construct(target, args) as object;
    },
    get(target, property, receiver) {
      if (property === 'now') return () => violate('Date.now');
      return Reflect.get(target, property, receiver) as unknown;
    },
  });

  const restore = (): void => {
    globalThis.Date = original.Date;
    Math.random = original.random;
    globalThis.fetch = original.fetch;
    globalThis.setTimeout = original.setTimeout;
    globalThis.setInterval = original.setInterval;
    globalThis.performance.now = original.performanceNow;
  };

  globalThis.Date = PoisonedDate;
  Math.random = () => violate('Math.random');
  globalThis.fetch = (() => violate('fetch')) as typeof globalThis.fetch;
  globalThis.setTimeout = (() => violate('setTimeout')) as unknown as typeof globalThis.setTimeout;
  globalThis.setInterval = (() =>
    violate('setInterval')) as unknown as typeof globalThis.setInterval;
  globalThis.performance.now = () => violate('performance.now');

  let settled = false;
  try {
    const result = body();
    if (isPromiseLike(result)) {
      settled = true;
      // Hold the poison until the async body settles, then restore exactly once.
      return (result as PromiseLike<unknown>).then(
        (value) => {
          restore();
          return value;
        },
        (error: unknown) => {
          restore();
          throw error;
        },
      ) as T;
    }
    return result;
  } finally {
    // A promise-returning body restores in its own continuation above; anything else restores here
    // — including a synchronous throw, which is what keeps a failed assertion from poisoning the
    // rest of the worker.
    if (!settled) restore();
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as PromiseLike<unknown>).then === 'function'
  );
}
