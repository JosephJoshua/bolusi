// The `notes` manifest correctness gate (04 §4.4 — the convergence oracle's prerequisite).
//
// The oracle digests manifest-DECLARED columns in DECLARATION order (testing-guide §3.4). An
// undeclared physical column is invisible to it, so two projections differing only there would read
// as equal — a review failure (04 §4.4). This asserts the manifest declares EXACTLY the shipped
// `notes` table's columns, in 10-db DDL order, incl. `edit_count`. It runs against the REAL client
// migration (10-db §9.6), not a transcription, so the manifest is pinned to the shipped schema.
import { CamelCasePlugin, Kysely } from 'kysely';
import { afterEach, describe, expect, test } from 'vitest';

import {
  assertManifestColumnsComplete,
  declaredColumns,
  OracleError,
  registerModules,
  type AnyModuleDefinition,
} from '@bolusi/core';
import { createClientDialect, runClientMigrations, type DbDriver } from '@bolusi/db-client';

import { notesModule, notesTable } from '../src/notes/index.js';
import { openMemoryDriver } from './support/better-sqlite3-driver.js';

/** 10-db `notes` columns in DDL order (Postgres §8 / SQLite §9.6) — the oracle's digest order. */
const DDL_ORDER = [
  'id',
  'tenant_id',
  'store_id',
  'title',
  'body',
  'media_id',
  'archived',
  'edit_count',
  'created_by',
  'created_at',
  'last_edited_by',
  'last_edited_at',
] as const;

let driver: DbDriver | null = null;
let db: Kysely<never> | null = null;

afterEach(async () => {
  await db?.destroy();
  await driver?.close();
  driver = null;
  db = null;
});

async function openClientDb(): Promise<Kysely<never>> {
  driver = openMemoryDriver();
  await runClientMigrations(driver, { now: () => 1 });
  db = new Kysely<never>({
    dialect: createClientDialect(driver),
    plugins: [new CamelCasePlugin({ underscoreBetweenUppercaseLetters: true })],
  });
  return db;
}

describe('notes manifest correctness (04 §4.4 / oracle prerequisite)', () => {
  test('the manifest declares EXACTLY the shipped notes columns, in 10-db DDL order', async () => {
    expect(declaredColumns(notesTable)).toStrictEqual([...DDL_ORDER]);
    // `edit_count` is the testability column (01 §9; testing-guide §3.2) — named explicitly so its
    // removal fails HERE rather than silently disabling idempotency detection.
    expect(declaredColumns(notesTable)).toContain('edit_count');
    expect(notesTable.entityType).toBe('note');
    expect(notesTable.entityIdColumn).toBe('id');
    expect(notesTable.primaryKey).toStrictEqual(['id']);
  });

  test('the manifest matches the REAL client migration table — no undeclared/absent column', async () => {
    const handle = await openClientDb();
    // Throws OracleError naming any undeclared or declared-but-absent column (T-14: a coverage check
    // names its own denominator). Green here = the manifest is the shipped table, exactly.
    await expect(
      assertManifestColumnsComplete(handle, 'notes', notesTable),
    ).resolves.toBeUndefined();
  });

  test('a manifest that drops a real column is CAUGHT (falsification of the completeness gate)', async () => {
    const handle = await openClientDb();
    const crippled = {
      ...notesTable,
      columns: Object.fromEntries(
        Object.entries(notesTable.columns).filter(([c]) => c !== 'edit_count'),
      ),
    };
    // Dropping `edit_count` from the manifest must make the physical column UNDECLARED → OracleError.
    // This is the guard watched going red (CLAUDE.md §2.11), inline.
    await expect(assertManifestColumnsComplete(handle, 'notes', crippled)).rejects.toBeInstanceOf(
      OracleError,
    );
  });
});

describe('notes conflict declarations (01 §8.1)', () => {
  const registry = registerModules([notesModule as unknown as AnyModuleDefinition<never>]);

  test('note_body_edited carries {key: note.body, severity: minor}; the others carry none', () => {
    expect(registry.operations.conflictFor('notes.note_body_edited')).toStrictEqual({
      key: 'note.body',
      severity: 'minor',
    });
    expect(registry.operations.conflictFor('notes.note_created')).toBeUndefined();
    expect(registry.operations.conflictFor('notes.note_archived')).toBeUndefined();
  });

  test('note_created is at schemaVersion 2; the edit/archive types are v1', () => {
    expect(registry.operations.schemaVersionFor('notes.note_created')).toBe(2);
    expect(registry.operations.schemaVersionFor('notes.note_body_edited')).toBe(1);
    expect(registry.operations.schemaVersionFor('notes.note_archived')).toBe(1);
  });

  test('all three notes op types are store-scoped (01 §9)', () => {
    for (const type of ['notes.note_created', 'notes.note_body_edited', 'notes.note_archived']) {
      expect(registry.operations.scopeFor(type)).toBe('store');
    }
  });
});
