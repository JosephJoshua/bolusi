// The convergence oracle (testing-guide §3.4), built ON task-08's `digestModule` — consumed, never
// reimplemented (§2.8/T-7). Convergence = every device's notes-projection digest byte-equal to the
// CANONICAL-FOLD REFERENCE: a fresh engine fed all ops strictly in `(timestamp, deviceId, seq)`
// order (05 §4). The reference proves the answer the disordered replicas must all reach.
//
// Two guards make a green MEAN something (§2.11): `assertConvergence` fails-loud with the first
// differing row when a replica diverges (never a bare boolean), and `assertBothFoldPaths` fails a
// run that did not exercise BOTH §4.2 dispatch paths — a convergence "pass" that only ever
// head-applied has not tested re-fold and is INCONCLUSIVE, not green (CHAOS-01's own rule).
import { sql } from 'kysely';

import {
  createProjectionEngine,
  digestModule,
  ProjectionStats,
  registerModules,
  sortCanonical,
  type AnyModuleDefinition,
  type ProjectionStatsSnapshot,
} from '@bolusi/core';
import type { ClientDatabase } from '@bolusi/db-client';
import { notesModule } from '@bolusi/modules/notes';
import type { SignedOperation } from '@bolusi/schemas';
import { noblePort } from '@bolusi/test-support';
import type { Kysely } from 'kysely';

import { insertPulledOp, openClientDb } from './client-db.js';
import { notesProjectionManifest } from './manifest.js';

const hash = (data: Uint8Array): Uint8Array => noblePort.sha256(data);

/**
 * The canonical-fold reference for an op set (§3.4): a fresh DB via the shim, all ops fed to the
 * REAL projection engine strictly in `(timestamp ASC, deviceId ASC, seq ASC)` order, then digested.
 * Every op is canonically newest for its entity at insertion, so this is a pure head-apply fold —
 * asserted, so a reference that silently re-folded (a comparator bug) fails rather than masking one.
 */
export async function canonicalFold(
  ops: readonly SignedOperation[],
): Promise<{ digest: string; rows: NotesRow[] }> {
  const handle = await openClientDb();
  try {
    const registry = registerModules<ClientDatabase>([
      notesModule as unknown as AnyModuleDefinition<ClientDatabase>,
    ]);
    const stats = new ProjectionStats();
    const engine = createProjectionEngine(handle.db, registry.projections, { stats });
    const ordered = sortCanonical([...ops]);
    let arrivalSeq = 0;
    for (const op of ordered) {
      arrivalSeq += 1;
      await insertPulledOp(handle.db, op, arrivalSeq, op.timestamp);
      await engine.applyPulledOp(op);
    }
    if (stats.snapshot().refolds !== 0) {
      throw new Error(
        `canonical-fold reference re-folded (${stats.snapshot().refolds}×) — the canonical comparator is not producing a head-only order`,
      );
    }
    const digest = await digestModule(handle.db, notesProjectionManifest, { hash });
    const rows = await notesRows(handle.db);
    return { digest, rows };
  } finally {
    await handle.close();
  }
}

export interface NotesRow {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly editCount: number;
  readonly archived: number;
}

/** The notes projection rows, id-ordered — the row-level diff source for a divergence message. */
export async function notesRows(db: Kysely<ClientDatabase>): Promise<NotesRow[]> {
  const result = await sql<NotesRow>`
    SELECT id, title, body, edit_count AS "editCount", archived FROM notes ORDER BY id
  `.execute(db);
  return result.rows;
}

export interface Replica {
  readonly name: string;
  readonly digest: string;
  /** For the first-differing-row diagnostic on mismatch. */
  readonly rows: NotesRow[];
}

/**
 * Assert every replica converged to the reference. On mismatch, throw naming the replica AND the
 * first row that differs from the reference (§3.4) — a bare inequality would tell a debugger
 * nothing; the row is what points at the losing op.
 */
export function assertConvergence(
  reference: { digest: string; rows: NotesRow[] },
  replicas: readonly Replica[],
): void {
  if (replicas.length === 0) {
    throw new Error(
      'convergence oracle compared ZERO replicas — a run that checked nothing (§2.11)',
    );
  }
  for (const replica of replicas) {
    if (replica.digest === reference.digest) continue;
    const diff = firstDifferingRow(reference.rows, replica.rows);
    throw new Error(
      `convergence FAILED: replica ${replica.name} digest ${replica.digest} != reference ${reference.digest}; first differing row: ${diff}`,
    );
  }
}

function firstDifferingRow(reference: readonly NotesRow[], replica: readonly NotesRow[]): string {
  const max = Math.max(reference.length, replica.length);
  for (let i = 0; i < max; i += 1) {
    const a = reference[i];
    const b = replica[i];
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      return `reference=${JSON.stringify(a)} replica=${JSON.stringify(b)}`;
    }
  }
  return '(digests differ but rows match — a non-notes projection table diverged)';
}

/**
 * Fail a convergence run that did not exercise BOTH §4.2 dispatch paths (CHAOS-01's inconclusiveness
 * rule): head-apply AND re-fold counters must both be > 0, or the run proved nothing about
 * order-independence — it only ever saw ops arrive in order.
 */
export function assertBothFoldPaths(name: string, snapshot: ProjectionStatsSnapshot): void {
  if (snapshot.headApplies === 0 || snapshot.refolds === 0) {
    throw new Error(
      `CHAOS-01 INCONCLUSIVE for ${name}: headApplies=${snapshot.headApplies} refolds=${snapshot.refolds} — a run that did not exercise BOTH §4.2 paths proves nothing (§2.11)`,
    );
  }
}
