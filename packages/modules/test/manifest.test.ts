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
  'media_sha256',
  'media_mime',
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

  test('note_created is at schemaVersion 3; the edit/archive types are v1', () => {
    // v3 carries the whole signed mediaRef so a PULLED note can download-verify its photo (06 §6).
    expect(registry.operations.schemaVersionFor('notes.note_created')).toBe(3);
    expect(registry.operations.schemaVersionFor('notes.note_body_edited')).toBe(1);
    expect(registry.operations.schemaVersionFor('notes.note_archived')).toBe(1);
  });

  test('all three notes op types are store-scoped (01 §9)', () => {
    for (const type of ['notes.note_created', 'notes.note_body_edited', 'notes.note_archived']) {
      expect(registry.operations.scopeFor(type)).toBe('store');
    }
  });
});

describe('note_created retained per-version payload schemas (04 §3 payloadByVersion; task 127)', () => {
  // The applier folds v1/v2/v3 forever (05 §7), so all three are versions the server can be ASKED
  // to accept — and each must be validated against the schema ITS OWN version declared. The server
  // integration gate for this is apps/server's `notes-old-version-payload.test.ts`, over the real
  // push path; this pins the SHAPES the declaration retains, where a wrong one is readable.
  const declaration = notesModule.operations['notes.note_created']!;
  const v1 = declaration.payloadByVersion?.[1];
  const v2 = declaration.payloadByVersion?.[2];

  /** Does this retained schema accept `payload`? A throw is a rejection (parse, not safeParse). */
  function accepts(schema: typeof v1, payload: unknown): boolean {
    if (schema === undefined) return false;
    try {
      schema.parse(payload);
      return true;
    } catch {
      return false;
    }
  }

  test('retention covers exactly the superseded versions 1 and 2', () => {
    // The denominator (T-14): a map that silently covered only v2 would leave v1 rejected forever
    // in production, and every assertion below about v2 would still be green.
    expect(Object.keys(declaration.payloadByVersion ?? {}).sort()).toEqual(['1', '2']);
  });

  test('v1 accepts {title, body} and rejects a missing title — the NOT NULL column it folds into', () => {
    expect(accepts(v1, { title: 'Catatan', body: 'isi' })).toBe(true);
    expect(accepts(v1, { body: 'no title' })).toBe(false);
    expect(accepts(v1, {})).toBe(false);
    expect(accepts(v1, { title: '', body: 'isi' })).toBe(false);
  });

  test('v1 is strict — an unknown key is rejected, so an old version is not an unknown-key bypass', () => {
    expect(accepts(v1, { title: 'Catatan', body: 'isi', whateverIWant: 1 })).toBe(false);
    // A v3 payload stamped v1 is a version/payload MISMATCH and must be rejected as such: it is
    // not what it says it is. (This is what chaos-05's fixture used to emit, invisibly.)
    expect(accepts(v1, { title: 'Catatan', body: 'isi', mediaRef: null })).toBe(false);
  });

  test('v2 accepts a uuid mediaId (and null) and rejects a non-uuid — the uuid column it folds into', () => {
    expect(
      accepts(v2, {
        title: 'Catatan',
        body: 'isi',
        mediaId: '01920000-0000-7000-8000-00000000beef',
      }),
    ).toBe(true);
    expect(accepts(v2, { title: 'Catatan', body: 'isi', mediaId: null })).toBe(true);
    expect(accepts(v2, { title: 'Catatan', body: 'isi', mediaId: 'NOT-A-UUID-AT-ALL' })).toBe(
      false,
    );
    // Present-and-null, never absent (05 §3): the JCS preimage has no optional keys.
    expect(accepts(v2, { title: 'Catatan', body: 'isi' })).toBe(false);
  });

  test('the CURRENT schema still rejects a legitimate v2 payload — which is WHY v2 is retained', () => {
    // The one-line refutation of "just validate old payloads against the current schema": v3's
    // `.strict()` refuses `mediaId`, so that shortcut would reject the rolling-out old client.
    const legitimateV2 = {
      title: 'Catatan',
      body: 'isi',
      mediaId: '01920000-0000-7000-8000-00000000beef',
    };
    expect(accepts(declaration.payload, legitimateV2)).toBe(false);
    expect(accepts(v2, legitimateV2)).toBe(true);
  });
});
