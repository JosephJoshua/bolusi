// THE DEVICE→STORE WRITE-SCOPE GATE (task 157, owner ruling D22, SEC-TENANT-06) — the server used
// to ACCEPT an op whose `storeId` was ANOTHER store of the pushing device's tenant: a mechanic's
// device at Branch A could sign a note and write it into Branch B's book, and Branch B's devices
// were even POKED to pull it (05 §9.2 gap; HTTP-E in the 114/141 adversarial sweep). This closes it.
//
// THE RULE (05 §9.2): a device may write only ops scoped to its OWN store. An op whose `storeId` is
// a store of the tenant OTHER than the pushing device's `store_id` is a PER-OP `SCOPE_VIOLATION` —
// never a whole-batch failure (security-guide §4.1: honest siblings in the same batch still commit,
// the property tasks 139/140B protect). It is an ADDITIONAL, narrower scope on top of the §9.2
// tenant/store checks and RLS, never a replacement.
//
// THE CARVE-OUT (01 §6, §3.6; 02-permissions §5.2; 10-db §4). The runtime stamps the device's store
// into every STORE-scoped op it appends, so `op.storeId == device.storeId` for those. But a MEMBER
// device also legitimately emits TENANT-scoped ops with `storeId = null` — `platform.user_locale_
// changed`, whose preference "follows the user to every device" (01 §6) — so the rule lets `null`
// through and rejects only a NON-NULL store that differs. Member devices always carry a `store_id`
// (10-db §4 CHECK `kind = 'system' OR store_id IS NOT NULL`).
//
// The tenant SYSTEM device is carved out, and NOT because it is store-less: its only op,
// `platform.conflict_detected`, carries a NON-null `storeId` (the conflicted entity's store), so the
// rule WOULD reject it if it ever reached here. The carve-out rests ENTIRELY on the fact that it
// never does — system ops are built by `appendSystemOp`, which INSERTs straight through and never
// calls `checkScope` (01 §3.6). Routing them through push would break conflict detection at that
// line, deliberately.
//
// THIS DRIVES THE REAL HTTP SURFACE — production `createApp` + `serverOpRegistry` (the real v3 notes
// schema AND applier, and the real `platform.user_locale_changed` fold) over real PG16, with the DB
// that answered asserted (T-14d) — exactly as task 140 Leg B. A hand-built registry would prove
// nothing: the point is that the SAME scope step and SAME appliers production runs decide it.
//
// FALSIFICATION (§2.11): remove the store-scope block in `steps/scope.ts` (== the pre-fix state) →
// the CROSS-STORE and SIBLING legs go GREEN-for-the-wrong-reason (200 accepted, op DURABLY LOGGED, a
// `notes` row folded into the FOREIGN store, and a store-2 poke fired — the exact reproduction),
// while the two POSITIVE CONTROLS (own-store + tenant-scoped null) stay green. Restore → green.
// Verbatim in the task Outcome.
import type { SignedOperation } from '@bolusi/schemas';
import { type ChainBuilder, type ChainWorld } from '@bolusi/test-support';
import { beforeEach, afterEach, describe, expect, test } from 'vitest';

import { serverOpRegistry } from '../../../src/deps.js';
import { makeSyncHarness, type SyncHarness } from './helpers.js';

let h: SyncHarness;

beforeEach(async () => {
  // The PRODUCTION registry, not the suite's `testRegistry`: the notes fold and the tenant-scoped
  // locale fold must be the real ones, so a stand-in would answer a different question (task 140 B).
  h = await makeSyncHarness({ registry: serverOpRegistry });
}, 120_000);

afterEach(async () => {
  await h.close();
});

interface PushResult {
  readonly id: string;
  readonly status: string;
  readonly code?: string;
}

async function readResults(response: Response): Promise<readonly PushResult[]> {
  const body = (await response.json()) as { results?: readonly PushResult[] };
  return body.results ?? [];
}

/** Is this op id DURABLY in the append-only log? §4.1 is about the log, not the reply (task 139). */
async function logHas(id: string): Promise<boolean> {
  const rows = await h.db.selectFrom('operations').select('id').where('id', '=', id).execute();
  return rows.length > 0;
}

/** The store a folded `notes` row landed in — `undefined` when the op never folded. */
async function noteStore(entityId: string): Promise<string | undefined> {
  const rows = await h.db
    .selectFrom('notes')
    .select('storeId')
    .where('id', '=', entityId)
    .execute();
  return rows[0]?.storeId ?? undefined;
}

/** The victim row's mutable state — what a cross-store mutation would have changed. */
async function noteState(
  entityId: string,
): Promise<{ body: string; archived: boolean; storeId: string } | undefined> {
  const rows = await h.db
    .selectFrom('notes')
    .select(['body', 'archived', 'storeId'])
    .where('id', '=', entityId)
    .execute();
  const row = rows[0];
  return row === undefined
    ? undefined
    : { body: row.body, archived: Boolean(row.archived), storeId: row.storeId };
}

async function anomalyKinds(deviceId: string): Promise<string[]> {
  const rows = await h.db
    .selectFrom('deviceAnomalies')
    .select('kind')
    .where('deviceId', '=', deviceId)
    .execute();
  return rows.map((r) => r.kind);
}

/**
 * A v3 `notes.note_created` (no photo) at an OVERRIDDEN `storeId`.
 *
 * Built through `builder.append` at `schemaVersion: 3` rather than re-signed after the fact: the
 * builder signs the final core AND keeps its chain head, so ONLY the scope step can reject it (never
 * a bad signature, never SCHEMA_INVALID — the payload is a valid v3 note) and any FOLLOWING op in
 * the same chain links correctly. Re-signing would advance the head to the pre-resign hash and the
 * next op would be CHAIN_BROKEN before the scope step ever ran — which is exactly how this file's
 * same-store positive control first went red for the wrong reason.
 */
function noteV3(
  world: ChainWorld,
  builder: ChainBuilder,
  title: string,
  opts: {
    readonly storeId?: string | null;
    readonly body?: string;
  } = {},
): SignedOperation {
  return builder.append({
    type: 'notes.note_created',
    entityType: 'note',
    schemaVersion: 3,
    payload: { title, body: opts.body ?? `body-${title}`, mediaRef: null },
    ...(opts.storeId !== undefined ? { storeId: opts.storeId } : {}),
  });
}

/** Seed a member device (store-1), land its genesis, and add a SECOND store to its tenant. */
async function seedTwoStores(
  seed: number,
): Promise<{ world: ChainWorld; builder: ChainBuilder; auth: string; store2: string }> {
  const { world, builder, auth } = await h.seedDevice(seed);
  const genesis = builder.genesis();
  const response = await h.push(auth, world.deviceId, [genesis]);
  expect(response.status).toBe(200);
  expect((await readResults(response))[0]?.status).toBe('accepted');
  const store2 = await h.seedStore(world.tenantId, seed + 500_000);
  return { world, builder, auth, store2 };
}

describe('a member device may write only its own store’s ops (task 157, D22, SEC-TENANT-06)', () => {
  test('provenance — the DB that answered (T-14d)', () => {
    console.log(`[task-157] device→store write-scope gate — real PG16 database: ${h.provenance}`);
    expect(h.provenance).not.toBe('');
  });

  // ── REPRO (HTTP-E): a store-1 device's store-2 op is rejected per-op, never logged, never poked ─
  test('SEC-TENANT-06 an op scoped to ANOTHER store of the tenant → 200 rejected/SCOPE_VIOLATION, not logged, not folded, no cross-store poke', async () => {
    const { world, builder, auth, store2 } = await seedTwoStores(7101);
    const cross = noteV3(world, builder, 'lintas', { storeId: store2 });
    const pokesBefore = h.pokes.length;

    const response = await h.push(auth, world.deviceId, [cross]);

    // BEFORE the fix this is 200 accepted with a serverSeq, the op is in `operations`, a `notes` row
    // is folded into store-2, AND `h.pokes` gains a store-2 scope — Branch A writing into Branch B.
    expect(response.status).toBe(200);
    expect((await readResults(response))[0]).toMatchObject({
      id: cross.id,
      status: 'rejected',
      code: 'SCOPE_VIOLATION',
    });
    expect(await logHas(cross.id)).toBe(false);
    expect(await noteStore(cross.entityId)).toBeUndefined();
    // A rejected op wakes nobody: `push.ts` pokes accepted ops only. No poke to the foreign store.
    expect(h.pokes.slice(pokesBefore).some((p) => p.storeId === store2)).toBe(false);
    // The tamper indicator the owner must see (security-guide §3.1, FR-829) — not a routine error.
    expect(await anomalyKinds(world.deviceId)).toContain('SCOPE_VIOLATION');
  });

  // ── security-guide §4.1: one cross-store op must not poison an honest neighbour ────────────────
  test('SEC-TENANT-06 an honest same-store sibling in the SAME batch as a cross-store op still commits and is DURABLY LOGGED', async () => {
    const { world, builder, auth, store2 } = await seedTwoStores(7102);
    const good = noteV3(world, builder, 'jujur'); // the device's OWN store (store-1)
    const cross = noteV3(world, builder, 'lintas', { storeId: store2 });

    const response = await h.push(auth, world.deviceId, [good, cross]);

    expect(response.status).toBe(200);
    const results = await readResults(response);
    expect(results[0]).toMatchObject({ id: good.id, status: 'accepted' });
    expect(results[1]).toMatchObject({ id: cross.id, status: 'rejected', code: 'SCOPE_VIOLATION' });
    // Assert the LOG, not just the reply: §4.1 is a durability property (task 139), and a per-op
    // reply not backed by a committed row would be the same defect wearing a 200 (§2.11).
    expect(await logHas(good.id)).toBe(true);
    expect(await logHas(cross.id)).toBe(false);
    expect(await noteStore(good.entityId)).toBe(world.storeId);
  });

  // ── POSITIVE CONTROL 1: a device pushing its OWN store's op is accepted and folded ─────────────
  //
  // Without this the fix could be "reject EVERY store-scoped op" and still look green on the reject.
  test('SEC-TENANT-06 POSITIVE CONTROL — a device pushing its OWN store’s op is accepted and folded', async () => {
    const { world, builder, auth } = await seedTwoStores(7103);
    const own = noteV3(world, builder, 'sah'); // storeId defaults to the device's own store (store-1)

    const response = await h.push(auth, world.deviceId, [own]);

    expect(response.status).toBe(200);
    expect((await readResults(response))[0]).toMatchObject({ id: own.id, status: 'accepted' });
    expect(await logHas(own.id)).toBe(true);
    expect(await noteStore(own.entityId)).toBe(world.storeId);
  });

  // ── POSITIVE CONTROL 2 (the carve-out): a legitimately TENANT-scoped op is accepted ────────────
  //
  // `platform.user_locale_changed` is tenant-scoped (`storeId = null`): the preference follows the
  // user to every device (01 §6). A member device emits it legitimately, so the rule must NOT be
  // "reject everything that isn't the device's store" — it must let a null store through. Without
  // this control the fix could reject every tenant-scoped op and break locale sync silently.
  test('SEC-TENANT-06 POSITIVE CONTROL — a legitimately TENANT-scoped op (storeId null) is accepted, so the rule does not reject everything but the device’s own store', async () => {
    const { world, builder, auth } = await seedTwoStores(7104);
    const locale = builder.append({
      type: 'platform.user_locale_changed',
      entityType: 'user_pref',
      entityId: world.userId,
      storeId: null,
      payload: { locale: 'en' },
    });

    const response = await h.push(auth, world.deviceId, [locale]);

    expect(response.status).toBe(200);
    expect((await readResults(response))[0]).toMatchObject({ id: locale.id, status: 'accepted' });
    expect(await logHas(locale.id)).toBe(true);
  });
});

// =================================================================================================
// THE MUTATION PATH — the hole the DECLARED-storeId rule above does NOT close on its own.
//
// The rule above guards the op's DECLARED `storeId`. The mutation appliers derive their effective
// store from `entityId` and (before this fix) never read `op.storeId` at all:
// `noteBodyEditedApplier`/`noteArchivedApplier` ran `UPDATE notes … WHERE id = op.entityId`, and
// `notes` RLS is TENANT-only (no store predicate — db-server security.ts `secureTenantTable`), so
// the UPDATE crossed stores inside the tenant. Two dodges reached it:
//   (A) `storeId = null`  — the declared-store rule only fires on a NON-null store, so null slipped
//       past. STRICTLY WORSE: a null-store op is pulled by EVERY device of the tenant
//       (`storeId = device.storeId OR storeId IS NULL`, api/01-sync §4.1), so the victim store's own
//       devices re-fold it and overwrite the note locally too.
//   (B) `storeId = <the attacker's OWN store>` — passes `op.storeId == device.storeId` trivially,
//       because the envelope never has to agree with the entity it names.
// `note_created` survived (A) only because its applier calls `noteStoreId`, which throws on null;
// edit and archive never did.
//
// THE TWO LEGS THAT CLOSE IT:
//   LEG 1 (scope step, general): a STORE-scoped op TYPE carrying `storeId = null` is malformed →
//     `SCOPE_VIOLATION`. Derived from the op-type's DECLARED scope
//     (`OperationDeclaration.scope`, default `'store'` — 01 §6 / 05 §2.1), read through the registry
//     seam, never a hardcoded list of notes types. `platform.user_locale_changed` is declared
//     `'tenant'`, so its legitimate null store still passes (the PC2 control above).
//   LEG 2 (applier, defense-in-depth): the mutation UPDATEs are constrained to the op's own store,
//     so a store mismatch is a no-op fold rather than a cross-store write.
//
// FALSIFICATION (§2.11): revert leg 1 → (A) and the archive dodge overwrite store-2 again; revert
// leg 2 → (B) overwrites store-2 again. Both restored → green, with the same-store positive control
// green throughout (proving neither leg broke legitimate editing).
describe('a device cannot MUTATE another store’s note via entityId (task 157 legs 1+2, SEC-TENANT-06)', () => {
  const PWNED = 'PWNED BY STORE-1 DEVICE';
  const HONEST = 'HONEST BODY';

  /**
   * A timestamp comfortably AFTER the victim's `note_created`, stamped on every attack op.
   *
   * NOT cosmetic — it is what makes these reproductions real. Both `ChainBuilder`s start from the
   * same base and step +1s per op, so an unstamped attack op lands on the SAME timestamp as the
   * victim's create and the canonical key `(timestamp, deviceId, seq)` falls through to `deviceId`.
   * When the attacker's device id sorts lower, the edit is canonically BEFORE the create: the fold
   * applies it to a row that does not exist yet (a no-op) and the create then inserts the honest
   * body — so the note survives by ACCIDENT OF ORDERING and the test passes while the hole is wide
   * open (CLAUDE.md §2.11, green for the wrong reason — this file's own DODGE B did exactly that on
   * the first run). Ordering the attack strictly after the create removes that alibi: the only thing
   * that can keep the note honest is the guard under test.
   */
  const AFTER_VICTIM = 1_726_000_500_000;

  /**
   * A store-1 attacker device + a note that genuinely lives in store-2, created by a store-2 device
   * through the real production path (so the victim row is exactly what normal use produces).
   */
  async function seedVictimNote(seed: number): Promise<{
    world: ChainWorld;
    builder: ChainBuilder;
    auth: string;
    store2: string;
    victimNoteId: string;
  }> {
    const { world, builder, auth, store2 } = await seedTwoStores(seed);
    const victim = await h.seedDeviceIn(world.tenantId, store2, seed + 900_000);
    const vGenesis = victim.builder.genesis();
    expect(
      (await readResults(await h.push(victim.auth, victim.world.deviceId, [vGenesis])))[0]?.status,
    ).toBe('accepted');
    const vNote = noteV3(victim.world, victim.builder, 'victim', { body: HONEST });
    expect(
      (await readResults(await h.push(victim.auth, victim.world.deviceId, [vNote])))[0]?.status,
    ).toBe('accepted');
    // The victim row is real, in store-2, and honest before the attack.
    expect(await noteState(vNote.entityId)).toMatchObject({
      body: HONEST,
      archived: false,
      storeId: store2,
    });
    return { world, builder, auth, store2, victimNoteId: vNote.entityId };
  }

  // ── DODGE A: null storeId on a STORE-scoped edit — closed by LEG 1 ────────────────────────────
  test('SEC-TENANT-06 a note_body_edited carrying storeId NULL cannot edit another store’s note (leg 1)', async () => {
    const { world, builder, auth, store2, victimNoteId } = await seedVictimNote(7201);
    const dodge = builder.append({
      type: 'notes.note_body_edited',
      entityType: 'note',
      entityId: victimNoteId,
      storeId: null, // dodges a rule that only fires on a NON-null store
      timestamp: AFTER_VICTIM,
      payload: { body: PWNED },
    });

    const response = await h.push(auth, world.deviceId, [dodge]);

    // BEFORE leg 1: accepted, logged, folded — store-2's body becomes PWNED, and because the op's
    // storeId is null EVERY store-2 device pulls and re-folds it (api/01-sync §4.1).
    expect(response.status).toBe(200);
    expect((await readResults(response))[0]).toMatchObject({
      id: dodge.id,
      status: 'rejected',
      code: 'SCOPE_VIOLATION',
    });
    // Not in the log ⇒ no device can ever pull or re-fold it. That is the null variant's real sting.
    expect(await logHas(dodge.id)).toBe(false);
    expect(await noteState(victimNoteId)).toMatchObject({
      body: HONEST,
      archived: false,
      storeId: store2,
    });
  });

  // ── DODGE B: the attacker's OWN storeId on an edit naming a foreign note — closed by LEG 2 ─────
  test('SEC-TENANT-06 a note_body_edited carrying the device’s OWN storeId cannot edit another store’s note (leg 2)', async () => {
    const { world, builder, auth, store2, victimNoteId } = await seedVictimNote(7202);
    const dodge = builder.append({
      type: 'notes.note_body_edited',
      entityType: 'note',
      entityId: victimNoteId,
      storeId: world.storeId, // its OWN store — passes `op.storeId == device.storeId` trivially
      timestamp: AFTER_VICTIM,
      payload: { body: PWNED },
    });

    const response = await h.push(auth, world.deviceId, [dodge]);

    // This op is legitimately SCOPED (it claims the device's own store), so the scope step cannot
    // and does not reject it — the envelope is self-consistent; only the ENTITY it names is foreign.
    // It is accepted and logged, and the applier must fold it to NOTHING (store mismatch → no-op).
    expect(response.status).toBe(200);
    expect((await readResults(response))[0]).toMatchObject({ id: dodge.id, status: 'accepted' });
    // BEFORE leg 2 the UPDATE matched on `id` alone and store-2's body became PWNED.
    expect(await noteState(victimNoteId)).toMatchObject({
      body: HONEST,
      archived: false,
      storeId: store2,
    });
  });

  // ── DODGE C: null storeId on a STORE-scoped archive — closed by LEG 1 ─────────────────────────
  test('SEC-TENANT-06 a note_archived carrying storeId NULL cannot archive another store’s note (leg 1)', async () => {
    const { world, builder, auth, store2, victimNoteId } = await seedVictimNote(7203);
    const dodge = builder.append({
      type: 'notes.note_archived',
      entityType: 'note',
      entityId: victimNoteId,
      storeId: null,
      timestamp: AFTER_VICTIM,
      payload: {},
    });

    const response = await h.push(auth, world.deviceId, [dodge]);

    expect(response.status).toBe(200);
    expect((await readResults(response))[0]).toMatchObject({
      id: dodge.id,
      status: 'rejected',
      code: 'SCOPE_VIOLATION',
    });
    expect(await logHas(dodge.id)).toBe(false);
    // BEFORE leg 1 this flipped store-2's note to archived — terminal and irreversible (01 §9).
    expect(await noteState(victimNoteId)).toMatchObject({ archived: false, storeId: store2 });
  });

  // ── POSITIVE CONTROL: neither leg may break a legitimate SAME-store edit + archive ────────────
  //
  // Without this, both legs could be "never fold a mutation" and every dodge test above would still
  // be green — the fix would have closed the hole by breaking the feature (§2.11).
  test('SEC-TENANT-06 POSITIVE CONTROL — a device editing and archiving its OWN store’s note still folds', async () => {
    const { world, builder, auth } = await seedTwoStores(7204);
    const own = noteV3(world, builder, 'mine', { body: HONEST });
    expect((await readResults(await h.push(auth, world.deviceId, [own])))[0]?.status).toBe(
      'accepted',
    );

    const edit = builder.append({
      type: 'notes.note_body_edited',
      entityType: 'note',
      entityId: own.entityId,
      payload: { body: 'legitimately edited' },
    });
    const archive = builder.append({
      type: 'notes.note_archived',
      entityType: 'note',
      entityId: own.entityId,
      payload: {},
    });

    const response = await h.push(auth, world.deviceId, [edit, archive]);

    expect(response.status).toBe(200);
    const results = await readResults(response);
    expect(results.map((r) => r.status)).toEqual(['accepted', 'accepted']);
    // The fold really happened — both mutations landed on the device's own note.
    expect(await noteState(own.entityId)).toMatchObject({
      body: 'legitimately edited',
      archived: true,
      storeId: world.storeId,
    });
  });
});
