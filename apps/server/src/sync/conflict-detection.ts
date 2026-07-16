// Conflict detection (01-domain-model §8.2) — the block 10-db §3 puts AFTER the acceptance loop
// and INSIDE the push transaction.
//
// > -- conflict detection (01-domain-model §8.2) — SAME transaction, AFTER the
// > --   acceptance loop, over the just-accepted ops:
// > --   for each detected pair: build the platform.conflict_detected op
// > --     (actor = the tenant system user; device = the tenant system device),
// > --   chain it via system_device_chain_state (seq = last_seq + 1,
// > --     previousHash = last_hash),
// > --   sign its JCS core with the tenant system-device Ed25519 key
// > --     (server secret store, §12 — never in Postgres),
// > --   allocate its serverSeq with the same per-op UPDATE ... RETURNING,
// > --   INSERT operations → apply the conflicts projection,
// > --   UPDATE system_device_chain_state SET last_seq, last_hash
//
// WHY "SAME TRANSACTION" IS THE WHOLE DESIGN. Detection reads the op log — including the ops this
// very batch just inserted — and writes ops back into it. If the emission committed separately, a
// crash between the two would leave a conflict that exists in the log but never in any read model,
// or a batch whose ops were accepted while the conflicts they caused were lost. Sharing the
// transaction makes both impossible: the push and every conflict it detected commit together or
// not at all. Nothing here opens a transaction; it runs on the handle the pipeline already holds.
//
// WHY DETECTION IS SERVER-ONLY (01 §8.2): "The server is the single deterministic vantage point
// (client-local detection would diverge per replica)." Rule 1 asks whether O's device had PULLED P
// — a fact only the server knows (`devices.last_pull_cursor`). Results reach every device as
// ordinary `platform.conflict_detected` ops through normal pull, so a fresh device rebuilding from
// cursor 0 replays the same conflict ops and converges (I-8).
import { existsPrecedingOp, findRule1Candidates, type TenantDb } from '@bolusi/db-server';
import type { ConflictDeclaration, ConflictSeverity } from '@bolusi/core';
import { PLATFORM_ENTITY, PLATFORM_OP } from '@bolusi/core';
import type { SignedOperation } from '@bolusi/schemas';

import { appendSystemOp, type AppendSystemOpDeps, type SystemSigner } from '../oplog/system-op.js';

/**
 * Op type → its declared conflict rule (01 §8.1), and the reverse index Rule 1 needs.
 *
 * Built from the SAME `SERVER_MODULES` list that feeds the op validators and the appliers
 * (deps.ts), so a type cannot be validated, folded, and then invisible to detection — the three
 * facts come from one declaration (CLAUDE.md §2.8).
 */
export interface ConflictRegistry {
  /** The rule for an op type, or undefined ⇒ this type never produces a Conflict (01 §8.1). */
  declarationFor(type: string): ConflictDeclaration | undefined;
  /** Every op type declaring `key` — what "ops sharing conflict key K" resolves to in the log. */
  typesForKey(key: string): readonly string[];
}

/** A module's operations, as `SERVER_MODULES` carries them. */
interface ConflictSource {
  readonly operations: Readonly<Record<string, { readonly conflict?: ConflictDeclaration }>>;
}

/**
 * Index the conflict declarations of a module list (01 §8.1).
 *
 * The key→types index is the direction Rule 1 reads: the op log stores TYPES, but a conflict is
 * declared over a KEY, and two different types may legitimately share one (a v1 and a v2 of the
 * same edit both keyed `note.body` — 04 §3: old ops never disappear, so both live forever).
 * Resolving key→types here, once, is what lets the candidate query stay a plain `type IN (...)`.
 */
export function buildConflictRegistry(modules: readonly ConflictSource[]): ConflictRegistry {
  const byType = new Map<string, ConflictDeclaration>();
  const typesByKey = new Map<string, string[]>();

  for (const module of modules) {
    for (const [type, declaration] of Object.entries(module.operations)) {
      const conflict = declaration.conflict;
      if (conflict === undefined) continue; // 01 §8.1: no declaration ⇒ never a Conflict.
      byType.set(type, conflict);
      const types = typesByKey.get(conflict.key);
      if (types === undefined) typesByKey.set(conflict.key, [type]);
      else types.push(type);
    }
  }

  return {
    declarationFor: (type) => byType.get(type),
    typesForKey: (key) => typesByKey.get(key) ?? [],
  };
}

/**
 * A Rule-2 invariant check (01 §8.2) — "named cross-entity checks evaluated at acceptance".
 *
 * Returns the conflict key to record when it fires, or `null`. It reads the DB because that is the
 * point: Rule 2 asks a question about OTHER entities' folded state ("is this note already
 * archived?"), which Rule 1's op-vs-op comparison structurally cannot express.
 *
 * The server NEVER rejects for a business reason (01 §8.2: "rejection codes are closed,
 * 05 §8 — it accepts and flags"). A check returning non-null flags; it cannot veto.
 */
export interface InvariantCheck {
  /** The registered name, e.g. `notes:edit_after_archive` (01 §8.2). */
  readonly name: string;
  /** The op types this check runs for — nothing else pays its query cost. */
  readonly appliesTo: readonly string[];
  /** The conflict key + severity recorded when it fires (01 §8.3: severity is static). */
  readonly conflictKey: string;
  readonly severity: ConflictSeverity;
  /** Does the invariant break for this accepted op? Runs inside the push transaction. */
  fires(db: TenantDb, op: SignedOperation): Promise<boolean>;
}

/**
 * v0 registers EXACTLY ONE Rule-2 check (01 §8.2) — `notes:edit_after_archive`.
 *
 * > an accepted `notes.note_body_edited` whose note is already archived at fold time (the editing
 * > device had not seen the archive) → `significant`
 *
 * 01 §8.2 is explicit about what is NOT here: identity uniqueness is not a Rule-2 case (identity
 * mutations are online-only, so no offline collision can exist), and the last-admin guard is a
 * server endpoint check (`409 LAST_ADMIN_PROTECTED`), not a Conflict. The v1 examples (negative
 * stock, contradictory status transitions) "slot in here; they are **not** built in v0".
 *
 * It asks the OP LOG whether an archive sorts canonically BEFORE this edit — not whether the note
 * is archived NOW. The difference is a false positive this suite caught: detection runs after the
 * acceptance loop, so a device that edits and then archives its own note in one batch would, under
 * a "read `notes.archived`" check, be reported as conflicting with itself — the exact case 01
 * §8.2's parenthetical excludes ("the editing device had not seen the archive"). 03 §11 states the
 * rule as ORDER ("`notes.note_body_edited` sorting after `notes.note_archived` in canonical
 * order"), and archive is terminal in v0, so the two formulations agree wherever the naive one is
 * right and only the ordered one is right where they differ. See `existsPrecedingOp`.
 *
 * NOTE — this check is inert until task 25 registers `notes`. It fires only for
 * `notes.note_body_edited`, which is `UNKNOWN_TYPE` today (SERVER_MODULES carries only
 * `platform`), so no op reaches it. Shipped now because 01 §8.2 names it as v0's one registered
 * check and task 17 owns the registry it lives in; task 25 makes it reachable by registering the
 * module and declaring `notes.note_body_edited`'s conflict key. Its coverage is the
 * `edit_after_archive` leg of this task's suite, which registers a notes-shaped module itself.
 */
export const NOTES_EDIT_AFTER_ARCHIVE: InvariantCheck = {
  name: 'notes:edit_after_archive',
  appliesTo: ['notes.note_body_edited'],
  conflictKey: 'note.archived',
  severity: 'significant',
  fires: (db, op) =>
    existsPrecedingOp(db, {
      entityId: op.entityId,
      types: ['notes.note_archived'],
      position: { timestamp: op.timestamp, deviceId: op.deviceId, seq: op.seq },
    }),
};

/** The tenant's system identity + key — 01 §3.6's ONLY emission path. */
export interface SystemIdentity {
  readonly systemDeviceId: string;
  readonly systemUserId: string;
  readonly systemDevicePublicKey: Uint8Array;
  readonly sign: SystemSigner;
}

export interface ConflictDetectionDeps extends AppendSystemOpDeps {
  readonly registry: ConflictRegistry;
  /** The registered Rule-2 checks (01 §8.2). v0: exactly `notes:edit_after_archive`. */
  readonly invariantChecks: readonly InvariantCheck[];
  /** Resolve the tenant's system actor + signing key (01 §3.6). */
  readonly systemIdentity: (db: TenantDb, tenantId: string) => Promise<SystemIdentity>;
}

/** One conflict, decided but not yet emitted. */
interface DetectedPair {
  readonly opAId: string;
  readonly opBId: string;
  readonly conflictKey: string;
  readonly severity: ConflictSeverity;
  readonly entityType: string;
  readonly entityId: string;
  readonly storeId: string | null;
}

/** What the caller needs after the transaction commits (the post-commit hook, 03 §7). */
export interface SurfacedConflict {
  readonly conflictId: string;
  readonly tenantId: string;
  readonly storeId: string | null;
  /** api/04-push's category for this attention item (03 §7). Task 21 owns delivery. */
  readonly category: 'conflict';
}

export interface DetectConflictsResult {
  /** The emitted detection ops, in emission order. */
  readonly ops: readonly SignedOperation[];
  /** Only the SIGNIFICANT ones (03 §7: minor is `auto_resolved` and surfaces to nobody). */
  readonly surfaced: readonly SurfacedConflict[];
}

/**
 * An unordered pair key (01 §8.2: "At most one Conflict record per unordered op pair").
 *
 * Sorted, so `(x,y)` and `(y,x)` are the same key. That is what makes the dedupe catch BOTH arrival
 * orders: whichever device syncs later, the rule fires on its push and would otherwise mint a
 * second Conflict for the same collision seen from the other side.
 */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Detect conflicts over the ops this batch just accepted, and emit their detection ops.
 *
 * Runs AFTER the acceptance loop, inside the push transaction (10-db §3), on the pipeline's handle.
 *
 * @param db the tenant-bound transaction handle the pipeline already holds.
 * @param accepted the ops accepted by THIS batch, in acceptance order. Already in `operations`
 *   with their serverSeq, and already folded — so both rules see them.
 */
export async function detectConflicts(
  db: TenantDb,
  deps: ConflictDetectionDeps,
  tenantId: string,
  accepted: readonly SignedOperation[],
): Promise<DetectConflictsResult> {
  const pairs = await collectPairs(db, deps, accepted);
  if (pairs.length === 0) return { ops: [], surfaced: [] };

  // The system identity is resolved ONCE, and only when there is something to emit: it reads the
  // directory and the secret store, and a push that detected nothing must not pay for either.
  const system = await deps.systemIdentity(db, tenantId);

  const ops: SignedOperation[] = [];
  const surfaced: SurfacedConflict[] = [];

  for (const pair of pairs) {
    // Every envelope fact here is 01 §6's registry row for `platform.conflict_detected`:
    // entityType `conflict`, entityId = a NEW conflict id (which becomes `conflicts.id`, 01 §5.4),
    // storeId = the conflicted entity's store, actor = the system user, device = the system device.
    const { op } = await appendSystemOp(db, deps, {
      tenantId,
      systemDeviceId: system.systemDeviceId,
      systemUserId: system.systemUserId,
      systemDevicePublicKey: system.systemDevicePublicKey,
      sign: system.sign,
      storeId: pair.storeId,
      type: PLATFORM_OP.conflictDetected,
      entityType: PLATFORM_ENTITY.conflict,
      entityId: deps.newId(),
      schemaVersion: 1,
      payload: {
        entityType: pair.entityType,
        entityId: pair.entityId,
        conflictKey: pair.conflictKey,
        severity: pair.severity,
        opAId: pair.opAId,
        opBId: pair.opBId,
      },
      // Server time of detection (01 §5.4 `detectedAt`) — the applier reads it off the envelope.
      timestamp: deps.now(),
    });
    ops.push(op);

    // 03 §7's two `detected` exits, and the ONE place the push category is decided. `minor` →
    // `auto_resolved`: "recorded; feeds reporting (v1); no user action" — it surfaces to nobody, so
    // it never reaches this list and the hook never fires for it.
    if (pair.severity === 'significant') {
      surfaced.push({
        conflictId: op.entityId,
        tenantId,
        storeId: pair.storeId,
        category: 'conflict',
      });
    }
  }

  return { ops, surfaced };
}

/** Both rules, deduped per unordered pair (01 §8.2). */
async function collectPairs(
  db: TenantDb,
  deps: ConflictDetectionDeps,
  accepted: readonly SignedOperation[],
): Promise<DetectedPair[]> {
  const pairs: DetectedPair[] = [];
  const seen = new Set<string>();

  for (const op of accepted) {
    // ── Rule 1 — concurrent edit (generic) ────────────────────────────────────────────────────
    const declaration = deps.registry.declarationFor(op.type);
    if (declaration !== undefined) {
      const candidates = await findRule1Candidates(db, {
        opId: op.id,
        entityId: op.entityId,
        deviceId: op.deviceId,
        timestamp: op.timestamp,
        seq: op.seq,
        typesWithSameKey: deps.registry.typesForKey(declaration.key),
      });

      for (const candidate of candidates) {
        const key = pairKey(op.id, candidate.opId);
        // In-batch dedupe. The `conflicts` UNIQUE (op_a_id, op_b_id) is the DB's backstop, but it
        // would abort the whole push transaction rather than skip a duplicate — a constraint is a
        // last line of defence, not a control flow.
        if (seen.has(key)) continue;
        seen.add(key);
        if (await alreadyRecorded(db, op.id, candidate.opId)) continue;

        // Canonical order, decided by Postgres (05 §4) — `beforeProbe` says whether the CANDIDATE
        // sorts before the accepted op. 01 §5.4: "The colliding ops, canonical order (A before B)".
        const [opAId, opBId] = candidate.beforeProbe
          ? [candidate.opId, op.id]
          : [op.id, candidate.opId];

        pairs.push({
          opAId,
          opBId,
          conflictKey: declaration.key,
          // Static, from the DECLARATION (01 §8.3) — never from a payload.
          severity: declaration.severity,
          entityType: op.entityType,
          entityId: op.entityId,
          storeId: op.storeId,
        });
      }
    }

    // ── Rule 2 — registered invariant checks (bespoke) ────────────────────────────────────────
    for (const check of deps.invariantChecks) {
      if (!check.appliesTo.includes(op.type)) continue;
      if (!(await check.fires(db, op))) continue;

      // A Rule-2 conflict is about ONE op — the invariant it broke, not another op it raced. 01
      // §5.4 still demands an opA/opB pair, so both are this op: the record says "this op, folded
      // here, broke this invariant". Pairing it with the archive op would be a guess about WHICH
      // archive (there may be several) and would make the pair's meaning "these two collided",
      // which is Rule 1's claim, not Rule 2's.
      const key = pairKey(op.id, op.id);
      if (seen.has(key)) continue;
      seen.add(key);
      if (await alreadyRecorded(db, op.id, op.id)) continue;

      pairs.push({
        opAId: op.id,
        opBId: op.id,
        conflictKey: check.conflictKey,
        severity: check.severity,
        entityType: op.entityType,
        entityId: op.entityId,
        storeId: op.storeId,
      });
    }
  }

  return pairs;
}

/**
 * Has this unordered pair already been recorded (01 §8.2: "dedupe on `(opAId, opBId)`")?
 *
 * Across PUSHES, not just within a batch: re-pushing a colliding batch is all `duplicate` (05 §5),
 * so those ops never re-reach detection — but a LATER, genuinely new op can collide with the same
 * partner and must not mint a second record. Checks both orders, because the pair is unordered and
 * the canonical A/B assignment depends on which op arrived when.
 */
async function alreadyRecorded(db: TenantDb, x: string, y: string): Promise<boolean> {
  const row = await db
    .selectFrom('conflicts')
    .select('id')
    .where((eb) =>
      eb.or([
        eb.and([eb('opAId', '=', x), eb('opBId', '=', y)]),
        eb.and([eb('opAId', '=', y), eb('opBId', '=', x)]),
      ]),
    )
    .executeTakeFirst();
  return row !== undefined;
}
