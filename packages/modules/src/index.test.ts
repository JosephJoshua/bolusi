import { registerModules } from '@bolusi/core';
import { describe, expect, test } from 'vitest';

import { ALL_MODULES, PACKAGE_NAME } from './index.js';

test('@bolusi/modules shell wires into the root vitest projects config', () => {
  expect(PACKAGE_NAME).toBe('@bolusi/modules');
});

// ── ALL_MODULES: the ONE registration list both apps fold from (task 90; CLAUDE.md §2.8) ──────────
//
// `apps/server`'s `SERVER_MODULES` and `apps/mobile`'s `CLIENT_MODULES` are now BOTH this list — the
// two hand-maintained `defineModule` literals task 90 unified. Deleting a module HERE is one edit
// that BOTH apps' registration suites notice (server: platform/notes/auth-registration.test.ts on
// the real push path; client: bootstrap.test.ts over the real bootstrap). This is the source's own
// denominator, so the shared list cannot silently empty in between.
describe('ALL_MODULES — the single registration source (T-14 denominator)', () => {
  test('carries exactly the platform, notes and auth modules — in that order', () => {
    // The COUNT and the id set, asserted — not "it is an array". Dropping a module reds here AND on
    // both apps; emptying the list reds here.
    expect(ALL_MODULES.map((m) => m.id)).toStrictEqual(['platform', 'notes', 'auth']);
  });

  test('registerModules(ALL_MODULES) assembles a non-trivial registry — folds, validates, resolves', () => {
    // T-14, the eight-times bug: `registerModules([])` SUCCEEDS and returns a registry that folds
    // nothing, validates nothing and answers `undefined` to every lookup. So assert the ASSEMBLED
    // denominators, not "no throw" — an empty ALL_MODULES reds every line below.
    const registry = registerModules(ALL_MODULES);

    // op-type map size (04 §3) — zero means the projection engine can apply nothing.
    expect(registry.operations.size).toBeGreaterThan(0);
    expect(registry.operations.types()).toEqual(
      expect.arrayContaining([
        'platform.user_locale_changed',
        'notes.note_created',
        'auth.permission_denied',
      ]),
    );
    // permission vocabulary size (02 §3) — an empty registry denies `unknown_permission` on every
    // call forever (02 §5.2). 19 = platform(3) + notes(4) + auth(12); the client bootstrap suite
    // asserts the identical total from the identical list.
    expect(registry.permissions.size).toBe(19);
    // module count — the modules that assembled, in list order.
    expect(registry.modules.map((m) => m.id)).toStrictEqual(['platform', 'notes', 'auth']);
  });
});
