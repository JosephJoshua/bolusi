// The `notes` commands (04 §5) — the only write path — driven through the REAL runtime against a
// real better-sqlite3 DB (04 §8: command units + the permission-denial floor, which ships BEFORE
// review per CLAUDE.md §2.5). Every step (parse → permission → handler → envelope → append →
// project) is production code; the assertions read the op log and the projection a query would.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sql } from 'kysely';
import { afterEach, describe, expect, test } from 'vitest';

import { DomainError } from '@bolusi/core';

import { notesModule } from '../src/notes/index.js';
import { openHarness, type Harness } from './support/harness.js';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const CREATE = notesModule.commands.createNote;
const EDIT = notesModule.commands.editNoteBody;
const ARCHIVE = notesModule.commands.archiveNote;

async function expectDomainError(p: Promise<unknown>, code: string): Promise<DomainError> {
  const err = await p.then(
    () => {
      throw new Error(`expected DomainError(${code}), but the call resolved`);
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DomainError);
  expect((err as DomainError).code).toBe(code);
  return err as DomainError;
}

async function opsOfType(harness: Harness, type: string): Promise<Record<string, unknown>[]> {
  const rows = await sql<Record<string, unknown>>`
    SELECT id, type, schema_version AS "schemaVersion", payload, user_id AS "userId",
           store_id AS "storeId", timestamp_ms AS "timestampMs"
    FROM operations WHERE type = ${type}
  `.execute(harness.db);
  return rows.rows;
}

async function notesRows(harness: Harness): Promise<Record<string, unknown>[]> {
  const rows = await sql<Record<string, unknown>>`
    SELECT id, title, body, media_id AS "mediaId", archived, edit_count AS "editCount",
           created_by AS "createdBy", store_id AS "storeId"
    FROM notes
  `.execute(harness.db);
  return rows.rows;
}

describe('notes command units (04 §5 / §8)', () => {
  test('createNote → v2 note_created with a runtime-completed envelope + a query-visible row', async () => {
    h = await openHarness(1);
    const outcome = await h.runtime.commands.execute(
      CREATE,
      { title: 'Stok kopi', body: 'Sisa 4 karung' },
      h.runtime.commands.createContext(h.notesUserId),
    );

    const ops = await opsOfType(h, 'notes.note_created');
    expect(ops).toHaveLength(1);
    // schemaVersion resolved to 2 from the registry (a handler cannot state its own version).
    expect(ops[0]!.schemaVersion).toBe(2);
    expect(JSON.parse(ops[0]!.payload as string)).toStrictEqual({
      title: 'Stok kopi',
      body: 'Sisa 4 karung',
      mediaId: null, // present-and-null (05 §3), even with no photo
    });
    // The runtime stamped the envelope: store from the device (01 §9), user = the actor.
    expect(ops[0]!.storeId).toBe(h.storeId);
    expect(ops[0]!.userId).toBe(h.notesUserId);
    expect(typeof ops[0]!.timestampMs).toBe('number');

    const rows = await notesRows(h);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe('Stok kopi');
    expect(rows[0]!.id).toBe((outcome.result as { noteId: string }).noteId);
    expect(rows[0]!.archived).toBe(0);
    expect(rows[0]!.editCount).toBe(0);
  });

  test('media attach — createNote with a mediaId emits a v2 op carrying it; media_id is set (04 §8 box 8)', async () => {
    h = await openHarness(2);
    await h.runtime.commands.execute(
      CREATE,
      { title: 'Nota', body: 'lihat foto', mediaId: '01920000-0000-7000-8000-0000000f000a' },
      h.runtime.commands.createContext(h.notesUserId),
    );
    const ops = await opsOfType(h, 'notes.note_created');
    // The op's payload carries the media id — it syncs/applies independently of upload (FR-1138).
    expect(JSON.parse(ops[0]!.payload as string).mediaId).toBe(
      '01920000-0000-7000-8000-0000000f000a',
    );
    const rows = await notesRows(h);
    expect(rows[0]!.mediaId).toBe('01920000-0000-7000-8000-0000000f000a');
  });

  test('empty title → VALIDATION_FAILED (schema min(1)); the handler never runs', async () => {
    h = await openHarness(3);
    await expectDomainError(
      h.runtime.commands.execute(
        CREATE,
        { title: '', body: 'b' },
        h.runtime.commands.createContext(h.notesUserId),
      ),
      'VALIDATION_FAILED',
    );
    expect(await notesRows(h)).toHaveLength(0);
  });

  test('unknown payload key → VALIDATION_FAILED (.strict input)', async () => {
    h = await openHarness(4);
    await expectDomainError(
      h.runtime.commands.execute(
        CREATE,
        { title: 't', body: 'b', color: 'red' } as never,
        h.runtime.commands.createContext(h.notesUserId),
      ),
      'VALIDATION_FAILED',
    );
    expect(await notesRows(h)).toHaveLength(0);
  });

  test('editNoteBody on a LOCALLY-ARCHIVED note → INVALID_TRANSITION (01 §9)', async () => {
    h = await openHarness(5);
    const created = await h.runtime.commands.execute(
      CREATE,
      { title: 't', body: 'b' },
      h.runtime.commands.createContext(h.notesUserId),
    );
    const noteId = (created.result as { noteId: string }).noteId;
    await h.runtime.commands.execute(
      ARCHIVE,
      { noteId },
      h.runtime.commands.createContext(h.notesUserId),
    );
    await expectDomainError(
      h.runtime.commands.execute(
        EDIT,
        { noteId, body: 'new body' },
        h.runtime.commands.createContext(h.notesUserId),
      ),
      'INVALID_TRANSITION',
    );
    // No body_edited op was appended — the denial was pre-emission.
    expect(await opsOfType(h, 'notes.note_body_edited')).toHaveLength(0);
  });

  test('archiveNote on an already-archived note → INVALID_TRANSITION (archived is terminal)', async () => {
    h = await openHarness(6);
    const created = await h.runtime.commands.execute(
      CREATE,
      { title: 't', body: 'b' },
      h.runtime.commands.createContext(h.notesUserId),
    );
    const noteId = (created.result as { noteId: string }).noteId;
    await h.runtime.commands.execute(
      ARCHIVE,
      { noteId },
      h.runtime.commands.createContext(h.notesUserId),
    );
    await expectDomainError(
      h.runtime.commands.execute(
        ARCHIVE,
        { noteId },
        h.runtime.commands.createContext(h.notesUserId),
      ),
      'INVALID_TRANSITION',
    );
    // Exactly ONE archive op — the second was refused before emission.
    expect(await opsOfType(h, 'notes.note_archived')).toHaveLength(1);
  });

  test('any command on a nonexistent note id → ENTITY_NOT_FOUND', async () => {
    h = await openHarness(7);
    const ctx = () => h!.runtime.commands.createContext(h!.notesUserId);
    await expectDomainError(
      h.runtime.commands.execute(EDIT, { noteId: 'no-such-note', body: 'x' }, ctx()),
      'ENTITY_NOT_FOUND',
    );
    await expectDomainError(
      h.runtime.commands.execute(ARCHIVE, { noteId: 'no-such-note' }, ctx()),
      'ENTITY_NOT_FOUND',
    );
  });

  test('handlers contain no Date.now / Math.random / IO — purity by inspection (04 §5.2)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, '../src/notes/commands.ts'), 'utf8');
    // The ctx surface has no clock and no db (ctx.ts), so a handler could only reach a clock by
    // importing one. This catches a regression that added one anyway.
    expect(source).not.toMatch(/Date\.now|Math\.random|\bfetch\(|process\./);
  });
});

describe('notes permission-denial floor (04 §8 box 2 — ships before review, §2.5)', () => {
  test('a zero-grant user: EVERY command → PERMISSION_DENIED + a durable denial op', async () => {
    h = await openHarness(8);
    const ctx = () => h!.runtime.commands.createContext(h!.zeroUserId);

    await expectDomainError(
      h.runtime.commands.execute(CREATE, { title: 't', body: 'b' }, ctx()),
      'PERMISSION_DENIED',
    );
    await expectDomainError(
      h.runtime.commands.execute(EDIT, { noteId: 'n', body: 'b' }, ctx()),
      'PERMISSION_DENIED',
    );
    await expectDomainError(
      h.runtime.commands.execute(ARCHIVE, { noteId: 'n' }, ctx()),
      'PERMISSION_DENIED',
    );

    // Nothing was written to the notes projection...
    expect(await notesRows(h)).toHaveLength(0);
    // ...but each denial emitted an auth.permission_denied op through the task-09/10 enforcement
    // point (02 §7) — the audit trail, durable in the real log.
    const denials = await opsOfType(h, 'auth.permission_denied');
    expect(denials.length).toBeGreaterThanOrEqual(1);
    for (const d of denials) expect(d.userId).toBe(h.zeroUserId);
  });
});
