// The failing fixtures for bolusi/runtime-emission-allowlist (04-module-contract §5.1).
//
// Each `invalid` case IS the falsification of one prong — RuleTester fails a case that reports
// nothing. The `valid` cases carry the other half: all five sanctioned types must pass, or the
// rule is just "reject everything", which would be equally green and completely useless.
import { RuleTester } from 'eslint';
import { describe, expect, it } from 'vitest';

import rule from './runtime-emission-allowlist.js';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

/**
 * The five (04 §5.1). Kept here in the FIXTURES only — the rule itself holds no copy and reads
 * its set from options; the production set lives once, in
 * packages/core/src/runtime/runtime-emissions.ts, pinned to the spec by core's own suite.
 */
const SANCTIONED = [
  'auth.user_switched',
  'auth.session_ended',
  'auth.permission_denied',
  'auth.pin_locked_out',
  'auth.device_enrolled',
];

const ALLOW_FILES = ['packages/core/src/runtime/execute.ts'];
const options = [{ sanctionedTypes: SANCTIONED, allowFiles: ALLOW_FILES }];

const unsanctioned = (type) => [
  { messageId: 'unsanctionedType', data: { type, sanctioned: SANCTIONED.join(', ') } },
];

describe('the fixture set is the real one (T-14)', () => {
  it('exercises all five sanctioned types and nothing more', () => {
    // If this list silently shrank, every "valid" case below would still pass — and the rule would
    // be enforcing a smaller set than the spec without a single test going red.
    expect(SANCTIONED).toHaveLength(5);
  });
});

tester.run('runtime-emission-allowlist', rule, {
  valid: [
    // All five sanctioned types pass through the channel. This is the denominator: the rule must
    // permit exactly these, not merely reject something.
    ...SANCTIONED.map((type) => ({
      code: `await runtime.emitRuntimeOp({ type: '${type}', entityType: 'x', entityId: id, payload: {}, userId: u });`,
      options,
    })),
    // A non-literal type is TypeScript's job, not this rule's (documented limit) — the denial
    // emitter binds `PERMISSION_DENIED_OP_TYPE`, a typed constant.
    {
      code: `await runtime.emitRuntimeOp({ type: PERMISSION_DENIED_OP_TYPE, payload: {} });`,
      options,
    },
    // No `type` key at all — nothing to check.
    { code: `await runtime.emitRuntimeOp(draft);`, options },
    // A command handler returning drafts is the NORMAL write path and must never be flagged.
    {
      code: `
        export const commands = {
          createNote: {
            permission: 'notes.create',
            handler: (input, ctx) => ({
              ops: [ctx.op({ type: 'notes.note_created', entityType: 'note', entityId: ctx.newId(), payload: input })],
            }),
          },
        };
      `,
      options,
    },
    // An unrelated method that happens to take a `type`.
    { code: `bus.publish({ type: 'notes.note_created' });`, options },
    // PRONG B: the allowlisted runtime file may call the append path — that is its job.
    {
      code: `const { ops } = await appendLocalOps({ store, drafts, context });`,
      filename: '/repo/packages/core/src/runtime/execute.ts',
      options,
    },
  ],

  invalid: [
    // --- PRONG A: a non-command append of an unsanctioned type ---
    {
      // The literal case the task's acceptance names: a business op smuggled through the channel.
      code: `await runtime.emitRuntimeOp({ type: 'notes.note_created', entityType: 'note', entityId: id, payload: {}, userId: u });`,
      options,
      errors: unsanctioned('notes.note_created'),
    },
    {
      code: `await runtime.emitRuntimeOp({ type: 'platform.user_locale_changed', payload: {} });`,
      options,
      errors: unsanctioned('platform.user_locale_changed'),
    },
    {
      // A plausible-sounding auth type that is NOT one of the five. Deny by allowlist, not by
      // blocklist: an `auth.` prefix is not a permit.
      code: `await runtime.emitRuntimeOp({ type: 'auth.pin_changed', payload: {} });`,
      options,
      errors: unsanctioned('auth.pin_changed'),
    },
    {
      code: `await runtime.emitRuntimeOp({ type: 'auth.user_created', payload: {} });`,
      options,
      errors: unsanctioned('auth.user_created'),
    },
    {
      code: `await runtime.emitRuntimeOp({ type: 'auth.device_revoked', payload: {} });`,
      options,
      errors: unsanctioned('auth.device_revoked'),
    },
    {
      // Near-miss: correct type, wrong case. A case-insensitive match would be a hole.
      code: `await runtime.emitRuntimeOp({ type: 'AUTH.USER_SWITCHED', payload: {} });`,
      options,
      errors: unsanctioned('AUTH.USER_SWITCHED'),
    },
    {
      // Near-miss: a sanctioned type with a suffix.
      code: `await runtime.emitRuntimeOp({ type: 'auth.session_ended.v2', payload: {} });`,
      options,
      errors: unsanctioned('auth.session_ended.v2'),
    },
    {
      // The channel reached through a member call (`this.emitRuntimeOp`, `runtime.emitRuntimeOp`)
      // is the same channel — the rule matches the method name, not the receiver.
      code: `await this.emitRuntimeOp({ type: 'notes.note_created', payload: {} });`,
      options,
      errors: unsanctioned('notes.note_created'),
    },

    // --- PRONG B: reaching the append path from outside the runtime ---
    {
      code: `await appendLocalOps({ store, drafts: [draft], context });`,
      filename: '/repo/packages/modules/src/notes/commands.ts',
      options,
      errors: [
        {
          messageId: 'appendOutsideRuntime',
          data: { callee: 'appendLocalOps', allowed: ALLOW_FILES.join(', ') },
        },
      ],
    },
    {
      code: `await appendLocalOps({ store, drafts, context });`,
      filename: '/repo/apps/mobile/src/sneaky.ts',
      options,
      errors: [
        {
          messageId: 'appendOutsideRuntime',
          data: { callee: 'appendLocalOps', allowed: ALLOW_FILES.join(', ') },
        },
      ],
    },
  ],
});
