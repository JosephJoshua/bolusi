// Module registration + registry assembly (04-module-contract §1; 02-permissions §3.2).
//
// 02 §3.2's rules are STARTUP FAILURES, "not a warning" — every test here asserts a throw, because
// each defect otherwise degrades into something indistinguishable from normal operation (see
// src/module/registry.ts for what each one turns into).
//
// The last describe block is the T-14 denominator: "every registered module/op/command resolves" is
// a vacuous claim unless the suite also states how many things it expected to check. A registry
// that silently assembled ZERO modules would satisfy every "nothing failed" assertion above.
import { describe, expect, test } from 'vitest';

import {
  defineModule,
  ModuleRegistryError,
  PermissionRegistryError,
  registerModules,
  type AnyModuleDefinition,
} from '../../src/index.js';
import {
  moduleIdFor,
  strictSchema,
  validManifest,
  type FixtureSuiteDatabase,
} from './_fixtures.js';

/** Define a valid module for `seed`, optionally overriding parts of the manifest. */
function moduleFor(
  seed: number,
  override: Partial<ReturnType<typeof validManifest>> = {},
): AnyModuleDefinition<FixtureSuiteDatabase> {
  const manifest = { ...validManifest(seed), ...override };
  return defineModule<FixtureSuiteDatabase, typeof manifest>(
    manifest,
  ) as unknown as AnyModuleDefinition<FixtureSuiteDatabase>;
}

describe('02 §3.2 rule 2 — a permission id can never mean two things', () => {
  // ── AN HONEST NOTE ABOUT RULE 2 AT THIS LAYER ────────────────────────────────────────────────
  //
  // Rule 2 ("duplicate id across modules ⇒ startup failure") is UNREACHABLE through
  // `registerModules`, and that is a property worth writing down rather than a gap to paper over
  // with a contrived test. Two modules can only collide on a permission id if they share a prefix;
  // rule 4 forces the prefix to equal the declaring module's id; and duplicate module ids are
  // rejected before any permission is read. So the three rules together make the collision
  // impossible to construct from defined modules — rule 2 is defence in depth here, not the
  // catcher.
  //
  // That does not make rule 2 untested: `assemblePermissionRegistry` is a public entry point in its
  // own right (task 09 calls it directly, and so could a future non-module caller), and
  // `test/authz/registry.test.ts` drives rule 2 against it directly. What THIS suite owns is the
  // composition: every route to a doubly-meaning permission id is closed.
  //
  // Writing a test that forced a rule-2 throw here would have meant bypassing `defineModule` to
  // build a manifest no `defineModule` can produce — i.e. asserting a behaviour of a state the
  // system cannot enter, which is how a suite grows tests that pass forever and protect nothing.

  test('rejects a module declaring a permission under another module’s prefix (rule 4 closes rule 2’s route)', () => {
    const first = moduleFor(202, {
      id: 'alpha',
      operations: {},
      commands: {},
      queries: {},
      permissions: {
        'alpha.act': { scope: 'store', isDangerous: false, description: 'Alpha declares this.' },
      },
    });
    // `beta` tries to declare `alpha.act` — the only shape in which two registered modules could
    // claim one id. Assembly rejects it on the prefix rule, so the duplicate never forms.
    const second = {
      ...moduleFor(203, { id: 'beta', operations: {}, commands: {}, queries: {}, permissions: {} }),
      permissions: {
        'alpha.act': { scope: 'store' as const, isDangerous: false, description: 'Beta’s copy.' },
      },
    };

    expect(() => registerModules([first, second as never])).toThrow(PermissionRegistryError);
  });

  test('rejects two modules sharing an id before their permissions are even read', () => {
    const shared = 'shared';
    const first = moduleFor(201, {
      id: shared,
      operations: {},
      commands: {},
      queries: {},
      permissions: {
        'shared.act': { scope: 'store', isDangerous: false, description: 'First declaration.' },
      },
    });
    const second = {
      ...moduleFor(204, { operations: {}, commands: {}, queries: {}, permissions: {} }),
      id: shared,
    };

    expect(() => registerModules([first, second])).toThrow(ModuleRegistryError);
  });
});

describe('02 §3.2 rule 3 — a permission that does not resolve is a startup failure', () => {
  test('rejects a command requiring a permission no module declares', () => {
    // Left to run, the evaluator would DENY `unknown_permission` on every call forever (02 §5.2
    // step 1): a permanent outage that reports itself to users as "you don't have permission".
    const seed = 211;
    const id = moduleIdFor(seed);
    const module = moduleFor(seed, {
      commands: {
        createWidget: {
          permission: `${id}.never_declared`,
          input: strictSchema(),
          handler: () => ({ ops: [] }),
        },
      },
    });

    expect(() => registerModules([module])).toThrow(PermissionRegistryError);
  });

  test('rejects a query requiring a permission no module declares', () => {
    // Queries are checked identically to commands (04 §6, 02 §4). Asserted separately because
    // "identically" is a claim someone has to keep true — an assembler that only walked `commands`
    // would pass every command test in this file.
    const seed = 212;
    const id = moduleIdFor(seed);
    const module = moduleFor(seed, {
      queries: {
        listWidgets: {
          permission: `${id}.also_never_declared`,
          input: strictSchema(),
          handler: () => ({ rows: [], nextCursor: null }),
        },
      },
    });

    expect(() => registerModules([module])).toThrow(PermissionRegistryError);
  });

  test('resolves a permission declared by a module registered LATER in the list', () => {
    // THE POSITIVE CONTROL for the two rejections above (T-14b): without it, an assembler that
    // threw at everything would pass both of them and look rigorous.
    //
    // It also pins 02 §3.2's ordering requirement — rule 3 is checked LAST, against the fully
    // MERGED registry — so a command may reference a permission whose declaring module appears
    // later in the list. An assembler that resolved per-module as it walked would reject this.
    const consumer = {
      ...moduleFor(213, { id: 'consumer', operations: {}, queries: {}, permissions: {} }),
      commands: {
        useIt: {
          name: 'useIt',
          permission: 'declarer.act',
          input: strictSchema(),
          handler: () => ({ ops: [] }),
        },
      },
    };
    const declarer = moduleFor(214, {
      id: 'declarer',
      operations: {},
      commands: {},
      queries: {},
      permissions: {
        'declarer.act': { scope: 'store', isDangerous: false, description: 'Declared later.' },
      },
    });

    expect(() => registerModules([consumer as never, declarer])).not.toThrow();
  });
});

describe('02 §3.2 rule 4 — permission prefix must match the declaring module', () => {
  test('rejects a permission whose prefix is another module’s id', () => {
    // `defineModule` also checks this (its own suite covers that). This asserts ASSEMBLY rejects it
    // too — the two are independent by design, so a manifest smuggled past one still hits the other.
    const seed = 221;
    const module = {
      ...moduleFor(seed, { operations: {}, commands: {}, queries: {} }),
      permissions: {
        'somebodyelse.act': {
          scope: 'store' as const,
          isDangerous: false,
          description: 'Wrong prefix.',
        },
      },
    };

    expect(() => registerModules([module as never])).toThrow(PermissionRegistryError);
  });
});

describe('04 §1 — duplicate module id is an error, never a silent merge', () => {
  test('rejects registering the same module id twice', () => {
    // Idempotency here would be the bug: two manifests under one id would have their op types,
    // permissions and tables combined in import order.
    const module = moduleFor(231);

    expect(() => registerModules([module, module])).toThrow(ModuleRegistryError);
  });

  test('rejects a duplicate module id even when the module declares nothing', () => {
    // The reason the duplicate-id check lives in `registerModules` rather than being left to the
    // sub-registries: a module with no permissions AND no appliers is invisible to both of them, so
    // neither would notice the collision.
    const empty = moduleFor(232, {
      operations: {},
      permissions: {},
      commands: {},
      queries: {},
      projections: { tables: {} },
    });

    expect(() => registerModules([empty, empty])).toThrow(ModuleRegistryError);
  });
});

describe('04 §1 — duplicate op type across modules is an error', () => {
  test('rejects two modules declaring the same op type', () => {
    // One applier would silently shadow the other: the loser's projection never updates.
    const shared = 'alpha.widget_created';
    const first = moduleFor(241, {
      id: 'alpha',
      operations: {
        [shared]: validManifest(241).operations[`${moduleIdFor(241)}.widget_created`]!,
      },
      permissions: {},
      commands: {},
      queries: {},
    });
    const second = {
      ...moduleFor(242, { id: 'beta', operations: {}, permissions: {}, commands: {}, queries: {} }),
      operations: {
        [shared]: validManifest(242).operations[`${moduleIdFor(242)}.widget_created`]!,
      },
    };

    expect(() => registerModules([first, second as never])).toThrow();
  });
});

describe('the assembled registry resolves everything — and states its denominator (T-14)', () => {
  test('every registered command/query permission resolves, over a NON-ZERO count', () => {
    // T-14: "every permission resolves" passes trivially over an empty list. So the suite names the
    // total it expects to have checked and asserts assembly saw the same number. A registry that
    // parsed to zero commands — the silent-nothing failure — fails here rather than reporting green.
    const modules = [moduleFor(251), moduleFor(252), moduleFor(253)];

    const registry = registerModules(modules);

    // Denominator: 3 modules x (1 command + 1 query + 1 op type + 2 permissions).
    expect(registry.modules).toHaveLength(3);
    expect(registry.commandNames()).toHaveLength(3);
    expect(registry.queryNames()).toHaveLength(3);
    expect(registry.operations.size).toBe(3);
    expect(registry.permissions.size).toBe(6);

    // ...and each of those really resolves, rather than merely being counted.
    for (const module of modules) {
      expect(registry.command(`${module.id}.createWidget`)).toBeDefined();
      expect(registry.query(`${module.id}.listWidgets`)).toBeDefined();
      expect(registry.permissions.has(`${module.id}.create`)).toBe(true);
      expect(registry.permissions.has(`${module.id}.read`)).toBe(true);
      expect(registry.operations.schemaVersionFor(`${module.id}.widget_created`)).toBe(1);
      expect(registry.projections.moduleForType(`${module.id}.widget_created`)?.id).toBe(module.id);
    }
  });

  test('the operation registry answers undefined for an unregistered op type', () => {
    // The negative control for the resolution assertions above: if `schemaVersionFor` returned a
    // number for everything, every check in the previous test would pass vacuously.
    const registry = registerModules([moduleFor(254)]);

    expect(registry.operations.schemaVersionFor('nobody.thing_happened')).toBeUndefined();
  });

  test('appliers reach the projection registry, keyed by op type', () => {
    const seed = 255;
    const module = moduleFor(seed);

    const registry = registerModules([module]);

    expect(registry.projections.applierForType(`${moduleIdFor(seed)}.widget_created`)).toBe(
      module.operations[`${moduleIdFor(seed)}.widget_created`]!.apply,
    );
  });
});
