/**
 * Test support for the notes-module screen tests (task 96). Lives under `test/` because it imports
 * the notes L2 harness (`packages/modules/test/support/harness.ts` → better-sqlite3), which is
 * test-only and may not appear in shipping source (08 §2.5).
 *
 * It provides three things the mounted-screen tests share:
 *   - `registerNotesCatalog` wiring, so `notes.*` labels resolve (the catalog is a module catalog
 *     merged at runtime, 07-i18n §3.3 — the mobile test setup only boots the reserved catalogs).
 *   - a REAL `NotesRuntime` over the harness, for the "unauthorized ≠ empty" and live-update proofs.
 *   - a FAKE `NotesRuntime` with per-test overrides, for the optimistic-save and danger-banner proofs
 *     where controlling timing / op-status directly is cleaner than staging a rejection in the DB.
 */
import idCatalog from '@bolusi/modules/notes/i18n/id.json';
import enCatalog from '@bolusi/modules/notes/i18n/en.json';
import {
  NotesRuntimeProvider,
  registerNotesCatalog,
  type NotesRuntime,
} from '@bolusi/modules/notes/screens';
import type { NoteRow } from '@bolusi/modules/notes';
import type { QueryPage } from '@bolusi/core';
import type { SignedOperation } from '@bolusi/schemas';
import type { ReactElement } from 'react';

import { openHarness, type Harness } from '../../../packages/modules/test/support/harness.js';
import { fire, render, type RenderResult } from '../../../packages/ui/test/render.js';
import { createNotesRuntime, readNoteSyncStatuses } from '../src/screens/notes/runtime-adapter.js';

/** Merge the shipped notes catalog into the running i18n instance (idempotent). */
export function ensureNotesCatalog(): void {
  registerNotesCatalog({ id: idCatalog, en: enCatalog });
}

export { openHarness, type Harness };
export { render, fire, NotesRuntimeProvider };
export type { RenderResult };

/** One page result, the shape `listNotes`/`getNote` return (04 §6). */
export function page(
  rows: readonly NoteRow[],
  nextCursor: string | null = null,
): QueryPage<NoteRow> {
  return { rows, nextCursor };
}

/**
 * A complete signed `mediaRef` (06 §3.2) — ONE definition for every notes screen test (§2.8).
 *
 * Complete on purpose: at schemaVersion 3 a note either has no attachment or a whole signed ref, so
 * a fixture carrying a bare id would not typecheck — which is the schema doing its job.
 */
export const TEST_MEDIA_REF = {
  mediaId: '01920000-0000-7000-8000-0000000f0099',
  sha256: 'd'.repeat(64),
  mime: 'image/jpeg',
  type: 'image',
  sizeBytes: 231_044,
  capturedAt: 1_726_000_000_000,
  location: null,
  userId: '01920000-0000-7000-8000-0000000e000a',
  deviceId: '01920000-0000-7000-8000-0000000d000a',
} as const;

export interface HarnessRuntimeOverrides {
  readonly capturePhoto?: NotesRuntime['capturePhoto'];
  readonly loadThumbnail?: NotesRuntime['loadThumbnail'];
}

/** A REAL `NotesRuntime` over the harness, scoped to `userId`. Media seams default to inert. */
export function harnessRuntime(
  h: Harness,
  userId: string,
  overrides: HarnessRuntimeOverrides = {},
): NotesRuntime {
  return createNotesRuntime({
    runtime: h.runtime,
    invalidation: h.invalidation,
    identity: h.identity(userId),
    noteSyncStatuses: (ids) => readNoteSyncStatuses(h.db, ids),
    capturePhoto: overrides.capturePhoto ?? (() => Promise.resolve(null)),
    loadThumbnail: overrides.loadThumbnail ?? (() => Promise.resolve({ kind: 'unavailable' })),
  });
}

/** A FAKE `NotesRuntime` with sensible defaults; override only what a test drives. */
export function fakeRuntime(overrides: Partial<NotesRuntime> = {}): NotesRuntime {
  return {
    listNotes: () => Promise.resolve(page([])),
    getNote: () => Promise.resolve(page([])),
    createNote: () => Promise.resolve({ noteId: 'note-fake' }),
    editNoteBody: () => Promise.resolve({ noteId: 'note-fake' }),
    archiveNote: () => Promise.resolve({ noteId: 'note-fake' }),
    noteSyncStatuses: () => Promise.resolve({}),
    subscribe: () => () => undefined,
    hasPermission: () => false,
    capturePhoto: () => Promise.resolve(null),
    loadThumbnail: () => Promise.resolve({ kind: 'unavailable' }),
    ...overrides,
  };
}

/** Render `screen` inside a provider bound to `runtime` — a MOUNTED screen (task 69 / §2.11). */
export function renderNotes(runtime: NotesRuntime, screen: ReactElement): RenderResult {
  ensureNotesCatalog();
  return render(<NotesRuntimeProvider runtime={runtime}>{screen}</NotesRuntimeProvider>);
}

/**
 * A foreign-device `notes.note_created` v2 op, scoped to the harness tenant+store, for the pull-path
 * live-update proof (the same shape task 25's headless test uses — `applyPulledOp` folds it; the
 * client signature check is the sync layer's, not the engine's).
 */
export function remoteNoteCreated(
  h: Harness,
  spec: {
    readonly id: string;
    readonly title: string;
    readonly body: string;
    readonly timestamp: number;
  },
): SignedOperation {
  return {
    id: `op-remote-${spec.id.slice(-6)}`,
    tenantId: h.tenantId,
    storeId: h.storeId,
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
