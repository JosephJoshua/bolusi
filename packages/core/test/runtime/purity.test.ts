// The handler purity guard (04-module-contract §5.2; CLAUDE.md §2.5 — adversarial tests ship WITH
// the surface, not after review).
//
// §5.2 gives handlers no clock, no rng, no network: the runtime stamps `timestamp` once per
// command and mints ids from the injected IdSource. Three locks enforce that, and this file is the
// third — the only one that sees through a cast, a dynamic property access, or a transitive
// import:
//
//   1. the TYPE — `CommandContext` exposes no clock. Defeated by a cast.
//   2. the LINT — `bolusi/no-clock-in-handlers`. Defeated by `globalThis['Date']['now']()`, and
//      blind to anything a handler calls in another file.
//   3. THIS — the globals are poisoned for the DURATION of handler invocation, so a handler that
//      reaches one fails wherever the call actually lives.
//
// WHY POISONING RATHER THAN COUNTING. A spy that counts `Date.now()` calls would have to decide
// what an acceptable count is, and the answer is zero — so make it throw. A violating handler then
// fails loudly at the exact call, and the failure names the global it reached.
import { afterEach, describe, expect, it } from 'vitest';

import { makeCommandSpy, makeRuntimeFixture } from './_fixtures.js';
import { poisonAmbientEffects, type PoisonedGlobal } from './_purity.js';

async function ready(seed: number) {
  const fixture = makeRuntimeFixture(seed);
  await fixture.prime();
  await fixture.enroll();
  return fixture;
}

afterEach(() => {
  // A leaked poison would break every later test in the process — restore is not optional.
  expect(Date.now()).toBeGreaterThan(0);
  expect(Number.isFinite(Math.random())).toBe(true);
});

describe('the purity harness itself (T-11 — the guard must be watched going red)', () => {
  it('restores every global it poisoned, even when the body throws', () => {
    const before = { now: Date.now, random: Math.random, fetch: globalThis.fetch };

    expect(() =>
      poisonAmbientEffects(() => {
        throw new Error('body exploded');
      }),
    ).toThrow('body exploded');

    expect(Date.now).toBe(before.now);
    expect(Math.random).toBe(before.random);
    expect(globalThis.fetch).toBe(before.fetch);
  });

  it('poisons each ambient effect a handler could reach', () => {
    // The DENOMINATOR (T-14): the guard states what it covers, so a global dropped from the list
    // fails here rather than silently going unguarded.
    const reached: string[] = [];
    const probes: { name: PoisonedGlobal; call: () => unknown }[] = [
      { name: 'Date.now', call: () => Date.now() },
      { name: 'new Date', call: () => new Date() },
      { name: 'Math.random', call: () => Math.random() },
      { name: 'fetch', call: () => globalThis.fetch('https://example.test') },
      { name: 'setTimeout', call: () => globalThis.setTimeout(() => undefined, 0) },
      { name: 'setInterval', call: () => globalThis.setInterval(() => undefined, 0) },
      { name: 'performance.now', call: () => globalThis.performance.now() },
    ];
    expect(probes).toHaveLength(7);

    poisonAmbientEffects(() => {
      for (const probe of probes) {
        try {
          probe.call();
          reached.push(probe.name);
        } catch {
          // poisoned — the expected outcome
        }
      }
    });

    expect(reached, 'every listed ambient effect must be poisoned').toEqual([]);
  });

  it('does NOT poison the injected ports — a clean handler must still work', async () => {
    const fixture = await ready(1);
    let stamped = 0;
    poisonAmbientEffects(() => {
      // The FakeClock is a plain object, not a global: poisoning must not touch it, or the guard
      // would fail every handler including the correct ones.
      stamped = fixture.clock.now();
    });
    expect(stamped).toBeGreaterThan(0);
  });
});

describe('handlers are pure (04 §5.2)', () => {
  it.each([
    { name: 'Date.now()', onHandler: () => void Date.now() },
    { name: 'new Date()', onHandler: () => void new Date() },
    { name: 'Math.random()', onHandler: () => void Math.random() },
    { name: 'fetch()', onHandler: () => void globalThis.fetch('https://example.test') },
    { name: 'setTimeout()', onHandler: () => void globalThis.setTimeout(() => undefined, 0) },
    {
      name: 'a computed global lookup — the access no static rule can see',
      onHandler: () => {
        // The key is assembled at runtime, so `bolusi/no-clock-in-handlers` (and any other
        // AST-based rule) is structurally blind to it. This is the case that justifies having a
        // runtime guard at all rather than trusting the lint.
        const globals = globalThis as unknown as Record<string, { now: () => number } | undefined>;
        const key = ['D', 'a', 't', 'e'].join('');
        void globals[key]?.now();
      },
    },
  ])('a handler reaching $name fails', async ({ onHandler }) => {
    const fixture = await ready(2);
    const command = makeCommandSpy(fixture.log, { onHandler });

    const error = await poisonAmbientEffects(() =>
      fixture.runtime
        .execute(command, { title: 't', body: 'b' }, fixture.runtime.createContext(fixture.ownerId))
        .catch((e: unknown) => e),
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/04-module-contract §5\.2/);
  });

  it('POSITIVE CONTROL — a clean handler passes under the same poison (T-14b)', async () => {
    const fixture = await ready(3);
    // Uses ONLY the ctx: `ctx.newId()` (injected IdSource) and the input. This is the handler
    // §5.2 describes, and it must survive the poison — otherwise the six failures above prove
    // only that the harness breaks everything.
    const command = makeCommandSpy(fixture.log);

    const outcome = await poisonAmbientEffects(() =>
      fixture.runtime.execute(
        command,
        { title: 't', body: 'b' },
        fixture.runtime.createContext(fixture.ownerId),
      ),
    );

    expect(outcome.ops).toHaveLength(1);
    expect(outcome.result?.noteId).toBeDefined();
    expect(command.invocations).toHaveLength(1);
  });

  it('the runtime stamps the timestamp from the injected clock, not from the ambient one', async () => {
    const fixture = await ready(4);
    const command = makeCommandSpy(fixture.log);

    // The whole command — stamp point included — runs with the ambient clock poisoned. If any
    // part of the runtime reached `Date.now()` this would throw rather than produce an op.
    const outcome = await poisonAmbientEffects(() =>
      fixture.runtime.execute(
        command,
        { title: 't', body: 'b' },
        fixture.runtime.createContext(fixture.ownerId),
      ),
    );

    expect(outcome.timestamp).toBe(fixture.clock.now());
  });
});
