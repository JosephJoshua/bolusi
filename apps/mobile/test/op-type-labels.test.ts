/**
 * Every op type a module declares must have a human label (task 212; 07-i18n §4.4).
 *
 * ── WHAT WENT WRONG, AND WHY NOTHING FAILED ─────────────────────────────────────────────────────
 * `SyncStatusScreen` renders each REJECTED op as "<what was rejected> · <when>", resolving the first
 * half through `translateOpType`. That derives `<module>.opType.<camelVerb>` and falls back to
 * `core.opType.unknown` — "Perubahan" / "Change" — for any type with no row. Only the notes module
 * ever shipped those rows, so 11 of the 14 declared op types rendered "Perubahan · 14:32": a string
 * that reads like a real label rather than a missing one, on the screen a shop opens precisely when
 * it needs to know WHICH change the server refused.
 *
 * It stayed invisible because the only signal was a `warnOnce` diagnostic, and this repo's vitest
 * surfaces console output ONLY for tests that already failed — so a permanently-degraded label was
 * indistinguishable from a working one in a green suite (CLAUDE.md §2.11: a signal with no reader).
 *
 * ── WHY IT ENUMERATES RATHER THAN LISTING ───────────────────────────────────────────────────────
 * T-12: a suite built from remembered examples catches only remembered examples. The first draft of
 * task 212 listed the op types by hand, from a grep that mixed permission ids with op types, and got
 * the count wrong by two (`auth.pin_reset`, `auth.permission_denied`). So the denominator here is
 * `ALL_MODULES` itself — `defineModule(m).operations` IS the manifest's record, keyed by op type, so
 * this walks the same declaration the runtime validates against. A module added later, or a new op
 * type on an existing module, is covered the moment it is declared; nobody has to remember this file.
 *
 * Only `id` is asserted: the catalog parity gate (07-i18n §7.3, `pnpm i18n:check`) already fails the
 * build when `en` is missing a key `id` has, so checking both here would assert the gate, not the
 * labels.
 */
import { ALL_MODULES } from '@bolusi/modules';
import { getLocale, t, translateOpType } from '@bolusi/i18n';
import { beforeAll, describe, expect, test } from 'vitest';

import { registerModuleCatalogs } from '../src/bootstrap/module-catalogs.js';

/** Every op type declared by every registered module, in declaration order. */
function declaredOpTypes(): string[] {
  return ALL_MODULES.flatMap((module) => Object.keys(module.operations));
}

beforeAll(() => {
  // The app does this at boot (src/i18n.ts). Without it the notes rows are absent and this suite
  // would red on notes too — for the wrong reason.
  registerModuleCatalogs();
});

describe('op-type labels (task 212; 07-i18n §4.4)', () => {
  test('THE DENOMINATOR (T-14): the enumeration reaches every module and is not empty', () => {
    const types = declaredOpTypes();
    // A bad `operations` read (empty record, wrong field) would make every assertion below vacuous.
    expect(types.length).toBeGreaterThan(0);
    // One entry per module at minimum — a module contributing nothing means the walk missed it.
    const modules = new Set(types.map((type) => type.slice(0, type.indexOf('.'))));
    expect(modules).toEqual(new Set(ALL_MODULES.map((module) => module.id)));
    // Every declared type is well-formed, so `translateOpType`'s `<module>.<verb>` split is real.
    for (const type of types) expect(type).toMatch(/^[a-z][a-z0-9]*\.[a-z][a-z0-9_]*$/);
  });

  test('every declared op type resolves to a label, never the unknown fallback', () => {
    expect(getLocale()).toBe('id');
    const fallback = t('core.opType.unknown');
    const unlabelled = declaredOpTypes().filter((type) => translateOpType(type) === fallback);
    // Named in the failure so the red says WHICH types are missing rows, not just that some are.
    expect(unlabelled).toEqual([]);
  });

  test('the fallback is still reachable for a type no module declares', () => {
    // The arm that makes the test above mean something: if `translateOpType` never returned the
    // fallback — say a catch-all row shadowed it — the assertion would pass over a broken resolver.
    expect(translateOpType('ghost.never_declared')).toBe(t('core.opType.unknown'));
  });
});
