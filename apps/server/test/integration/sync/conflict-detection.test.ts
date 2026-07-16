// Conflict detection (01-domain-model §8.2) driven through the REAL push pipeline.
//
// Every test here calls `processPushBatch` — the production orchestrator behind POST /v1/sync/push
// — and reads the `conflicts` table the appliers wrote. Nothing hand-builds a detection engine and
// nothing INSERTs a conflict row: a suite that did either would pass with the detection block
// unwired from the pipeline, which is the failure mode this file exists to catch (T-14b/T-17).
//
// ── WHICH LANE PROVES WHAT (T-14f rule 3 / D16) ───────────────────────────────────────────────
//
// This file runs on **PGlite (PG18, in-process)**, because `pg` is boundary-locked to
// `packages/db-server` and `pnpm test:rls` is `--project db-server` — an apps/server integration
// test structurally cannot reach real PG16 today (task 73 owns that; the constraint was found
// independently by review-49). So this lane proves the RULES: what conflicts, what severity, the
// pair dedupe, the emission, the lifecycle, the atomicity of the block.
//
// It does NOT prove the one claim PGlite is measurably blind to — Rule 1's
// `serverSeq(P) > last_pull_cursor(O.device)` int8 comparison (T-14f: 14/14 green on PGlite vs 4
// red on real `pg`). That claim is proven by
// `packages/db-server/test/conflict-candidates-pg.test.ts` on the attributed real-PG16 lane,
// executing THE SAME `findRule1Candidates` this pipeline calls — not a copy. Neither lane is the
// sole witness for anything the other owns.
import {
  platformModule,
  PLATFORM_OP,
  ProjectionRegistry,
  type ProjectionApplier,
} from '@bolusi/core';
import type { DB } from '@bolusi/db-server';
import {
  chaos07Cases,
  chaos07ExpectedConflicts,
  ChainBuilder,
  makeWorld,
  type ChainWorld,
} from '@bolusi/test-support';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  buildConflictRegistry,
  detectConflicts,
  NOTES_EDIT_AFTER_ARCHIVE,
  type SurfacedConflict,
  type SystemIdentity,
} from '../../../src/sync/conflict-detection.js';
import { serverCryptoPort } from '../../../src/oplog/crypto.js';
import { processPushBatch } from '../../../src/oplog/pipeline.js';
import type { SystemSigner } from '../../../src/oplog/system-op.js';
import type { OpRegistry, OplogPipelineDeps } from '../../../src/oplog/types.js';
import {
  makeDeps,
  makeIdSource,
  makeOplogTestDb,
  readOps,
  seedDevice,
  seedWorld,
  type OplogTestDb,
} from '../oplog/helpers.js';

let testDb: OplogTestDb;

const NOTE_EDITED = 'notes.note_body_edited';
const NOTE_ARCHIVED = 'notes.note_archived';
const NOTE_CREATED = 'notes.note_created';

/**
 * A NOTES-SHAPED module, standing in for task 25's real one.
 *
 * It is not a toy: it declares the conflict rule 01 §8.1 / 03 §11's N1 row specifies verbatim
 * (`{key: 'note.body', severity: 'minor'}`) and its appliers write the REAL `notes` table (10-db
 * §8), because Rule 2's `notes:edit_after_archive` reads `notes.archived` — a check against a
 * fake table would prove nothing about the check that ships.
 *
 * `notes.note_archived` deliberately declares NO conflict key: 03 §11's total rule says "Duplicate
 * `notes.note_archived`: no-op, not a conflict", and N2 (edit-after-archive) is Rule 2's job, not
 * Rule 1's. Two archives racing is not a collision anyone needs to hear about.
 */
const notesModule = {
  id: 'notes',
  operations: {
    // No `conflict` KEY at all — 01 §8.1's "ops without a conflict declaration". An absent key,
    // not a present-and-undefined one: the two differ under exactOptionalPropertyTypes, and the
    // absent form is what a real manifest writes.
    [NOTE_CREATED]: {},
    // N1 (03 §11): "concurrent body edits of the same note from different devices" → minor.
    [NOTE_EDITED]: { conflict: { key: 'note.body', severity: 'minor' as const } },
    [NOTE_ARCHIVED]: {},
  },
};

const noteCreatedApplier: ProjectionApplier<DB> = async (db, op) => {
  const payload = op.payload as unknown as { title: string; body: string };
  await db
    .insertInto('notes')
    .values({
      id: op.entityId,
      tenantId: op.tenantId,
      storeId: op.storeId as string,
      title: payload.title,
      body: payload.body,
      archived: false,
      editCount: 0,
      createdBy: op.userId,
      createdAt: BigInt(op.timestamp),
      lastEditedBy: op.userId,
      lastEditedAt: BigInt(op.timestamp),
    })
    .execute();
};

const noteEditedApplier: ProjectionApplier<DB> = async (db, op) => {
  const payload = op.payload as unknown as { body: string };
  // 03 §11's total rule: "the body updates, `status` stays `archived` — the edit happened and the
  // log is truth". The fold does NOT refuse an edit to an archived note; Rule 2 flags it.
  await db
    .updateTable('notes')
    .set((eb) => ({
      body: payload.body,
      editCount: eb('editCount', '+', 1),
      lastEditedBy: op.userId,
      lastEditedAt: BigInt(op.timestamp),
    }))
    .where('id', '=', op.entityId)
    .execute();
};

const noteArchivedApplier: ProjectionApplier<DB> = async (db, op) => {
  await db.updateTable('notes').set({ archived: true }).where('id', '=', op.entityId).execute();
};

/** The op registry for the types this suite pushes (the platform types come from the real one). */
const suiteRegistry: OpRegistry = {
  resolve(type) {
    if (type === NOTE_CREATED || type === NOTE_EDITED || type === NOTE_ARCHIVED) {
      return { kind: 'known', validate: () => true };
    }
    if (type === PLATFORM_OP.conflictDetected) return { kind: 'known', validate: () => true };
    // The no-cascade case pushes a real locale op; it validates through the SHIPPED payload schema
    // (platformModule's own declaration), not a `() => true` stub, so a schema regression is red.
    if (type === PLATFORM_OP.userLocaleChanged) {
      return {
        kind: 'known',
        validate: (payload) => {
          try {
            platformModule.operations[PLATFORM_OP.userLocaleChanged]?.payload.parse(payload);
            return true;
          } catch {
            return false;
          }
        },
      };
    }
    return { kind: 'unknown' };
  },
};

/**
 * The appliers: the notes stand-in ABOVE, plus the REAL `platform` module.
 *
 * The platform half is the shipped `platformModule` — not a stand-in — because the `conflicts` row
 * every test below reads is written by the production applier or by nothing. Registering a
 * conflicts-shaped fake here would make this suite a test of the fake, and it would stay green if
 * `conflictDetectedApplier` were deleted.
 */
function suiteProjections(): ProjectionRegistry<DB> {
  const registry = new ProjectionRegistry<DB>();
  registry.register({
    id: 'notes',
    tables: {
      notes: {
        columns: { id: 'text', body: 'text', archived: 'boolean', edit_count: 'integer' },
        primaryKey: ['id'],
        entityType: 'note',
        entityIdColumn: 'id',
        projectionVersion: 1,
      },
    },
    appliers: {
      [NOTE_CREATED]: noteCreatedApplier,
      [NOTE_EDITED]: noteEditedApplier,
      [NOTE_ARCHIVED]: noteArchivedApplier,
    },
  });
  registry.register({
    id: platformModule.id,
    tables: platformModule.projections.tables,
    appliers: Object.fromEntries(
      Object.entries(platformModule.operations).map(([type, d]) => [type, d.apply]),
    ),
  } as unknown as Parameters<ProjectionRegistry<DB>['register']>[0]);
  return registry;
}

/**
 * A tenant with a member device AND its system device (01 §3.6 — the only conflict emitter).
 *
 * It RETURNS the builder whose genesis the device is seeded at. That coupling is the point: the
 * device row caches `last_hash`, so a second builder — even for the same world — mints a genesis
 * with a different timestamp, a different hash, and every op after it fails `CHAIN_BROKEN`. One
 * builder per device, handed out by the thing that seeded it, makes that unrepresentable.
 */
async function setupTenant(seed: number, startTs = 1_726_000_100_000) {
  const member = makeWorld(seed, serverCryptoPort);
  const builder = new ChainBuilder(member, serverCryptoPort, startTs);
  const genesis = builder.genesis(); // advances the builder; never pushed (auth is task 43)
  await seedWorld(testDb.db, member, { lastSeq: 1, lastHash: genesis.hash });

  const raw = makeWorld(seed + 500, serverCryptoPort);
  const system: ChainWorld = {
    ...raw,
    tenantId: member.tenantId,
    storeId: member.storeId,
    userId: member.userId,
  };
  await seedDevice(testDb.db, system, { deviceKind: 'system' });
  await testDb.db
    .insertInto('systemDeviceChainState')
    .values({ tenantId: member.tenantId, deviceId: system.deviceId })
    .execute();

  const sign: SystemSigner = (hash) => serverCryptoPort.sign(hash, system.secretKey);
  const systemIdentity = (): Promise<SystemIdentity> =>
    Promise.resolve({
      systemDeviceId: system.deviceId,
      systemUserId: system.userId,
      systemDevicePublicKey: system.publicKey,
      sign,
    });

  return { member, system, systemIdentity, builder };
}

/**
 * A second member device inside the SAME tenant — the other half of every concurrent edit.
 *
 * `lastPullCursor` is Rule 1's other operand (01 §8.2): 0 means "this device has pulled nothing",
 * which is what makes its edit concurrent with everything already accepted.
 */
async function addDevice(
  member: ChainWorld,
  seed: number,
  lastPullCursor = 0,
  startTs = 1_726_000_200_000,
) {
  const raw = makeWorld(seed, serverCryptoPort);
  const other: ChainWorld = {
    ...raw,
    tenantId: member.tenantId,
    storeId: member.storeId,
    userId: member.userId,
  };
  const builder = new ChainBuilder(other, serverCryptoPort, startTs);
  const genesis = builder.genesis();
  await seedDevice(testDb.db, other, { lastSeq: 1, lastHash: genesis.hash });
  await testDb.db
    .updateTable('devices')
    .set({ lastPullCursor: BigInt(lastPullCursor) })
    .where('id', '=', other.deviceId)
    .execute();
  return { other, builder };
}

interface PushOptions {
  readonly systemIdentity: () => Promise<SystemIdentity>;
  readonly onConflictSurfaced?: (c: SurfacedConflict) => Promise<void>;
  readonly checks?: readonly (typeof NOTES_EDIT_AFTER_ARCHIVE)[];
  readonly idSeed?: number;
}

/** The pipeline deps with detection wired exactly as production wires it. */
function depsWith(options: PushOptions): OplogPipelineDeps {
  const base = makeDeps({
    forTenant: testDb.appForTenant,
    registry: suiteRegistry,
    projections: suiteProjections(),
    newId: makeIdSource(options.idSeed ?? 700),
  });
  const detectionDeps = {
    crypto: base.crypto,
    now: base.now,
    newId: base.newId,
    // The notes stand-in AND the REAL platform module. Including `platformModule` is what makes
    // the no-cascade test below honest: with only `notesModule` here, the conflict registry never
    // sees the platform types, so "concurrent setLocale produces no conflict" would be green even
    // if `platform.user_locale_changed` DID declare a conflict key — green for the wrong reason.
    // Caught by falsifying it (§2.11): adding a conflict declaration to the platform op left the
    // behavioural test green and only the declaration test red.
    registry: buildConflictRegistry([
      notesModule,
      platformModule as unknown as Parameters<typeof buildConflictRegistry>[0][number],
    ]),
    invariantChecks: options.checks ?? [NOTES_EDIT_AFTER_ARCHIVE],
    systemIdentity: options.systemIdentity,
  };
  return {
    ...base,
    detectConflicts: (db, tenantId, accepted) =>
      detectConflicts(db, detectionDeps, tenantId, accepted),
    ...(options.onConflictSurfaced === undefined
      ? {}
      : { onConflictSurfaced: options.onConflictSurfaced }),
  };
}

async function readConflicts() {
  return testDb.db.selectFrom('conflicts').selectAll().orderBy('detectedAt').execute();
}

beforeEach(async () => {
  testDb = await makeOplogTestDb();
}, 120_000);

afterEach(async () => {
  await testDb?.close();
});

describe('Rule 1 — concurrent edit (01 §8.2)', () => {
  test('a note edited by two devices, neither having pulled the other, is ONE minor conflict', async () => {
    const { member, systemIdentity, builder: aBuilder } = await setupTenant(1710);
    const { other, builder: bBuilder } = await addDevice(member, 1711);

    const noteId = makeWorld(1712, serverCryptoPort).storeId;
    // Device A creates the note and edits it.
    await processPushBatch(
      depsWith({ systemIdentity }),
      { deviceId: member.deviceId, tenantId: member.tenantId },
      [
        aBuilder.append({
          type: NOTE_CREATED,
          entityType: 'note',
          entityId: noteId,
          payload: { title: 't', body: 'from-a' },
        }),
        aBuilder.append({
          type: NOTE_EDITED,
          entityType: 'note',
          entityId: noteId,
          payload: { body: 'edit-from-a' },
        }),
      ],
    );

    // No conflict yet: one device, no collision (the positive control for the rule's `≠` clause).
    expect(await readConflicts()).toHaveLength(0);

    // Device B, whose last_pull_cursor is 0, edits the SAME note — it never saw A's edit.
    await processPushBatch(
      depsWith({ systemIdentity, idSeed: 800 }),
      { deviceId: other.deviceId, tenantId: other.tenantId },
      [
        bBuilder.append({
          type: NOTE_EDITED,
          entityType: 'note',
          entityId: noteId,
          payload: { body: 'edit-from-b' },
        }),
      ],
    );

    const conflicts = await readConflicts();
    expect(conflicts).toHaveLength(1);
    const conflict = conflicts[0];
    expect(conflict?.conflictKey).toBe('note.body');
    expect(conflict?.severity).toBe('minor');
    // 01 §8.3 / 03 §7: minor classifies to `auto_resolved`, terminal, and NEVER rests at `detected`.
    expect(conflict?.status).toBe('auto_resolved');
    expect(conflict?.entityType).toBe('note');
    expect(conflict?.entityId).toBe(noteId);
    // storeId = the conflicted entity's store (01 §5.4) — routes it to the right devices.
    expect(conflict?.storeId).toBe(member.storeId);

    // The detection op exists in the log, signed by the SYSTEM device (01 §3.6), and its entityId
    // IS the conflict's id (01 §5.4).
    const logged = await readOps(testDb.db, member.tenantId);
    const detection = logged.filter((o) => o.type === PLATFORM_OP.conflictDetected);
    expect(detection).toHaveLength(1);
    expect(detection[0]?.source).toBe('system');
    expect(detection[0]?.entityId).toBe(conflict?.id);
  });

  test('MISS — the same device editing twice is a sequence, not a conflict', async () => {
    // `P.deviceId ≠ O.deviceId` (01 §8.2). T-14b: the pass condition is "no rows", so the fixture
    // asserts the edits LANDED first — an empty conflicts table also means "nothing was pushed".
    const { member, systemIdentity, builder } = await setupTenant(1720);
    const noteId = makeWorld(1721, serverCryptoPort).storeId;

    await processPushBatch(
      depsWith({ systemIdentity }),
      { deviceId: member.deviceId, tenantId: member.tenantId },
      [
        builder.append({
          type: NOTE_CREATED,
          entityType: 'note',
          entityId: noteId,
          payload: { title: 't', body: 'v0' },
        }),
        builder.append({
          type: NOTE_EDITED,
          entityType: 'note',
          entityId: noteId,
          payload: { body: 'v1' },
        }),
        builder.append({
          type: NOTE_EDITED,
          entityType: 'note',
          entityId: noteId,
          payload: { body: 'v2' },
        }),
      ],
    );

    // THE POSITIVE CONTROL (T-14b): the two edits really are in the log and really did fold.
    const logged = await readOps(testDb.db, member.tenantId);
    expect(logged.filter((o) => o.type === NOTE_EDITED)).toHaveLength(2);
    const note = await testDb.db
      .selectFrom('notes')
      .select(['body', 'editCount'])
      .where('id', '=', noteId)
      .executeTakeFirstOrThrow();
    expect(note.body).toBe('v2');
    expect(Number(note.editCount)).toBe(2);

    // … and still no conflict, because one device cannot race itself.
    expect(await readConflicts()).toHaveLength(0);
  });

  test('MISS — a device that HAS pulled the other edit is not in conflict with it', async () => {
    // `serverSeq(P) > lastPullCursor(O.device)` (01 §8.2). B pulled everything before editing, so
    // B's author acted WITH knowledge of A's edit — a sequence the user intended, not a collision.
    const { member, systemIdentity, builder: aBuilder } = await setupTenant(1730);
    const noteId = makeWorld(1731, serverCryptoPort).storeId;

    await processPushBatch(
      depsWith({ systemIdentity }),
      { deviceId: member.deviceId, tenantId: member.tenantId },
      [
        aBuilder.append({
          type: NOTE_CREATED,
          entityType: 'note',
          entityId: noteId,
          payload: { title: 't', body: 'from-a' },
        }),
        aBuilder.append({
          type: NOTE_EDITED,
          entityType: 'note',
          entityId: noteId,
          payload: { body: 'edit-from-a' },
        }),
      ],
    );

    // B's cursor is AT the head — it has pulled A's edit.
    const head = await testDb.db
      .selectFrom('operations')
      .select('serverSeq')
      .orderBy('serverSeq', 'desc')
      .executeTakeFirstOrThrow();
    const { other, builder: bBuilder } = await addDevice(member, 1732, Number(head.serverSeq));

    await processPushBatch(
      depsWith({ systemIdentity, idSeed: 800 }),
      { deviceId: other.deviceId, tenantId: other.tenantId },
      [
        bBuilder.append({
          type: NOTE_EDITED,
          entityType: 'note',
          entityId: noteId,
          payload: { body: 'edit-from-b' },
        }),
      ],
    );

    // POSITIVE CONTROL (T-14b/T-17): B's edit landed — the miss is the RULE's doing, not a
    // fixture that failed to push. Same setup as the HIT test above except the cursor.
    const logged = await readOps(testDb.db, member.tenantId);
    expect(logged.filter((o) => o.type === NOTE_EDITED)).toHaveLength(2);
    expect(await readConflicts()).toHaveLength(0);
  });

  test('MISS — a different entity with the same key is not a conflict', async () => {
    const { member, systemIdentity, builder: aBuilder } = await setupTenant(1740);
    const { other, builder: bBuilder } = await addDevice(member, 1741);
    const noteA = makeWorld(1742, serverCryptoPort).storeId;
    const noteB = makeWorld(1743, serverCryptoPort).storeId;

    await processPushBatch(
      depsWith({ systemIdentity }),
      { deviceId: member.deviceId, tenantId: member.tenantId },
      [
        aBuilder.append({
          type: NOTE_CREATED,
          entityType: 'note',
          entityId: noteA,
          payload: { title: 't', body: 'a' },
        }),
        aBuilder.append({
          type: NOTE_EDITED,
          entityType: 'note',
          entityId: noteA,
          payload: { body: 'edit-a' },
        }),
      ],
    );

    await processPushBatch(
      depsWith({ systemIdentity, idSeed: 800 }),
      { deviceId: other.deviceId, tenantId: other.tenantId },
      [
        bBuilder.append({
          type: NOTE_CREATED,
          entityType: 'note',
          entityId: noteB,
          payload: { title: 't', body: 'b' },
        }),
        // Same conflict KEY (`note.body`), DIFFERENT entity — 01 §8.1: "Two ops conflict only when
        // they share (entityId, conflict.key)".
        bBuilder.append({
          type: NOTE_EDITED,
          entityType: 'note',
          entityId: noteB,
          payload: { body: 'edit-b' },
        }),
      ],
    );

    const logged = await readOps(testDb.db, member.tenantId);
    expect(logged.filter((o) => o.type === NOTE_EDITED)).toHaveLength(2); // control
    expect(await readConflicts()).toHaveLength(0);
  });

  test('MISS — an op type with no conflict declaration never produces a Conflict', async () => {
    // 01 §8.1: "Ops without a `conflict` declaration never generate Conflict records."
    // `notes.note_archived` declares none, so two devices archiving the same note concurrently is
    // a duplicate no-op (03 §11's total rule), not a collision.
    const { member, systemIdentity, builder: aBuilder } = await setupTenant(1750);
    const { other, builder: bBuilder } = await addDevice(member, 1751);
    const noteId = makeWorld(1752, serverCryptoPort).storeId;

    await processPushBatch(
      depsWith({ systemIdentity }),
      { deviceId: member.deviceId, tenantId: member.tenantId },
      [
        aBuilder.append({
          type: NOTE_CREATED,
          entityType: 'note',
          entityId: noteId,
          payload: { title: 't', body: 'a' },
        }),
        aBuilder.append({
          type: NOTE_ARCHIVED,
          entityType: 'note',
          entityId: noteId,
          payload: {},
        }),
      ],
    );

    await processPushBatch(
      depsWith({ systemIdentity, idSeed: 800, checks: [] }),
      { deviceId: other.deviceId, tenantId: other.tenantId },
      [
        bBuilder.append({
          type: NOTE_ARCHIVED,
          entityType: 'note',
          entityId: noteId,
          payload: {},
        }),
      ],
    );

    const logged = await readOps(testDb.db, member.tenantId);
    expect(logged.filter((o) => o.type === NOTE_ARCHIVED)).toHaveLength(2); // control
    expect(await readConflicts()).toHaveLength(0);
  });
});

describe('Rule 2 — registered invariant checks (01 §8.2)', () => {
  test('edit-after-archive is a SIGNIFICANT conflict that surfaces', async () => {
    // 03 §11's N2 row: "body edit merged after archive (editor acted without knowing)" → caught by
    // `notes:edit_after_archive` → significant → surfaced.
    const { member, systemIdentity, builder: aBuilder } = await setupTenant(1760);
    const { other, builder: bBuilder } = await addDevice(member, 1761);
    const noteId = makeWorld(1762, serverCryptoPort).storeId;

    await processPushBatch(
      depsWith({ systemIdentity }),
      { deviceId: member.deviceId, tenantId: member.tenantId },
      [
        aBuilder.append({
          type: NOTE_CREATED,
          entityType: 'note',
          entityId: noteId,
          payload: { title: 't', body: 'a' },
        }),
        aBuilder.append({
          type: NOTE_ARCHIVED,
          entityType: 'note',
          entityId: noteId,
          payload: {},
        }),
      ],
    );

    // Device B, offline through the archive, edits the body.
    const result = await processPushBatch(
      depsWith({ systemIdentity, idSeed: 800 }),
      { deviceId: other.deviceId, tenantId: other.tenantId },
      [
        bBuilder.append({
          type: NOTE_EDITED,
          entityType: 'note',
          entityId: noteId,
          payload: { body: 'edit-after-archive' },
        }),
      ],
    );

    // The server ACCEPTS and flags — it never rejects for a business reason (01 §8.2).
    expect(result.results[0]?.status).toBe('accepted');

    const conflicts = await readConflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.severity).toBe('significant');
    // 03 §7: significant → `surfaced` (a store owner must see it), never at rest as `detected`.
    expect(conflicts[0]?.status).toBe('surfaced');
    expect(conflicts[0]?.conflictKey).toBe('note.archived');

    // 03 §11's total rule holds alongside: the fold is TOTAL — the body updated and the note stays
    // archived. The conflict is a flag, not a veto.
    const note = await testDb.db
      .selectFrom('notes')
      .select(['body', 'archived'])
      .where('id', '=', noteId)
      .executeTakeFirstOrThrow();
    expect(note.body).toBe('edit-after-archive');
    expect(note.archived).toBe(true);
  });
});

describe('dedupe, emission and atomicity (01 §8.2; 10-db §3)', () => {
  test('IDEMPOTENT — re-pushing a colliding batch mints no second conflict and no second system op', async () => {
    const { member, systemIdentity, builder: aBuilder } = await setupTenant(1770);
    const { other, builder: bBuilder } = await addDevice(member, 1771);
    const noteId = makeWorld(1772, serverCryptoPort).storeId;

    await processPushBatch(
      depsWith({ systemIdentity }),
      { deviceId: member.deviceId, tenantId: member.tenantId },
      [
        aBuilder.append({
          type: NOTE_CREATED,
          entityType: 'note',
          entityId: noteId,
          payload: { title: 't', body: 'a' },
        }),
        aBuilder.append({
          type: NOTE_EDITED,
          entityType: 'note',
          entityId: noteId,
          payload: { body: 'edit-a' },
        }),
      ],
    );

    const bEdit = bBuilder.append({
      type: NOTE_EDITED,
      entityType: 'note',
      entityId: noteId,
      payload: { body: 'edit-b' },
    });

    await processPushBatch(
      depsWith({ systemIdentity, idSeed: 800 }),
      { deviceId: other.deviceId, tenantId: other.tenantId },
      [bEdit],
    );
    expect(await readConflicts()).toHaveLength(1);

    const opsAfterFirst = await readOps(testDb.db, member.tenantId);
    const seqAfterFirst = opsAfterFirst.map((o) => Number(o.serverSeq));

    // The SAME op again — all `duplicate` (05 §5), so it never re-reaches detection.
    const replay = await processPushBatch(
      depsWith({ systemIdentity, idSeed: 900 }),
      { deviceId: other.deviceId, tenantId: other.tenantId },
      [bEdit],
    );
    expect(replay.results.map((r) => r.status)).toEqual(['duplicate']);

    // No second Conflict, no second system op, and the per-tenant serverSeq stream is UNCHANGED —
    // "Duplicates and rejected ops never reach this statement — they consume nothing" (10-db §3).
    expect(await readConflicts()).toHaveLength(1);
    const opsAfterReplay = await readOps(testDb.db, member.tenantId);
    expect(opsAfterReplay.map((o) => Number(o.serverSeq))).toEqual(seqAfterFirst);
    expect(opsAfterReplay.filter((o) => o.type === PLATFORM_OP.conflictDetected)).toHaveLength(1);
  });

  test('the detection op rides the SAME gapless per-tenant serverSeq stream and advances the chain', async () => {
    // 10-db §3: system ops "allocate its serverSeq with the same per-op UPDATE ... RETURNING" and
    // "ride the same per-tenant gapless serverSeq stream as pushed ops".
    const { member, system, systemIdentity, builder: aBuilder } = await setupTenant(1780);
    const { other, builder: bBuilder } = await addDevice(member, 1781);
    const noteId = makeWorld(1782, serverCryptoPort).storeId;

    await processPushBatch(
      depsWith({ systemIdentity }),
      { deviceId: member.deviceId, tenantId: member.tenantId },
      [
        aBuilder.append({
          type: NOTE_CREATED,
          entityType: 'note',
          entityId: noteId,
          payload: { title: 't', body: 'a' },
        }),
        aBuilder.append({
          type: NOTE_EDITED,
          entityType: 'note',
          entityId: noteId,
          payload: { body: 'edit-a' },
        }),
      ],
    );

    await processPushBatch(
      depsWith({ systemIdentity, idSeed: 800 }),
      { deviceId: other.deviceId, tenantId: other.tenantId },
      [
        bBuilder.append({
          type: NOTE_EDITED,
          entityType: 'note',
          entityId: noteId,
          payload: { body: 'edit-b' },
        }),
      ],
    );

    // GAPLESS + CONTIGUOUS across accepted AND system ops — the property the in-loop counter
    // exists to give, asserted over the whole stream rather than over the detection op alone.
    const logged = await readOps(testDb.db, member.tenantId);
    const seqs = logged.map((o) => Number(o.serverSeq));
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
    // … and the detection op is LAST: detection runs after the acceptance loop (10-db §3).
    expect(logged[logged.length - 1]?.type).toBe(PLATFORM_OP.conflictDetected);

    // The system chain advanced: seq = last_seq + 1 (from 0), previousHash = last_hash.
    const chain = await testDb.db
      .selectFrom('systemDeviceChainState')
      .selectAll()
      .where('tenantId', '=', member.tenantId)
      .executeTakeFirstOrThrow();
    expect(Number(chain.lastSeq)).toBe(1);
    const detection = logged.find((o) => o.type === PLATFORM_OP.conflictDetected);
    expect(chain.lastHash).toBe(detection?.hash);
    expect(detection?.deviceId).toBe(system.deviceId);
  });

  test('ATOMIC — a failure after detection leaves no op, no conflict row, no chain advance', async () => {
    // 10-db §3's whole argument for one transaction: "If it is not atomic with the push, a crash
    // leaves a conflict that exists in the log but never in the read model." The abort is forced
    // from the system signer — i.e. from INSIDE the detection block, after Rule 1 has already
    // matched and the candidate query has run.
    const { member, systemIdentity, builder: aBuilder } = await setupTenant(1790);
    const { other, builder: bBuilder } = await addDevice(member, 1791);
    const noteId = makeWorld(1792, serverCryptoPort).storeId;

    const explode = (): Promise<SystemIdentity> =>
      Promise.reject(new Error('system key unavailable'));

    await processPushBatch(
      depsWith({ systemIdentity }),
      { deviceId: member.deviceId, tenantId: member.tenantId },
      [
        aBuilder.append({
          type: NOTE_CREATED,
          entityType: 'note',
          entityId: noteId,
          payload: { title: 't', body: 'a' },
        }),
        aBuilder.append({
          type: NOTE_EDITED,
          entityType: 'note',
          entityId: noteId,
          payload: { body: 'edit-a' },
        }),
      ],
    );
    const before = await readOps(testDb.db, member.tenantId);

    // B's push WOULD detect a conflict — and the emission then fails.
    await expect(
      processPushBatch(
        depsWith({ systemIdentity: explode, idSeed: 800 }),
        { deviceId: other.deviceId, tenantId: other.tenantId },
        [
          bBuilder.append({
            type: NOTE_EDITED,
            entityType: 'note',
            entityId: noteId,
            payload: { body: 'edit-b' },
          }),
        ],
      ),
    ).rejects.toThrow('system key unavailable');

    // B's edit was INSERTed and folded in-flight, then rolled back with everything else: the log is
    // exactly as it was, no conflict exists, and the chain never moved.
    const after = await readOps(testDb.db, member.tenantId);
    expect(after.map((o) => o.id)).toEqual(before.map((o) => o.id));
    expect(await readConflicts()).toHaveLength(0);
    const chain = await testDb.db
      .selectFrom('systemDeviceChainState')
      .select('lastSeq')
      .where('tenantId', '=', member.tenantId)
      .executeTakeFirstOrThrow();
    expect(Number(chain.lastSeq)).toBe(0);
  });
});

describe('no cascade — platform ops never produce Conflict rows (01 §8.1)', () => {
  test('concurrent setLocale from two devices: ZERO conflicts, LWW on user_prefs', async () => {
    // 01 §6: `platform.user_locale_changed` has "No conflict declaration (canonical-order LWW)".
    // Two devices setting a locale is not a collision anyone should hear about — the later one
    // simply wins. This is the same fixture shape as the Rule-1 HIT above (two devices, same
    // entity, neither having pulled the other) with ONE thing changed: the op type declares no
    // conflict. So the zero here is attributable to the declaration, not to a fixture that failed
    // to push — which the positive control below pins.
    //
    // It also guards the RECURSION. A `platform.conflict_detected` op is itself an accepted op on
    // an entity; if the platform types declared a conflict key, detection would manufacture
    // conflicts about conflicts, each emitting another detection op, forever. The absence of a
    // `conflict` key in `platform/operations.ts` is what stops it, and absence is invisible — so
    // this test is what makes it load-bearing rather than incidental.
    const { member, systemIdentity, builder: aBuilder } = await setupTenant(4300);
    const { other: devB, builder: bBuilder } = await addDevice(member, 4301);

    await processPushBatch(
      depsWith({ systemIdentity }),
      { deviceId: member.deviceId, tenantId: member.tenantId },
      [
        aBuilder.append({
          type: PLATFORM_OP.userLocaleChanged,
          entityType: 'user_pref',
          entityId: member.userId,
          storeId: null,
          payload: { locale: 'en' },
        }),
      ],
    );
    // B never pulled A's change (cursor 0) — concurrent by Rule 1's own definition.
    await processPushBatch(
      depsWith({ systemIdentity, idSeed: 830 }),
      { deviceId: devB.deviceId, tenantId: member.tenantId },
      [
        bBuilder.append({
          type: PLATFORM_OP.userLocaleChanged,
          entityType: 'user_pref',
          entityId: member.userId,
          storeId: null,
          payload: { locale: 'id' },
        }),
      ],
    );

    // THE POSITIVE CONTROL (T-14b): both ops really are in the log. Without it, "zero conflicts"
    // is equally satisfied by two pushes that never landed.
    const logged = await readOps(testDb.db, member.tenantId);
    expect(logged.filter((o) => o.type === PLATFORM_OP.userLocaleChanged)).toHaveLength(2);

    // No conflict — and no detection op either, so nothing could cascade next time.
    expect(await readConflicts()).toHaveLength(0);
    expect(logged.filter((o) => o.type === PLATFORM_OP.conflictDetected)).toHaveLength(0);

    // LWW stands: ONE row, carrying B's locale (canonically later — B's builder starts later).
    const prefs = await testDb.db.selectFrom('userPrefs').select(['userId', 'locale']).execute();
    expect(prefs).toEqual([{ userId: member.userId, locale: 'id' }]);
  });

  test('none of the three platform op types declares a conflict key (the T-14 denominator)', () => {
    // The absence, asserted directly and exhaustively — 01 §8.1: "Ops without a `conflict`
    // declaration never generate Conflict records." Behavioural coverage above proves it for the
    // one type a test can drive today; this covers the CLASS (T-12), including
    // `conflict_detected` itself, whose cascade would be the recursive one and which no member
    // device can push (05 §9 item 5) so no behavioural test could reach it.
    const declared = Object.entries(platformModule.operations).filter(
      ([, d]) => (d as { conflict?: unknown }).conflict !== undefined,
    );
    expect(declared).toEqual([]);
    // … and the denominator: three types were examined, not zero (an empty operations block would
    // also produce an empty `declared`).
    expect(Object.keys(platformModule.operations)).toHaveLength(3);
  });
});

describe('CHAOS-07 fixture (testing-guide §3.6) — driven through the real push pipeline', () => {
  test('the fixture’s expected-classification table is exhaustive and non-vacuous', () => {
    // The fixture is DATA two tasks read (17 and 26), so its own shape is asserted before either
    // trusts it. §3.6: "PASS criteria are exhaustive — anything beyond them observed as a diff is
    // a failure", which is only enforceable against a closed, non-empty expectation (T-14).
    const cases = chaos07Cases(4207);
    expect(cases.map((c) => c.subCase)).toEqual([
      'distinct-timestamps',
      'forced-tie',
      'edit-after-archive',
    ]);
    // FIVE conflicts total: 3 pairs from sub-case (i), 1 from (ii), 1 significant from (iii).
    const expected = chaos07ExpectedConflicts(4207);
    expect(expected).toHaveLength(5);
    // Both resting transitions covered (D4) — the reason CHAOS-07 exists at all.
    expect(new Set(expected.map((c) => c.status))).toEqual(
      new Set(['auto_resolved', 'acknowledged']),
    );
    expect(new Set(expected.map((c) => c.severity))).toEqual(new Set(['minor', 'significant']));
    // Per-seed unique bodies (T-3): a shared literal would let a wrong winner look right.
    expect(chaos07Cases(1).at(0)?.ops.at(1)?.payload.body).not.toBe(
      chaos07Cases(2).at(0)?.ops.at(1)?.payload.body,
    );
  });

  test('sub-case (i) — THREE devices editing one note is THREE conflicts, one per unordered pair', async () => {
    // The dedupe rule's real shape (01 §8.2: "At most one Conflict record per unordered op pair").
    // Three concurrent editors is C(3,2) = 3 pairs — not 1 (a naive "one conflict per entity") and
    // not 6 (a pair counted in both directions). No other test in this suite has three devices, and
    // the arithmetic is exactly where an off-by-one lives.
    const { member, systemIdentity, builder: aBuilder } = await setupTenant(4210);
    const { other: devB, builder: bBuilder } = await addDevice(member, 4211, 0, 1_726_000_200_000);
    const { other: devC, builder: cBuilder } = await addDevice(member, 4212, 0, 1_726_000_300_000);
    const noteId = makeWorld(4213, serverCryptoPort).storeId;

    const fixture = chaos07Cases(4207)[0];
    expect(fixture?.expectedConflicts).toHaveLength(3); // the fixture's claim …

    // A creates + edits.
    await processPushBatch(
      depsWith({ systemIdentity }),
      { deviceId: member.deviceId, tenantId: member.tenantId },
      [
        aBuilder.append({
          type: NOTE_CREATED,
          entityType: 'note',
          entityId: noteId,
          payload: { title: 't', body: 'a0' },
        }),
        aBuilder.append({
          type: NOTE_EDITED,
          entityType: 'note',
          entityId: noteId,
          payload: { body: 'a1' },
        }),
      ],
    );
    // B, offline (cursor 0), edits.
    await processPushBatch(
      depsWith({ systemIdentity, idSeed: 810 }),
      { deviceId: devB.deviceId, tenantId: member.tenantId },
      [
        bBuilder.append({
          type: NOTE_EDITED,
          entityType: 'note',
          entityId: noteId,
          payload: { body: 'b1' },
        }),
      ],
    );
    // C, also offline (cursor 0), edits — conflicting with BOTH A and B.
    await processPushBatch(
      depsWith({ systemIdentity, idSeed: 820 }),
      { deviceId: devC.deviceId, tenantId: member.tenantId },
      [
        cBuilder.append({
          type: NOTE_EDITED,
          entityType: 'note',
          entityId: noteId,
          payload: { body: 'c1' },
        }),
      ],
    );

    // … matched by the real engine: 1 conflict from B's push (B×A) + 2 from C's (C×A, C×B) = 3.
    const conflicts = await readConflicts();
    expect(conflicts).toHaveLength(3);
    expect(conflicts.every((c) => c.severity === 'minor')).toBe(true);
    // 01 §8.3: minor → auto_resolved, terminal, recorded but surfaced to nobody.
    expect(conflicts.every((c) => c.status === 'auto_resolved')).toBe(true);

    // Every pair is DISTINCT and unordered-unique — the dedupe's actual claim.
    const pairs = conflicts.map((c) => [c.opAId, c.opBId].sort().join('|'));
    expect(new Set(pairs).size).toBe(3);

    // LWW stands alongside (01 §8.3's minor row: "the canonically-later body wins"), and no edit
    // was lost from the log — §3.6's `edit_count` = total edits from all devices.
    const note = await testDb.db
      .selectFrom('notes')
      .select(['body', 'editCount'])
      .where('id', '=', noteId)
      .executeTakeFirstOrThrow();
    expect(note.body).toBe('c1'); // C is canonically last (latest timestamp)
    expect(Number(note.editCount)).toBe(3);
  });
});

describe('the hook (03 §7)', () => {
  test('fires once POST-COMMIT for a surfaced conflict, never for a minor one', async () => {
    const { member, systemIdentity, builder: aBuilder } = await setupTenant(1800);
    const { other, builder: bBuilder } = await addDevice(member, 1801);
    const noteId = makeWorld(1802, serverCryptoPort).storeId;
    const fired: SurfacedConflict[] = [];
    const onConflictSurfaced = async (c: SurfacedConflict): Promise<void> => {
      // POST-COMMIT is observable from in here: the conflict row is already visible to a handle
      // OUTSIDE the push transaction. Inside it, this read would find nothing.
      const rows = await testDb.db
        .selectFrom('conflicts')
        .select('id')
        .where('id', '=', c.conflictId)
        .execute();
      expect(rows).toHaveLength(1);
      fired.push(c);
    };

    await processPushBatch(
      depsWith({ systemIdentity, onConflictSurfaced }),
      { deviceId: member.deviceId, tenantId: member.tenantId },
      [
        aBuilder.append({
          type: NOTE_CREATED,
          entityType: 'note',
          entityId: noteId,
          payload: { title: 't', body: 'a' },
        }),
        aBuilder.append({
          type: NOTE_EDITED,
          entityType: 'note',
          entityId: noteId,
          payload: { body: 'edit-a' },
        }),
        aBuilder.append({
          type: NOTE_ARCHIVED,
          entityType: 'note',
          entityId: noteId,
          payload: {},
        }),
      ],
    );
    expect(fired).toHaveLength(0); // nothing collided yet

    // B's edit is BOTH a Rule-1 minor collision with A's edit AND a Rule-2 significant
    // edit-after-archive. The hook must fire for exactly the significant one.
    await processPushBatch(
      depsWith({ systemIdentity, onConflictSurfaced, idSeed: 800 }),
      { deviceId: other.deviceId, tenantId: other.tenantId },
      [
        bBuilder.append({
          type: NOTE_EDITED,
          entityType: 'note',
          entityId: noteId,
          payload: { body: 'edit-b' },
        }),
      ],
    );

    const conflicts = await readConflicts();
    // TWO conflicts recorded (one per rule) …
    expect(conflicts.map((c) => c.severity).sort()).toEqual(['minor', 'significant']);
    // … but the hook fired ONCE, for the surfaced one only. `minor → auto_resolved` is "recorded;
    // feeds reporting; no user action" (03 §7) — nobody is notified.
    expect(fired).toHaveLength(1);
    expect(fired[0]?.category).toBe('conflict');
    expect(fired[0]?.storeId).toBe(member.storeId);
    const surfacedRow = conflicts.find((c) => c.severity === 'significant');
    expect(fired[0]?.conflictId).toBe(surfacedRow?.id);
  });
});
