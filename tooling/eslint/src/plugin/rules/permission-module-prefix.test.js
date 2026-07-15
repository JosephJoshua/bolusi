// The failing fixtures for bolusi/permission-module-prefix (02-permissions §2).
//
// Each `invalid` case IS the falsification of one prong: the rule is only load-bearing because
// these strings are the exact shapes it must reject, and RuleTester fails if a case reports
// nothing (or reports a different messageId).
import { RuleTester } from 'eslint';
import { describe, it } from 'vitest';

import rule from './permission-module-prefix.js';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

tester.run('permission-module-prefix', rule, {
  valid: [
    // The ordinary correct manifest: own-prefix declarations, own-permission commands/queries.
    {
      code: `
        export const notesModule = defineModule({
          id: 'notes',
          permissions: {
            'notes.create': { scope: 'store', isDangerous: false, description: 'x' },
            'notes.read': { scope: 'store', isDangerous: false, description: 'x' },
          },
          commands: { createNote: { permission: 'notes.create' } },
          queries: { listNotes: { permission: 'notes.read' } },
        });
      `,
    },
    // The auth module's own ids are auth.* — §2's worked example.
    {
      code: `
        defineModule({
          id: 'auth',
          permissions: { 'auth.user_create': { scope: 'store', isDangerous: false, description: 'x' } },
          commands: { createUser: { permission: 'auth.user_create' } },
        });
      `,
    },
    // Not a manifest: an object with an id but no permissions/commands/queries.
    { code: `const row = { id: 'notes', name: 'Notes' };` },
    // A manifest whose id is not a literal cannot be checked statically — assembly's rule 4 is
    // the backstop. Must not false-positive.
    { code: `defineModule({ id: moduleId, permissions: { 'notes.create': {} } });` },
    // A computed permission string is invisible to a static rule; no false positive.
    { code: `defineModule({ id: 'notes', commands: { createNote: { permission: PERM } } });` },
    // An unrelated object that happens to have id + commands, with no permission strings.
    { code: `const cli = { id: 'notes', commands: { build: { run: 'tsc' } } };` },
  ],
  invalid: [
    {
      // Declaring under another module's prefix — the §2 "never users.create" case.
      code: `
        defineModule({
          id: 'notes',
          permissions: { 'auth.user_create': { scope: 'store', isDangerous: false, description: 'x' } },
        });
      `,
      errors: [
        {
          messageId: 'declaredPrefix',
          data: { module: 'notes', permission: 'auth.user_create', prefix: 'auth' },
        },
      ],
    },
    {
      // Requiring another module's REAL permission: resolves at assembly, boots fine, and is
      // exactly the cross-module use §2 defers to v1. Only this rule sees it.
      code: `
        defineModule({
          id: 'notes',
          permissions: { 'notes.create': { scope: 'store', isDangerous: false, description: 'x' } },
          commands: { createNote: { permission: 'auth.user_create' } },
        });
      `,
      errors: [{ messageId: 'requiredPrefix' }],
    },
    {
      // Queries are checked identically (04 §6).
      code: `
        defineModule({
          id: 'notes',
          permissions: { 'notes.read': { scope: 'store', isDangerous: false, description: 'x' } },
          queries: { listDenials: { permission: 'auth.audit_view' } },
        });
      `,
      errors: [{ messageId: 'requiredPrefix' }],
    },
    {
      // Both prongs fire independently in one manifest.
      code: `
        defineModule({
          id: 'notes',
          permissions: { 'platform.set_locale': { scope: 'store', isDangerous: false, description: 'x' } },
          commands: { setLocale: { permission: 'platform.set_locale' } },
        });
      `,
      errors: [{ messageId: 'declaredPrefix' }, { messageId: 'requiredPrefix' }],
    },
    {
      // A malformed id (no dot) is not a <module>.<action> at all.
      code: `defineModule({ id: 'notes', permissions: { create: { scope: 'store' } } });`,
      errors: [{ messageId: 'malformedId', data: { permission: 'create' } }],
    },
    {
      code: `defineModule({ id: 'notes', commands: { createNote: { permission: 'create' } } });`,
      errors: [{ messageId: 'malformedId' }],
    },
    {
      // A quoted `id` key is the same manifest.
      code: `
        defineModule({
          'id': 'notes',
          permissions: { 'auth.user_edit': { scope: 'store', isDangerous: false, description: 'x' } },
        });
      `,
      errors: [{ messageId: 'declaredPrefix' }],
    },
  ],
});
