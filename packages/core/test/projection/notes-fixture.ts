// The reference `notes` module as a projection fixture (04 §8; testing-guide §3.2), plus a
// seeded op-script generator with same-entity cross-device contention and the schemaVersion:2
// migration seam. The real manifest lands in @bolusi/modules (task 11); this is the harness
// workload for the engine's unit-level convergence tests (precursors to CHAOS-01/06/07/08).
//
// The applier writes camelCase through the CamelCasePlugin-wired ProjectionDb (04 §2), exactly
// as a real applier will. `edit_count` increments per edit so the oracle can SEE any
// double-application (testing-guide §3.2) — a last-write-wins-only table could not.
import type { ClientDatabase } from '@bolusi/db-client';
import type { SignedOperation } from '@bolusi/schemas';
import { mulberry32, type Prng } from '@bolusi/test-support';

import {
  cursorOf,
  type CanonicalCursor,
  type ModuleProjectionManifest,
  type ProjectionApplier,
  type ProjectionTableManifest,
} from '../../src/index.js';

type NotesDb = ClientDatabase;

interface CreatePayload {
  readonly title: string;
  readonly body: string;
  readonly mediaId?: string | null;
}
interface EditPayload {
  readonly body: string;
}

const createApplier: ProjectionApplier<NotesDb> = async (db, op) => {
  const payload = op.payload as unknown as CreatePayload;
  await db
    .insertInto('notes')
    .values({
      id: op.entityId,
      tenantId: op.tenantId,
      storeId: op.storeId ?? '',
      title: payload.title,
      body: payload.body,
      mediaId: payload.mediaId ?? null, // schemaVersion 2 carries mediaId; v1 does not (04 §3)
      archived: 0,
      editCount: 0,
      createdBy: op.userId,
      createdAt: op.timestamp,
      lastEditedBy: op.userId,
      lastEditedAt: op.timestamp,
    })
    .execute();
};

const editApplier: ProjectionApplier<NotesDb> = async (db, op) => {
  const payload = op.payload as unknown as EditPayload;
  // UPDATE on a not-yet-created note affects 0 rows — a deterministic no-op, so an edit that
  // arrives before its create is lost identically on the incremental and canonical-fold paths
  // (the re-fold re-runs the full history once create arrives).
  await db
    .updateTable('notes')
    .set((eb) => ({
      body: payload.body,
      editCount: eb('editCount', '+', 1),
      lastEditedBy: op.userId,
      lastEditedAt: op.timestamp,
    }))
    .where('id', '=', op.entityId)
    .execute();
};

const archiveApplier: ProjectionApplier<NotesDb> = async (db, op) => {
  await db.updateTable('notes').set({ archived: 1 }).where('id', '=', op.entityId).execute();
};

/**
 * The `notes` projection manifest. Columns are declared in 10-db §9.6 DDL order (the oracle's
 * digest order, §3.4); `archived` is `integer` per 04 §4.4 (SQLite stores 0/1).
 */
/** The `notes` table manifest (10-db §9.6 DDL column order). */
export const notesTable: ProjectionTableManifest = {
  columns: {
    id: 'text',
    tenant_id: 'text',
    store_id: 'text',
    title: 'text',
    body: 'text',
    media_id: 'text',
    archived: 'integer',
    edit_count: 'integer',
    created_by: 'text',
    created_at: 'integer',
    last_edited_by: 'text',
    last_edited_at: 'integer',
  },
  primaryKey: ['id'],
  entityType: 'note',
  entityIdColumn: 'id',
  projectionVersion: 1,
};

export const notesModule: ModuleProjectionManifest<NotesDb> = {
  id: 'notes',
  tables: { notes: notesTable },
  appliers: {
    'notes.note_created': createApplier,
    'notes.note_body_edited': editApplier,
    'notes.note_archived': archiveApplier,
  },
};

/** A `notes` manifest with a bumped table projectionVersion — forces rebuild (04 §4.4). */
export function notesModuleAtVersion(version: number): ModuleProjectionManifest<NotesDb> {
  return {
    ...notesModule,
    tables: { notes: { ...notesTable, projectionVersion: version } },
  };
}

/** One applier observation: which op an applier folded, and its canonical position. */
export interface AppliedObservation {
  readonly id: string;
  readonly entityId: string;
  readonly type: string;
  readonly cursor: CanonicalCursor;
}

/**
 * A `notes` manifest whose appliers RECORD every op they fold — proving the engine never
 * hands an applier out-of-order input, and letting a rebuild test assert nothing at or below
 * the resume cursor is re-applied.
 */
export function makeRecordingNotesModule(): {
  module: ModuleProjectionManifest<NotesDb>;
  observed: AppliedObservation[];
} {
  const observed: AppliedObservation[] = [];
  const appliers: Record<string, ProjectionApplier<NotesDb>> = {};
  for (const [type, applier] of Object.entries(notesModule.appliers)) {
    appliers[type] = async (db, op) => {
      observed.push({ id: op.id, entityId: op.entityId, type: op.type, cursor: cursorOf(op) });
      await applier(db, op);
    };
  }
  return { module: { ...notesModule, appliers }, observed };
}

/** An op paired with the serverSeq it would carry when pulled (null for a local append). */
export interface GeneratedOp {
  readonly op: SignedOperation;
  readonly serverSeq: number | null;
}

/** Build one `notes` op with an explicit canonical position — for hand-crafted scenarios. */
export function makeNoteOp(over: {
  id: string;
  entityId: string;
  type: string;
  timestamp: number;
  deviceId: string;
  seq: number;
  payload?: Record<string, unknown>;
  schemaVersion?: number;
}): SignedOperation {
  return {
    id: over.id,
    tenantId: 'tenant-fixed',
    storeId: 'store-fixed',
    userId: `user-${over.deviceId}`,
    deviceId: over.deviceId,
    seq: over.seq,
    type: over.type,
    entityType: 'note',
    entityId: over.entityId,
    schemaVersion: over.schemaVersion ?? 1,
    payload: (over.payload ?? {}) as SignedOperation['payload'],
    timestamp: over.timestamp,
    location: null,
    source: 'ui',
    agentInitiated: false,
    agentConversationId: null,
    previousHash: '0'.repeat(64),
    hash: over.id.padEnd(64, '0'),
    signature: `sig-${over.id}`,
  };
}

const HEX = '0123456789abcdef';
/** A deterministic 64-hex placeholder — the projection engine never verifies it (that is the
 * sync/verify layer's job, 05 §8); it exists only to satisfy the NOT NULL columns. */
function hex64(n: number): string {
  let s = n.toString(16);
  while (s.length < 64) s = HEX[(n + s.length) % 16] + s;
  return s.slice(0, 64);
}

function pickBiasedRecent(prng: Prng, entities: readonly string[]): string {
  // 30% biased toward the 5 most recent entities — forces same-entity contention (§3.3).
  const recentStart = Math.max(0, entities.length - 5);
  const pool = prng() < 0.3 ? entities.slice(recentStart) : entities;
  const index = Math.floor(prng() * pool.length);
  return pool[index] as string;
}

export interface GenerateOptions {
  readonly deviceCount?: number;
  readonly opsPerDevice?: number;
  /** Ops at or after this global index create v2 (media-bearing) notes (schemaVersion seam). */
  readonly cutoverIndex?: number;
  readonly tenantId?: string;
  readonly storeId?: string;
}

/**
 * Deterministic op script: `deviceCount` devices round-robin, each op advancing that device's
 * clock by 1–600 s, editing/archiving notes from a shared pool (biased recent) so the SAME
 * entity is contended across devices. Reproduces bit-for-bit from `seed` (T-6). Timestamps
 * interleave across devices, so a shuffled arrival order forces both §4.2 paths.
 */
export function generateNotesScript(seed: number, options: GenerateOptions = {}): GeneratedOp[] {
  const deviceCount = options.deviceCount ?? 3;
  const opsPerDevice = options.opsPerDevice ?? 40;
  const total = deviceCount * opsPerDevice;
  const cutoverIndex = options.cutoverIndex ?? Math.floor(total / 2);
  const tenantId = options.tenantId ?? `tenant-${seed}`;
  const storeId = options.storeId ?? `store-${seed}`;

  const prng = mulberry32(seed);
  const deviceIds = Array.from({ length: deviceCount }, (_, d) => `dev-${seed}-${d}`);
  const userIds = Array.from({ length: deviceCount }, (_, d) => `user-${seed}-${d}`);
  const seqByDevice = new Array<number>(deviceCount).fill(0);
  // Staggered start clocks so cross-device timestamps interleave rather than block by device.
  const clockByDevice = deviceIds.map((_, d) => 1_726_000_000_000 + d * 137);

  const entities: string[] = [];
  const ops: GeneratedOp[] = [];

  for (let i = 0; i < total; i += 1) {
    const d = i % deviceCount;
    clockByDevice[d] = (clockByDevice[d] as number) + (1 + Math.floor(prng() * 600)) * 1000;
    seqByDevice[d] = (seqByDevice[d] as number) + 1;
    const roll = prng();

    let type: string;
    let entityId: string;
    let schemaVersion = 1;
    let payload: Record<string, unknown>;

    if (entities.length === 0 || roll < 0.2) {
      entityId = `note-${seed}-${entities.length}`;
      entities.push(entityId);
      type = 'notes.note_created';
      if (i >= cutoverIndex) {
        schemaVersion = 2;
        payload = {
          title: `t-${seed}-${i}`,
          body: `b-${seed}-${i}`,
          mediaId: `media-${seed}-${i}`,
        };
      } else {
        payload = { title: `t-${seed}-${i}`, body: `b-${seed}-${i}` };
      }
    } else if (roll < 0.8) {
      entityId = pickBiasedRecent(prng, entities);
      type = 'notes.note_body_edited';
      payload = { body: `edit-${seed}-${i}` };
    } else {
      entityId = pickBiasedRecent(prng, entities);
      type = 'notes.note_archived';
      payload = {};
    }

    const op: SignedOperation = {
      id: `op-${seed}-${i}`,
      tenantId,
      storeId,
      userId: userIds[d] as string,
      deviceId: deviceIds[d] as string,
      seq: seqByDevice[d] as number,
      type,
      entityType: 'note',
      entityId,
      schemaVersion,
      payload: payload as SignedOperation['payload'],
      timestamp: clockByDevice[d] as number,
      location: null,
      source: 'ui',
      agentInitiated: false,
      agentConversationId: null,
      previousHash: '0'.repeat(64),
      hash: hex64(i + 1),
      signature: `sig-${seed}-${i}`,
    };
    ops.push({ op, serverSeq: null });
  }

  return ops;
}
