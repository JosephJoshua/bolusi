// The failing fixtures for bolusi/no-clock-in-handlers (04-module-contract §5.2).
//
// Each `invalid` case IS the falsification of one prong: RuleTester fails a case that reports
// nothing, so a rule that quietly stopped matching cannot pass this file. The `valid` cases are
// the other half — a rule that rejects everything is as useless as one that rejects nothing, and
// they pin the things handlers legitimately do (ctx.newId, ctx.query, `new Date(ms)`).
import { RuleTester } from 'eslint';
import { describe, it } from 'vitest';

import rule, { REMEDY } from './no-clock-in-handlers.js';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

/**
 * One error of the only messageId this rule has, naming the effect.
 *
 * `remedy` comes from the rule's own table: RuleTester hydrates every placeholder, so a `data`
 * missing one fails — and re-typing the copy here would assert the wording rather than the
 * behaviour. `effect` is the part these fixtures are actually pinning.
 */
const ambient = (effect) => [
  { messageId: 'ambientEffect', data: { effect, remedy: REMEDY[effect] } },
];

tester.run('no-clock-in-handlers', rule, {
  valid: [
    // The 04 §5 handler, verbatim in spirit: ids from ctx, no ambient anything.
    {
      code: `
        export const commands = {
          createNote: {
            permission: 'notes.create',
            handler: async (input, ctx) => ({
              ops: [ctx.op({
                type: 'notes.note_created',
                entityType: 'note',
                entityId: ctx.newId(),
                payload: { title: input.title, body: input.body },
              })],
            }),
          },
        };
      `,
    },
    // Reads go through ctx.query — the same query layer the UI uses (§5.2).
    {
      code: `
        export const commands = {
          editNote: {
            handler: async (input, ctx) => {
              const existing = await ctx.query(queries.getNote, { id: input.id });
              return { ops: [ctx.op({ type: 'notes.note_body_edited', payload: { body: input.body } })] };
            },
          },
        };
      `,
    },
    // `new Date(ms)` is a pure conversion of a value the handler already holds — not a clock read.
    { code: `const when = new Date(op.timestamp);` },
    { code: `const when = new Date(input.dueAtMs);` },
    // A local named `fetch` that is not the global is out of scope for an AST rule and legitimate.
    { code: `function run(fetch) { return fetch; }` },
    // Member names that merely coincide.
    { code: `const n = counters.random();` },
    { code: `const n = myClock.now();` },
    { code: `const n = ctx.newId();` },
  ],

  invalid: [
    // --- the clock (the convergence-breaking one) ---
    {
      code: `export const commands = { createNote: { handler: (input, ctx) => ({ ops: [ctx.op({ timestamp: Date.now() })] }) } };`,
      errors: ambient('Date.now'),
    },
    {
      code: `const t = new Date();`,
      errors: ambient('new Date'),
    },
    {
      code: `const t = new Date().getTime();`,
      errors: ambient('new Date'),
    },
    {
      // The global-prefixed spelling must not be a loophole.
      code: `const t = globalThis.Date.now();`,
      errors: ambient('Date.now'),
    },
    {
      code: `const t = window.Date.now();`,
      errors: ambient('Date.now'),
    },
    {
      code: `const t = performance.now();`,
      errors: ambient('performance.now'),
    },

    // --- the rng (ids come from ctx.newId) ---
    {
      code: `const id = Math.random().toString(36);`,
      errors: ambient('Math.random'),
    },
    {
      code: `const id = globalThis.Math.random();`,
      errors: ambient('Math.random'),
    },

    // --- I/O and timers ---
    {
      code: `const res = await fetch('https://example.test');`,
      errors: ambient('fetch'),
    },
    {
      code: `const res = await globalThis.fetch('https://example.test');`,
      errors: ambient('fetch'),
    },
    {
      code: `setTimeout(() => undefined, 0);`,
      errors: ambient('setTimeout'),
    },
    {
      code: `setInterval(() => undefined, 0);`,
      errors: ambient('setInterval'),
    },
    {
      code: `setImmediate(() => undefined);`,
      errors: ambient('setImmediate'),
    },
    {
      code: `queueMicrotask(() => undefined);`,
      errors: ambient('queueMicrotask'),
    },
    {
      code: `requestAnimationFrame(() => undefined);`,
      errors: ambient('requestAnimationFrame'),
    },

    // --- more than one violation in one handler reports once per call site ---
    {
      code: `
        export const commands = {
          createNote: {
            handler: (input, ctx) => {
              const at = Date.now();
              const jitter = Math.random();
              return { ops: [] };
            },
          },
        };
      `,
      errors: [...ambient('Date.now'), ...ambient('Math.random')],
    },
  ],
});
