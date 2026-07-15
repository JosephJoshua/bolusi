// Applier registry (04 §4.4): manifest → applier / table lookup, with fail-closed guards
// against duplicate module ids and op types (op types are globally unique, 04 §1).
import { describe, expect, test } from 'vitest';
import type { ClientDatabase } from '@bolusi/db-client';

import { ProjectionRegistry, ProjectionRegistryError } from '../index.js';
import { notesModule } from '../../test/projection/notes-fixture.js';

function freshRegistry(): ProjectionRegistry<ClientDatabase> {
  const registry = new ProjectionRegistry<ClientDatabase>();
  registry.register(notesModule);
  return registry;
}

describe('ProjectionRegistry', () => {
  test('resolves the owning module and applier for a registered op type', () => {
    const registry = freshRegistry();
    expect(registry.moduleForType('notes.note_created')?.id).toBe('notes');
    expect(registry.applierForType('notes.note_body_edited')).toBeTypeOf('function');
    expect(registry.moduleForType('nope.none')).toBeUndefined();
    expect(registry.applierForType('nope.none')).toBeUndefined();
  });

  test('maps an entity type to its tables (the §4.2 re-fold delete targets)', () => {
    const registry = freshRegistry();
    expect(registry.tablesForEntityType(notesModule, 'note')).toEqual([
      { table: 'notes', entityIdColumn: 'id' },
    ]);
    expect(registry.tablesForEntityType(notesModule, 'other')).toEqual([]);
    expect(registry.moduleTableNames(notesModule)).toEqual(['notes']);
    expect(registry.moduleOpTypes(notesModule)).toContain('notes.note_archived');
  });

  test('rejects a duplicate module id', () => {
    const registry = freshRegistry();
    expect(() => registry.register(notesModule)).toThrow(ProjectionRegistryError);
  });

  test('rejects an op type already owned by another module', () => {
    const registry = freshRegistry();
    const collide = {
      id: 'other',
      tables: {},
      appliers: { 'notes.note_created': notesModule.appliers['notes.note_created'] },
    } as typeof notesModule;
    expect(() => registry.register(collide)).toThrow(/already owned by module notes/);
  });
});
