// Registry assembly (02-permissions §3.2 rules 1–4) — the STARTUP-FAILURE surface.
//
// The named startup-failure guard: a command declaring a permission no module registers must fail
// ASSEMBLY, not boot into a runtime that denies that command forever with `unknown_permission`. A
// silent permanent outage dressed as an authorization decision is exactly what rule 3 exists to
// stop, so every rule here is asserted to THROW — never to warn, never to skip the entry.
import { describe, expect, test } from 'vitest';

import {
  assemblePermissionRegistry,
  collectPermissionReferences,
  PermissionRegistryError,
  PERMISSION_ID_PATTERN,
  type ModulePermissionManifest,
} from '../../src/index.js';
import {
  authModule,
  notesModule,
  platformModule,
  V0_MODULES,
  V0_PERMISSION_COUNT,
  V0_REFERENCE_COUNT,
} from './_fixtures.js';

describe('assembly — the happy path (§3.2 rule 1)', () => {
  test('merges a multi-module fixture into one registry', () => {
    const registry = assemblePermissionRegistry(V0_MODULES);
    // T-14: the merge's denominator. A manifest that silently contributed nothing would otherwise
    // pass every "contains x" assertion below by accident of the other two modules.
    expect(registry.size).toBe(V0_PERMISSION_COUNT);
    expect(registry.ids()).toHaveLength(V0_PERMISSION_COUNT);
    for (const module of V0_MODULES) {
      const declared = Object.keys(module.permissions ?? {});
      expect(declared.length, `${module.id} declares nothing`).toBeGreaterThan(0);
      for (const id of declared) expect(registry.has(id), id).toBe(true);
    }
  });

  test('derives module and action from the id — never declared twice (§3.1)', () => {
    const registry = assemblePermissionRegistry(V0_MODULES);
    const entry = registry.get('auth.user_reset_pin');
    expect(entry).toMatchObject({
      id: 'auth.user_reset_pin',
      module: 'auth',
      action: 'user_reset_pin',
      scope: 'store',
      isDangerous: true,
    });
    expect(entry?.description).toContain('PIN');
  });

  test('carries the §11 scopes: role_manage and tenant_configure are the only tenant-scoped ids', () => {
    const registry = assemblePermissionRegistry(V0_MODULES);
    const tenantScoped = registry
      .all()
      .filter((e) => e.scope === 'tenant')
      .map((e) => e.id);
    expect(tenantScoped.sort()).toEqual(['auth.role_manage', 'auth.tenant_configure']);
  });

  test('an id absent from this build’s registry is simply absent — get() is undefined, not a stub', () => {
    const registry = assemblePermissionRegistry(V0_MODULES);
    expect(registry.get('notes.telepathy')).toBeUndefined();
    expect(registry.has('notes.telepathy')).toBe(false);
  });
});

describe('assembly — startup failures (§3.2 rules 2–4)', () => {
  test('rule 3 (THE startup-failure guard): a command requiring an unregistered permission throws', () => {
    // Positive control (T-14b): the same module assembles cleanly when the reference resolves.
    const sound: ModulePermissionManifest = {
      id: 'notes',
      permissions: { 'notes.create': { scope: 'store', isDangerous: false, description: 'x' } },
      commands: { createNote: { permission: 'notes.create' } },
    };
    expect(() => assemblePermissionRegistry([sound])).not.toThrow();

    const bogus: ModulePermissionManifest = {
      id: 'notes',
      permissions: { 'notes.create': { scope: 'store', isDangerous: false, description: 'x' } },
      commands: { createNote: { permission: 'notes.telepathy' } },
    };
    expect(() => assemblePermissionRegistry([bogus])).toThrow(PermissionRegistryError);
    expect(() => assemblePermissionRegistry([bogus])).toThrow(/notes\.telepathy/);
  });

  test('rule 3 applies to QUERIES identically (04 §6 — queries are checked like commands)', () => {
    const bogus: ModulePermissionManifest = {
      id: 'notes',
      permissions: { 'notes.read': { scope: 'store', isDangerous: false, description: 'x' } },
      queries: { listNotes: { permission: 'notes.clairvoyance' } },
    };
    expect(() => assemblePermissionRegistry([bogus])).toThrow(/notes\.clairvoyance/);
  });

  test('rule 3 resolves against the MERGED registry — declaration order does not matter', () => {
    const consumer: ModulePermissionManifest = {
      id: 'platform',
      commands: { setLocale: { permission: 'platform.set_locale' } },
      permissions: {
        'platform.set_locale': { scope: 'store', isDangerous: false, description: 'x' },
      },
    };
    expect(() => assemblePermissionRegistry([consumer, notesModule])).not.toThrow();
    expect(() => assemblePermissionRegistry([notesModule, consumer])).not.toThrow();
  });

  test('rule 2: a duplicate id across two modules is a startup failure, not a warning', () => {
    const a: ModulePermissionManifest = {
      id: 'notes',
      permissions: { 'notes.create': { scope: 'store', isDangerous: false, description: 'a' } },
    };
    const b: ModulePermissionManifest = {
      // A second manifest under the same prefix but a different module id — the only way to reach
      // the duplicate check, since one manifest's keys are unique by construction.
      id: 'notes',
      permissions: { 'notes.create': { scope: 'store', isDangerous: false, description: 'b' } },
    };
    expect(() => assemblePermissionRegistry([a, b])).toThrow(PermissionRegistryError);
  });

  test('rule 2: a duplicate module id is a startup failure', () => {
    expect(() => assemblePermissionRegistry([notesModule, notesModule])).toThrow(
      /module already registered: notes/,
    );
  });

  test('rule 4: an id whose prefix ≠ the declaring module id is a startup failure', () => {
    const trespasser: ModulePermissionManifest = {
      id: 'notes',
      // The auth module's namespace. §2: "The auth module's ids are auth.user_create — never
      // users.create". A module may declare only under its own prefix.
      permissions: { 'auth.user_create': { scope: 'store', isDangerous: false, description: 'x' } },
    };
    expect(() => assemblePermissionRegistry([trespasser])).toThrow(PermissionRegistryError);
    expect(() => assemblePermissionRegistry([trespasser])).toThrow(/prefix is auth/);
  });

  test('§2 format: malformed ids are startup failures (the id-format class, T-12)', () => {
    // The CLASS of malformed ids, not one remembered example.
    const malformed = [
      'notes', // no action
      'notes.', // empty action
      '.create', // empty module
      'notes.create.extra', // three segments
      'Notes.create', // uppercase module
      'notes.Create', // uppercase action
      'notes create', // space
      'notes-create', // no dot
      '1notes.create', // module starts with a digit
      'notes.1create', // action starts with a digit
      'notes..create', // empty middle
      '', // empty
    ];
    for (const id of malformed) {
      expect(PERMISSION_ID_PATTERN.test(id), `${id} must not match the §2 pattern`).toBe(false);
      const module: ModulePermissionManifest = {
        id: 'notes',
        permissions: { [id]: { scope: 'store', isDangerous: false, description: 'x' } },
      };
      expect(() => assemblePermissionRegistry([module]), id).toThrow(PermissionRegistryError);
    }
  });

  test('§2 format: the v0 registry’s own ids all match the pattern', () => {
    const registry = assemblePermissionRegistry(V0_MODULES);
    expect(registry.ids()).toHaveLength(V0_PERMISSION_COUNT);
    for (const id of registry.ids()) {
      expect(PERMISSION_ID_PATTERN.test(id), id).toBe(true);
    }
  });
});

describe('rule 3 coverage (T-14 — the reference denominator)', () => {
  test('collectPermissionReferences finds every command AND query reference', () => {
    const references = collectPermissionReferences(V0_MODULES);
    // The denominator: assembly's rule-3 loop iterates exactly this list. If a manifest shape
    // change made it parse to zero, assembly would "validate" nothing and report green — this
    // number is what makes that fail loudly instead.
    expect(references).toHaveLength(V0_REFERENCE_COUNT);
    expect(references.filter((r) => r.surface === 'command')).toHaveLength(7);
    expect(references.filter((r) => r.surface === 'query')).toHaveLength(5);
    for (const module of V0_MODULES) {
      expect(
        references.filter((r) => r.module === module.id).length,
        `${module.id} contributed no references`,
      ).toBeGreaterThan(0);
    }
  });

  test('every reference in the v0 fixture resolves against the assembled registry', () => {
    const registry = assemblePermissionRegistry(V0_MODULES);
    const references = collectPermissionReferences(V0_MODULES);
    expect(references.length).toBe(V0_REFERENCE_COUNT); // denominator, again, at the point of use
    for (const reference of references) {
      expect(
        registry.has(reference.permission),
        `${reference.name} → ${reference.permission}`,
      ).toBe(true);
    }
  });

  test('a module with no commands/queries contributes no references and still assembles', () => {
    const bare: ModulePermissionManifest = {
      id: 'platform',
      permissions: {
        'platform.set_locale': { scope: 'store', isDangerous: false, description: 'x' },
      },
    };
    expect(collectPermissionReferences([bare])).toHaveLength(0);
    expect(assemblePermissionRegistry([bare]).size).toBe(1);
  });
});

describe('the registry is immutable at runtime (§1)', () => {
  test('exposes no mutation surface', () => {
    const registry = assemblePermissionRegistry([authModule, platformModule]);
    // The vocabulary changes with an app release, never at runtime, never per tenant.
    const surface = registry as unknown as Record<string, unknown>;
    expect(typeof surface.register).toBe('undefined');
    expect(typeof surface.add).toBe('undefined');
    expect(typeof surface.delete).toBe('undefined');
    expect(typeof surface.set).toBe('undefined');
  });

  test('ids() is sorted and stable across calls', () => {
    const registry = assemblePermissionRegistry(V0_MODULES);
    const first = registry.ids();
    expect([...first].sort()).toEqual([...first]);
    expect(registry.ids()).toEqual(first);
  });
});
