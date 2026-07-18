// schemaVersion-2 mid-history migration (04 §8 box 1; testing-guide §3.2.2).
//
// The v1↔v2 seam is the exit criterion's schema migration: a `notes.note_created` history with v1
// payloads (`{title, body}`) BEFORE a cutover index and v2 (`{title, body, mediaId}`) AFTER. Both an
// incremental apply AND a full rebuild must yield `media_id = null` for v1 notes and the attached id
// for v2 — the applier resolves media by the op's DECLARED version (applier.ts), never by payload
// shape. A v3-or-unknown version REJECTS LOUDLY (no silent skip), because an unfoldable op in an
// append-only log is permanent (05 §7; CLAUDE.md §2.11).
import { sql, type Kysely } from 'kysely';
import { afterEach, describe, expect, test } from 'vitest';

import type { ProjectionOperation } from '@bolusi/core';

import {
  insertOp,
  MEDIA_A,
  noteId,
  op,
  openClientEngine,
  type ClientEngine,
} from './support/engines.js';

let eng: ClientEngine | null = null;
afterEach(async () => {
  await eng?.close();
  eng = null;
});

interface NoteReadRow {
  id: string;
  mediaId: string | null;
  body: string;
  editCount: number;
  archived: number;
}

async function readNotes(db: Kysely<never>): Promise<Map<string, NoteReadRow>> {
  const rows = await sql<NoteReadRow>`
    SELECT id, media_id AS "mediaId", body, edit_count AS "editCount", archived FROM notes
  `.execute(db);
  return new Map(rows.rows.map((r) => [r.id, r]));
}

const V1 = noteId(1); // created before the cutover — no media, ever
const V2 = noteId(2); // created after the cutover — carries a mediaId

/** A history straddling the v1→v2 cutover (testing-guide §3.2.2). */
function history(): ProjectionOperation[] {
  return [
    // ── pre-cutover: v1 ──────────────────────────────────────────────────────────────────────
    op(
      {
        type: 'notes.note_created',
        entityType: 'note',
        entityId: V1,
        schemaVersion: 1,
        payload: { title: 'Lama', body: 'awal' },
      },
      1,
    ),
    op(
      {
        type: 'notes.note_body_edited',
        entityType: 'note',
        entityId: V1,
        payload: { body: 'v1 edit' },
      },
      2,
    ),
    // ── post-cutover: v2 (adds mediaId) ──────────────────────────────────────────────────────
    op(
      {
        type: 'notes.note_created',
        entityType: 'note',
        entityId: V2,
        schemaVersion: 2,
        payload: { title: 'Baru', body: 'isi', mediaId: MEDIA_A },
      },
      3,
    ),
    op(
      {
        type: 'notes.note_body_edited',
        entityType: 'note',
        entityId: V2,
        payload: { body: 'v2 edit' },
      },
      4,
    ),
  ];
}

describe('schemaVersion-2 mid-history migration (04 §8 box 1)', () => {
  test('INCREMENTAL apply: v1 note → media_id null, v2 note → the attached id', async () => {
    eng = await openClientEngine();
    for (const o of history()) {
      await insertOp(eng.db, o);
      const outcome = await eng.engine.applyAppendedOp(o);
      expect(outcome.mode, `${o.type} must be folded, not skipped`).not.toBe('unregistered');
    }

    const notes = await readNotes(eng.db);
    expect(notes.get(V1)?.mediaId).toBeNull(); // v1 predates the attachment
    expect(notes.get(V2)?.mediaId).toBe(MEDIA_A); // v2 carried it
    expect(notes.get(V1)?.editCount).toBe(1);
    expect(notes.get(V2)?.editCount).toBe(1);
  });

  test('FULL REBUILD yields the same rows (04 §8 box 4 — rebuild == incremental)', async () => {
    eng = await openClientEngine();
    for (const o of history()) {
      await insertOp(eng.db, o);
      await eng.engine.applyAppendedOp(o);
    }
    const incremental = await readNotes(eng.db);

    // Drop + replay the whole log in canonical order (04 §4.3). The rebuild reads historical v1
    // payloads from the log and must fold them exactly as the incremental apply did.
    const outcome = await eng.engine.rebuild('notes');
    expect(outcome.appliedCount).toBe(4);
    expect(outcome.complete).toBe(true);
    const rebuilt = await readNotes(eng.db);

    expect(rebuilt.get(V1)?.mediaId).toBeNull();
    expect(rebuilt.get(V2)?.mediaId).toBe(MEDIA_A);
    // Byte-for-byte the same as the incremental fold — a v1 op mis-read as v2 on rebuild would show
    // here (media_id would flip to the payload's absent field / undefined).
    expect([...rebuilt.entries()]).toStrictEqual([...incremental.entries()]);
  });

  test('a v3 (unknown) note_created REJECTS LOUDLY — no silent skip (§2.11)', async () => {
    eng = await openClientEngine();
    const v3 = op(
      {
        type: 'notes.note_created',
        entityType: 'note',
        entityId: noteId(9),
        schemaVersion: 3,
        payload: { title: 'Future', body: 'x', mediaId: null, extra: 'unknown-shape' },
      },
      1,
    );
    await insertOp(eng.db, v3);
    // The applier throws rather than defaulting — an unfoldable op must be loud, not a silent hole.
    await expect(eng.engine.applyAppendedOp(v3)).rejects.toThrow(/schemaVersion 3/);
    // And it wrote nothing (the throw propagated out of the fold before any row landed).
    const notes = await readNotes(eng.db);
    expect(notes.size).toBe(0);
  });
});
