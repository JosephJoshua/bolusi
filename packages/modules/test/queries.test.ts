// The `notes` queries (04 §6 / §8 box 5) — cursor pagination, the archived filter, `getNote`, the
// query-level permission-denial floor (an explicit error, never `{rows: []}` — FR-1036), and the
// live-query invalidation, all driven through the REAL query runtime + projection engine.
import { afterEach, describe, expect, test } from 'vitest';

import { DomainError } from '@bolusi/core';
import type { SignedOperation } from '@bolusi/schemas';

import { notesModule, type NoteRow } from '../src/notes/index.js';
import { openHarness, type Harness } from './support/harness.js';

const LIST = notesModule.queries.listNotes;
const GET = notesModule.queries.getNote;

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const CREATE = notesModule.commands.createNote;

async function seedNotes(harness: Harness, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const outcome = await harness.runtime.commands.execute(
      CREATE,
      { title: `note ${i}`, body: `body ${i}` },
      harness.runtime.commands.createContext(harness.notesUserId),
    );
    ids.push((outcome.result as { noteId: string }).noteId);
  }
  return ids;
}

function list(
  harness: Harness,
  input: Record<string, unknown>,
  userId?: string,
): Promise<{ rows: readonly NoteRow[]; nextCursor: string | null }> {
  return harness.runtime.queries.execute(
    LIST,
    input,
    harness.identity(userId ?? harness.notesUserId),
  );
}

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

describe('listNotes pagination + filter (04 §8 box 5)', () => {
  test('cursor walk over > 2 pages: no dups, no omissions, createdAt.desc default, terminates', async () => {
    h = await openHarness(1);
    const created = await seedNotes(h, 5);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: { rows: readonly NoteRow[]; nextCursor: string | null } = await list(h, {
        limit: 2,
        ...(cursor === null ? {} : { cursor }),
      });
      seen.push(...page.rows.map((r) => r.id));
      cursor = page.nextCursor;
      pages += 1;
      expect(pages).toBeLessThanOrEqual(10); // guard against a non-terminating walk
    } while (cursor !== null);

    expect(pages).toBe(3); // 2 + 2 + 1
    expect(new Set(seen).size).toBe(5); // no dups
    expect([...seen].sort()).toStrictEqual([...created].sort()); // no omissions
    // createdAt.desc default: the last-created note comes first.
    expect(seen[0]).toBe(created[4]);
    expect(seen[4]).toBe(created[0]);
  });

  test('archived notes are excluded by default and included with the filter', async () => {
    h = await openHarness(2);
    const ids = await seedNotes(h, 3);
    await h.runtime.commands.execute(
      notesModule.commands.archiveNote,
      { noteId: ids[1] },
      h.runtime.commands.createContext(h.notesUserId),
    );

    const active = await list(h, { limit: 50 });
    expect(active.rows.map((r) => r.id).sort()).toStrictEqual([ids[0], ids[2]].sort());
    expect(active.rows.every((r) => !r.archived)).toBe(true);

    const withArchived = await list(h, { limit: 50, filter: { archived: true } });
    expect(withArchived.rows.map((r) => r.id).sort()).toStrictEqual([...ids].sort());
    expect(withArchived.rows.find((r) => r.id === ids[1])?.archived).toBe(true);
  });

  test('limit > 100 → VALIDATION_FAILED (schema .max(100)); the handler never runs', async () => {
    h = await openHarness(3);
    await expectDomainError(list(h, { limit: 101 }), 'VALIDATION_FAILED');
  });
});

describe('getNote (04 §8 box 5)', () => {
  test('returns the row for an existing note; ENTITY_NOT_FOUND otherwise', async () => {
    h = await openHarness(4);
    const [id] = await seedNotes(h, 1);
    const page = await h.runtime.queries.execute(GET, { noteId: id }, h.identity(h.notesUserId));
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]!.id).toBe(id);
    expect(page.nextCursor).toBeNull();

    await expectDomainError(
      h.runtime.queries.execute(GET, { noteId: 'no-such' }, h.identity(h.notesUserId)),
      'ENTITY_NOT_FOUND',
    );
  });
});

describe('query permission-denial floor (04 §8 box 2 — never {rows: []})', () => {
  test('a zero-grant user: listNotes AND getNote → PERMISSION_DENIED, not an empty page', async () => {
    h = await openHarness(5);
    await seedNotes(h, 2); // rows EXIST — so an empty page would be a real (wrong) possibility

    const listErr = await expectDomainError(
      list(h, { limit: 50 }, h.zeroUserId),
      'PERMISSION_DENIED',
    );
    // Explicitly NOT `{rows: []}` — the FR-1036 leak the whole rule exists to prevent.
    expect(listErr).not.toMatchObject({ rows: [] });

    await expectDomainError(
      h.runtime.queries.execute(GET, { noteId: 'anything' }, h.identity(h.zeroUserId)),
      'PERMISSION_DENIED',
    );
  });
});

describe('live-query invalidation (04 §7 / §8 box 5 — headless)', () => {
  test('a pulled remote op invalidates `notes` and the subscribed query re-emits with the row', async () => {
    h = await openHarness(6);
    const before = await list(h, { limit: 50 });
    expect(before.rows).toHaveLength(0);

    // Subscribe to the projection invalidation bus — the seam a live `useQuery` re-runs on (04 §7).
    // No UI, no polling: the assertion is the emission itself (asserted "without UI polling").
    let firedTables: ReadonlySet<string> | null = null;
    const unsubscribe = h.invalidation.subscribe((tables) => {
      firedTables = tables;
    });

    // A remote note arrives via the PULL path (another device's op), scoped to this store.
    const remote = remoteNoteCreated(h, {
      id: '01920000-0000-7000-8000-00000000e001',
      title: 'from another device',
      body: 'pulled',
      timestamp: 1_726_000_500_000,
    });
    await h.deliverPulled(remote, 1);
    unsubscribe();

    // The invalidation fired for the notes projection table (04 §7 per-table granularity).
    expect(firedTables).not.toBeNull();
    expect([...(firedTables ?? new Set())]).toContain('notes');

    // And the subscribed query, re-run, now returns the new row (the live-update payload).
    const after = await list(h, { limit: 50 });
    expect(after.rows.map((r) => r.id)).toStrictEqual([remote.entityId]);
    expect(after.rows[0]!.title).toBe('from another device');
  });
});

/** A foreign-device `notes.note_created` v2 op, scoped to the harness tenant+store (fake-signed —
 *  `applyPulledOp` folds; the client signature check is the sync layer's, not the engine's). */
function remoteNoteCreated(
  harness: Harness,
  spec: { id: string; title: string; body: string; timestamp: number },
): SignedOperation {
  return {
    id: `op-remote-${spec.id.slice(-6)}`,
    tenantId: harness.tenantId,
    storeId: harness.storeId,
    userId: '01920000-0000-7000-8000-0000000e00c1',
    deviceId: '01920000-0000-7000-8000-0000000d00c1',
    seq: 1,
    type: 'notes.note_created',
    entityType: 'note',
    entityId: spec.id,
    schemaVersion: 2,
    payload: { title: spec.title, body: spec.body, mediaId: null },
    timestamp: spec.timestamp,
    location: null,
    source: 'ui',
    agentInitiated: false,
    agentConversationId: null,
    previousHash: '0'.repeat(64),
    hash: '1'.repeat(64),
    signature: 'remote-sig',
  } as SignedOperation;
}
