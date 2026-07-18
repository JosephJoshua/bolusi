// THE BOTH-ENGINE RULE for the `notes` module (testing-guide T-8 / 04 §2).
//
// T-8: every module's appliers run through the shared applier conformance suite against BOTH engines
// (better-sqlite3 + PGlite), oracle-digest-equal — "a module without this suite passing does not
// merge". These appliers run on the SERVER (Postgres, in the push transaction) and every DEVICE
// (SQLite) over the same signed ops; if they disagreed, a phone and the server would hold different
// answers derived from identical hash-chained history.
//
// This is a DIALECT gate, not a correctness gate (T-14f / T-8's own scope note): PGlite is not the
// production `pg` client, and the oracle compares the two engines to EACH OTHER, so it is blind to
// anything both fold identically wrong. The `archived` boolean is exactly the column where two
// engines most plausibly diverge (SQLite 0/1 vs Postgres true/false), which is why the script
// archives a note. The SEMANTICS (what the fold should CONTAIN) are asserted separately below and in
// migration.test.ts / convergence.test.ts, and the real-`pg` marshalling by the server suite.
import { describe, expect, test } from 'vitest';

import { noblePort, runApplierConformance } from '@bolusi/test-support';
import type { SignedOperation } from '@bolusi/schemas';

import { notesModule } from '../src/notes/index.js';
import type { AnyModuleDefinition } from '@bolusi/core';
import {
  countNotes,
  insertOp,
  MEDIA_A,
  noteId,
  op,
  openEngines,
  USER_A,
} from './support/engines.js';

const notes = notesModule as unknown as AnyModuleDefinition<never>;
const A = noteId(1);
const B = noteId(2);

/**
 * A deterministic script exercising EVERY notes applier and every writing branch:
 *  - `note_created` at schemaVersion 2 (mediaId set) AND 1 (no mediaId) — the v1↔v2 fold seam;
 *  - two body edits on A — the LWW overwrite + `edit_count` increment;
 *  - archiving A — the `archived` boolean (the classic cross-engine divergence);
 *  - a body edit on B — an edit that lands on an active note.
 * Ends with 2 notes rows: the T-14 denominator asserted below.
 */
function script(): SignedOperation[] {
  return [
    op(
      {
        type: 'notes.note_created',
        entityType: 'note',
        entityId: A,
        schemaVersion: 2,
        payload: { title: 'Stok kopi', body: 'awal', mediaId: MEDIA_A },
      },
      1,
    ),
    op(
      {
        type: 'notes.note_created',
        entityType: 'note',
        entityId: B,
        // schemaVersion 1 (default) — a pre-cutover note with NO media (01 §9).
        payload: { title: 'Catatan lama', body: 'isi' },
      },
      2,
    ),
    op(
      {
        type: 'notes.note_body_edited',
        entityType: 'note',
        entityId: A,
        userId: USER_A,
        payload: { body: 'edit-1' },
      },
      3,
    ),
    op(
      {
        type: 'notes.note_body_edited',
        entityType: 'note',
        entityId: A,
        payload: { body: 'edit-2 (canonically-later wins)' },
      },
      4,
    ),
    op({ type: 'notes.note_archived', entityType: 'note', entityId: A, payload: {} }, 5),
    op(
      {
        type: 'notes.note_body_edited',
        entityType: 'note',
        entityId: B,
        payload: { body: 'B edited' },
      },
      6,
    ),
  ];
}

describe('notes applier conformance: SQLite vs Postgres (T-8 / 04 §2)', () => {
  test('the same op script folds to byte-identical oracle digests on both engines', async () => {
    const engines = await openEngines();
    try {
      const result = await runApplierConformance<never>({
        engines: [
          { name: 'sqlite', db: engines.sqliteDb },
          { name: 'postgres', db: engines.pgDb },
        ],
        module: notes,
        ops: script(),
        hash: (data: Uint8Array) => noblePort.sha256(data),
        insertOp,
        countRows: countNotes,
      });

      // THE DENOMINATOR (T-14), pinned rather than assumed — two empty projections digest
      // identically, so equality alone would prove nothing. 6 ops in, 2 rows out (edits/archive fold
      // into existing rows).
      expect(result.opsApplied).toBe(6);
      expect(result.rowCounts.get('sqlite')).toBe(2);
      expect(result.rowCounts.get('postgres')).toBe(2);

      expect(result.digests.get('sqlite')).toBe(result.digests.get('postgres'));
      expect(result.digests.get('sqlite')).toMatch(/^[0-9a-f]{16,}/);
    } finally {
      await engines.close();
    }
  });

  test('the fold produced the SEMANTICS the digests agree on (the oracle blind spot, T-8 (c))', async () => {
    // A digest-equality gate proves the engines AGREE; two identically-wrong appliers pass it. So
    // read the rows back and assert 01 §9's facts directly, on one engine.
    const engines = await openEngines();
    try {
      await runApplierConformance<never>({
        engines: [
          { name: 'sqlite', db: engines.sqliteDb },
          { name: 'postgres', db: engines.pgDb },
        ],
        module: notes,
        ops: script(),
        hash: (data: Uint8Array) => noblePort.sha256(data),
        insertOp,
        countRows: countNotes,
      });

      // Read from PGlite: `archived` comes back as a real boolean there, `media_id` for the v1 note
      // is NULL, and `edit_count` counts BOTH edits on A.
      const rows = await engines.pgDb
        .selectFrom('notes' as never)
        .selectAll()
        .execute();
      const byId = new Map(
        rows.map((r) => [(r as { id: string }).id, r as Record<string, unknown>]),
      );

      const a = byId.get(A)!;
      expect(a.body).toBe('edit-2 (canonically-later wins)'); // LWW: canonically-later body wins
      expect(a.editCount).toBe(2); // both edits counted (01 §9 testability)
      expect(a.archived).toBe(true); // Postgres boolean
      expect(a.mediaId).toBe(MEDIA_A); // v2 payload carried the attachment

      const b = byId.get(B)!;
      expect(b.mediaId).toBeNull(); // v1 note: NO media, ever (applier v1 branch)
      expect(b.editCount).toBe(1);
      expect(b.archived).toBe(false);
    } finally {
      await engines.close();
    }
  });
});
