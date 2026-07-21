// The `notes` projection appliers (04 §4.1) + its table manifest (§4.4).
//
// An applier is a fold step: pure, deterministic, entity-scoped (04 §4.1), writing ONLY the row
// keyed by the op's `(entityType, entityId)`. Order-independence, idempotent replay, and the
// out-of-order re-fold are the ENGINE's job (§4.2), never the applier's — so these functions never
// compare timestamps to pick a winner and never check arrival order. The engine hands them ops in
// canonical order `(timestamp, deviceId, seq)`; the canonically-latest body simply overwrites,
// which IS last-writer-wins on every engine for every arrival order (the same argument the platform
// `user_prefs` applier documents).
//
// ── THE v1↔v2 SEAM (04 §3 / §8 box 1; testing-guide §3.2.2) ────────────────────────────────────
//
// `note_created` exists at schemaVersion 1 (`{title, body}`) and 2 (`{title, body, mediaId}`). Old
// v1 ops never disappear (05 §7), so the applier folds BOTH forever, switching on the op's
// `schemaVersion` — NOT on the presence of a payload key, because a payload is caller-shaped and the
// version is the registry's authoritative answer (ctx.ts: a handler may not state its own version).
// A v3-or-unknown version REJECTS LOUDLY (throws) rather than silently defaulting: a silent skip
// would leave the projection missing an op it could not fold, on every device, permanently —
// exactly the "silently checks nothing" failure CLAUDE.md §2.11 calls worse than none. The throw
// propagates out of the engine's apply, rolling back the whole op (engine.ts transaction model).
import type { ProjectionApplier, ProjectionTableManifest } from '@bolusi/core';
import type { ProjectionOperation } from '@bolusi/core';
import type { MediaRef } from '@bolusi/schemas';

import { NOTE_ENTITY, NOTES_TABLE } from './constants.js';
import type { NotesDatabase } from './schema.js';

/** `notes.note_created` v1 payload (01 §9). */
export interface NoteCreatedV1Payload {
  readonly title: string;
  readonly body: string;
}

/** `notes.note_created` v2 payload (01 §9) — adds the media attachment (present-and-null, 05 §3). */
export interface NoteCreatedV2Payload {
  readonly title: string;
  readonly body: string;
  readonly mediaId: string | null;
}

/**
 * `notes.note_created` v3 payload (01 §9) — the whole signed `mediaRef` replaces the bare id, so a
 * PULLED note carries the `sha256`/`mime` its photo must be download-verified against (06 §6).
 *
 * One nullable object, not three sibling fields: "media attached with no signed hash" is thereby
 * unrepresentable rather than merely discouraged (operations.ts explains at length).
 */
export interface NoteCreatedV3Payload {
  readonly title: string;
  readonly body: string;
  readonly mediaRef: MediaRef | null;
}

/** What the fold extracts from a `note_created` payload, whatever version wrote it. */
interface NoteMediaColumns {
  readonly mediaId: string | null;
  /** The SIGNED hash — v3 only. Null for v1/v2, which never carried one. */
  readonly mediaSha256: string | null;
  readonly mediaMime: string | null;
}

/** `notes.note_body_edited` v1 payload (01 §9). */
export interface NoteBodyEditedPayload {
  readonly body: string;
}

/**
 * 04 §4.4 table manifest — columns in 10-db DDL order (the oracle's digest order, §3.4), incl. the
 * `edit_count` testability column. `archived` is logical `'boolean'`: the oracle normalizes
 * SQLite's `0/1` and Postgres's `true/false` to the same byte (schema.ts explains why the applier
 * still WRITES `0/1`).
 */
export const notesTable: ProjectionTableManifest = {
  columns: {
    id: 'text',
    tenant_id: 'text',
    store_id: 'text',
    title: 'text',
    body: 'text',
    media_id: 'text',
    media_sha256: 'text',
    media_mime: 'text',
    archived: 'boolean',
    edit_count: 'integer',
    created_by: 'text',
    created_at: 'integer',
    last_edited_by: 'text',
    last_edited_at: 'integer',
  },
  primaryKey: ['id'],
  entityType: NOTE_ENTITY,
  entityIdColumn: 'id',
  projectionVersion: 1,
};

/**
 * A store-scoped op's `storeId` is non-null by construction (01 §9: "all its ops carry that
 * storeId"; the runtime stamps it from the device store, 04 §5.1 step 4, and the server's scope
 * check rejects a mismatch). This asserts it rather than coercing a null into an empty string — a
 * silent `''` store_id would be a permanent, wrong, signed fact in an append-only log (§2.11).
 */
function noteStoreId(op: ProjectionOperation): string {
  if (op.storeId === null) {
    throw new Error(
      `notes applier: ${op.type} on ${op.entityId} carries a null storeId — notes are store-scoped (01 §9). This op should never have been accepted (05 §9 scope check).`,
    );
  }
  return op.storeId;
}

/**
 * Resolve the media columns from a `note_created` op by its DECLARED version — never by payload
 * shape (a payload is caller-shaped; the version is the registry's authoritative answer).
 *
 * Only v3 yields a `mediaSha256`. That asymmetry is the backward-compatibility contract, and it is
 * deliberate rather than a gap: a v2 op never carried a hash, and there is nowhere honest to get one
 * from now. Back-filling it from the local `media_items` row would be actively harmful — it would
 * let a render-time check verify the file against a value an attacker with local DB access could
 * have rewritten to match a substituted file, i.e. verify the file against itself (the argument
 * core/src/media/download.ts makes at length). So v1/v2 stay null, and the reader treats a null hash
 * as "local-only, never fetch-and-claim-verified".
 */
function mediaForCreated(op: ProjectionOperation): NoteMediaColumns {
  switch (op.schemaVersion) {
    case 1:
      // v1 predates the attachment (01 §9) — no media, ever.
      return { mediaId: null, mediaSha256: null, mediaMime: null };
    case 2: {
      // v2 carried the id but no signed hash — resolvable only via local_path (06 §6).
      const payload = op.payload as unknown as NoteCreatedV2Payload;
      return { mediaId: payload.mediaId, mediaSha256: null, mediaMime: null };
    }
    case 3: {
      const ref = (op.payload as unknown as NoteCreatedV3Payload).mediaRef;
      if (ref === null) return { mediaId: null, mediaSha256: null, mediaMime: null };
      // Complete by construction — the payload schema admits no ref missing `sha256`/`mime`.
      return { mediaId: ref.mediaId, mediaSha256: ref.sha256, mediaMime: ref.mime };
    }
    default:
      throw new Error(
        `notes.note_created is at schemaVersion ${op.schemaVersion}, which this applier does not fold (04 §3/§8). A module must handle every historical version forever (05 §7); bump the applier BEFORE emitting a new version, never after — an unfoldable op in an append-only log is permanent. Rejecting loudly rather than silently skipping (CLAUDE.md §2.11).`,
      );
  }
}

/** Fold `notes.note_created` (v1 or v2) → a fresh `notes` row. */
export const noteCreatedApplier: ProjectionApplier<NotesDatabase> = async (db, op) => {
  const payload = op.payload as unknown as NoteCreatedV1Payload;
  const media = mediaForCreated(op);
  await db
    .insertInto('notes')
    .values({
      id: op.entityId,
      tenantId: op.tenantId,
      storeId: noteStoreId(op),
      title: payload.title,
      body: payload.body,
      mediaId: media.mediaId,
      mediaSha256: media.mediaSha256,
      mediaMime: media.mediaMime,
      archived: 0,
      // A fresh note has zero body edits — creation is not an edit (01 §9: edit_count counts
      // note_body_edited applies). A re-fold replays create-then-edits, recomputing this from 0.
      editCount: 0,
      createdBy: op.userId,
      createdAt: op.timestamp,
      // Seeded from creation; the canonically-latest body edit overwrites it (01 §9).
      lastEditedBy: op.userId,
      lastEditedAt: op.timestamp,
    })
    .execute();
};

/**
 * Fold `notes.note_body_edited` → overwrite body, count the edit, advance last-edited.
 *
 * UPDATE (not upsert): the row exists because create sorts canonically before any edit for the
 * entity (you cannot edit before creating), and the engine folds in canonical order. If an edit is
 * ever folded before its create (a pull delivering the edit first), the UPDATE matches nothing — a
 * safe no-op — and the create's later arrival triggers an entity re-fold that replays both in
 * order. It does NOT touch `archived`: an edit accepted for a concurrently-archived note still lands
 * (01 §9 — that concurrency is flagged server-side by the Rule-2 check, never dropped here).
 */
export const noteBodyEditedApplier: ProjectionApplier<NotesDatabase> = async (db, op) => {
  const payload = op.payload as unknown as NoteBodyEditedPayload;
  await db
    .updateTable('notes')
    .set((eb) => ({
      body: payload.body,
      // +1 per applied edit (01 §9 testability) — the oracle digests it, so a double-application
      // (which would fail idempotency) becomes visible rather than hiding behind pure LWW.
      editCount: eb('editCount', '+', 1),
      lastEditedBy: op.userId,
      lastEditedAt: op.timestamp,
    }))
    .where('id', '=', op.entityId)
    .execute();
};

/**
 * Fold `notes.note_archived` → mark archived (terminal; no unarchive in v0, 01 §9).
 *
 * Writes `1` (see schema.ts for why not `true`). Does not touch `last_edited_*` — archiving is not
 * a body edit. UPDATE-matches-nothing is a safe no-op for the same out-of-order reason as edits.
 */
export const noteArchivedApplier: ProjectionApplier<NotesDatabase> = async (db, op) => {
  await db.updateTable('notes').set({ archived: 1 }).where('id', '=', op.entityId).execute();
};

/** Re-exported for the manifest's table map keyed by table name. */
export const NOTES_TABLE_NAME = NOTES_TABLE;
