// THE mediaRef → ENVELOPE BINDING GATE (task 140 Leg B) — the server used to accept a v3
// `notes.note_created` whose `mediaRef` carried a `userId`/`deviceId` that were NOT the envelope's
// authenticated signer, fold it, and stamp `notes.media_id/media_sha256/media_mime`. Nothing bound
// the ref to the signer, so device A could sign a note whose ref names device B's `mediaId`, and a
// puller would render B's photo as A's repair evidence (06 §6; task 140 composed attack). Leg A
// (client pre-display hash) is merged; this closes the SERVER arm.
//
// THE RULE (05 §9 / 06 §3.2): a `mediaRef` is self-describing — in v0 its `userId`/`deviceId`
// duplicate the envelope because capture and attach happen in one command (06 §3.2). The scope step
// (pipeline step 5, scope.ts) binds them to the envelope signer exactly as §9.1 binds the op
// deviceId to the token device. A mismatch is a PER-OP `SCOPE_VIOLATION` — never a whole-batch
// failure: security-guide §4.1 requires honest siblings in the same batch to still commit (the
// property task 139 protects). It runs BEFORE the schema step, so it only fires on a
// STRUCTURALLY-VALID ref whose ids are strings that mismatch; a malformed ref stays SCHEMA_INVALID.
//
// THIS DRIVES THE REAL HTTP SURFACE — production `createApp` + the production `serverOpRegistry`
// (real v3 schema AND the real applier that folds it) over real PG16. The DB that answered is
// asserted (T-14d). A hand-built registry would prove nothing: the whole point is that the SAME
// scope step and SAME applier production runs.
//
// FALSIFICATION (§2.11): remove the mediaRef-binding block in `steps/scope.ts` (== the pre-fix
// state) → REPRO/MISMATCH-USER go GREEN-for-the-wrong-reason (200 accepted, op DURABLY LOGGED,
// note row folded with the substituted hash — the exact reproduction), SIBLING loses its rejected
// leg, while the POSITIVE CONTROL and NO-MEDIA legs stay green. Restore → green. Verbatim in the
// task Outcome.
import type { SignedOperation } from '@bolusi/schemas';
import { makeWorld, resign, type ChainBuilder, type ChainWorld } from '@bolusi/test-support';
import { beforeEach, afterEach, describe, expect, test } from 'vitest';

import { serverOpRegistry } from '../../../src/deps.js';
import { serverCryptoPort } from '../../../src/oplog/index.js';
import { makeSyncHarness, type SyncHarness } from './helpers.js';

let h: SyncHarness;

beforeEach(async () => {
  // The PRODUCTION registry, not the suite's `testRegistry`: this file is about what the real v3
  // schema + applier do under the real scope step, so a stand-in would answer a different question.
  h = await makeSyncHarness({ registry: serverOpRegistry });
}, 120_000);

afterEach(async () => {
  await h.close();
});

/**
 * A v3 `note_created` payload whose `mediaRef` ids are caller-supplied. A CORRECTLY-bound ref sets
 * `userId`/`deviceId` = the envelope's; the attack sets one of them to another device's id. The ids
 * are VALID UUIDs (from `makeWorld`) so the payload passes the v3 Zod schema — only the scope step
 * can reject the mismatch, never SCHEMA_INVALID (which would make this file green for the wrong
 * reason: a non-uuid would be rejected by the schema gate before the binding check ever ran).
 */
function v3PayloadWithRef(
  ids: { readonly userId: string; readonly deviceId: string },
  title: string,
): Record<string, unknown> {
  return {
    title,
    body: `body-${title}`,
    mediaRef: {
      mediaId: '01920000-0000-7000-8000-0000000f000a',
      sha256: 'e'.repeat(64),
      mime: 'image/jpeg',
      type: 'image',
      sizeBytes: 4_211,
      capturedAt: 1_726_000_000_000,
      location: null,
      userId: ids.userId,
      deviceId: ids.deviceId,
    },
  };
}

/**
 * A `notes.note_created` chained by the builder, re-signed to claim the given `payload` at v3.
 * `resign` recomputes hash + signature over the mutated core, so the op is GENUINELY signed for
 * whatever payload it claims — the scope step, never a bad signature, decides it.
 *
 * `previousHash` is overridable because re-signing CHANGES the op's hash: a second op in the same
 * batch must be re-linked to the FIRST op's post-resign hash or the chain step rejects it
 * `CHAIN_BROKEN` before the scope step ever runs — which would make the sibling test green for the
 * wrong reason (§2.11).
 */
function noteCreatedV3(
  world: ChainWorld,
  builder: ChainBuilder,
  payload: Record<string, unknown>,
  previousHash?: string,
): SignedOperation {
  const built = builder.append({ type: 'notes.note_created', entityType: 'note', payload });
  const core = {
    ...built,
    schemaVersion: 3,
    payload,
    previousHash: previousHash ?? built.previousHash,
  };
  return resign(core, world.secretKey, serverCryptoPort);
}

interface PushResult {
  readonly id: string;
  readonly status: string;
  readonly code?: string;
}

async function readResults(response: Response): Promise<readonly PushResult[]> {
  const body = (await response.json()) as { results?: readonly PushResult[] };
  return body.results ?? [];
}

/** Is this op id DURABLY in the append-only log? The §4.1 property is about the log, not the reply. */
async function logHas(id: string): Promise<boolean> {
  const rows = await h.db.selectFrom('operations').select('id').where('id', '=', id).execute();
  return rows.length > 0;
}

async function noteRow(
  entityId: string,
): Promise<{ title: string; mediaId: string | null; mediaSha256: string | null } | undefined> {
  const rows = await h.db
    .selectFrom('notes')
    .select(['title', 'mediaId', 'mediaSha256'])
    .where('id', '=', entityId)
    .execute();
  return rows[0];
}

/** Seed a device and land its genesis, so each leg's batch contains only the ops under test. */
async function seedAtGenesis(
  seed: number,
): Promise<{ world: ChainWorld; builder: ChainBuilder; auth: string }> {
  const { world, builder, auth } = await h.seedDevice(seed);
  const genesis = builder.genesis();
  const response = await h.push(auth, world.deviceId, [genesis]);
  expect(response.status).toBe(200);
  expect((await readResults(response))[0]?.status).toBe('accepted');
  return { world, builder, auth };
}

/** VALID-but-DIFFERENT ids standing for "another device B's" capture — the substituted ref's claim.
 *  They need not (and here do not) exist server-side: that the server can't look them up at push is
 *  the whole point (media uploads independently, FR-1138) — see the residual in task 140. */
const OTHER = makeWorld(9_140_140, serverCryptoPort);

describe('mediaRef userId/deviceId are bound to the envelope signer at push (task 140 Leg B)', () => {
  test('provenance — the DB that answered (T-14d)', () => {
    console.log(`[task-140B] mediaRef binding gate — real PG16 database: ${h.provenance}`);
    expect(h.provenance).not.toBe('');
  });

  // ── REPRO: a mismatched-DEVICE ref is rejected per-op, never logged, never folded ─────────────
  test('REPRO — mediaRef.deviceId ≠ envelope → 200 rejected/SCOPE_VIOLATION, not logged, not folded', async () => {
    const { world, builder, auth } = await seedAtGenesis(6101);
    // The attack: A's envelope (world.deviceId), a ref claiming device B's id.
    const attack = noteCreatedV3(
      world,
      builder,
      v3PayloadWithRef({ userId: world.userId, deviceId: OTHER.deviceId }, 'palsu'),
    );

    const response = await h.push(auth, world.deviceId, [attack]);

    // BEFORE the fix this is 200 accepted with a serverSeq, the op is in `operations`, and a `notes`
    // row is folded carrying `media_sha256 = 'e'*64` — B's-photo-as-A's-evidence, server-side.
    expect(response.status).toBe(200);
    expect((await readResults(response))[0]).toMatchObject({
      status: 'rejected',
      code: 'SCOPE_VIOLATION',
    });
    expect(await logHas(attack.id)).toBe(false);
    expect(await noteRow(attack.entityId)).toBeUndefined();
  });

  // ── A mismatched-USER ref is likewise rejected (both halves of the binding are load-bearing) ──
  test('MISMATCH-USER — mediaRef.userId ≠ envelope → 200 rejected/SCOPE_VIOLATION, not logged', async () => {
    const { world, builder, auth } = await seedAtGenesis(6102);
    const attack = noteCreatedV3(
      world,
      builder,
      v3PayloadWithRef({ userId: OTHER.userId, deviceId: world.deviceId }, 'palsu2'),
    );

    const response = await h.push(auth, world.deviceId, [attack]);

    expect(response.status).toBe(200);
    expect((await readResults(response))[0]).toMatchObject({
      status: 'rejected',
      code: 'SCOPE_VIOLATION',
    });
    expect(await logHas(attack.id)).toBe(false);
  });

  // ── security-guide §4.1: one bad op must not poison honest neighbours ─────────────────────────
  test('SIBLING — an honest v3 media op in the SAME batch is accepted AND DURABLY LOGGED', async () => {
    const { world, builder, auth } = await seedAtGenesis(6103);
    // A correctly-bound note (its ref names the envelope's own device) and, chained after it, the
    // substitution attempt. The good op must survive its poisoned neighbour.
    const good = noteCreatedV3(
      world,
      builder,
      v3PayloadWithRef({ userId: world.userId, deviceId: world.deviceId }, 'jujur'),
    );
    const attack = noteCreatedV3(
      world,
      builder,
      v3PayloadWithRef({ userId: world.userId, deviceId: OTHER.deviceId }, 'palsu3'),
      good.hash,
    );

    const response = await h.push(auth, world.deviceId, [good, attack]);

    expect(response.status).toBe(200);
    const results = await readResults(response);
    expect(results[0]).toMatchObject({ id: good.id, status: 'accepted' });
    expect(results[1]).toMatchObject({
      id: attack.id,
      status: 'rejected',
      code: 'SCOPE_VIOLATION',
    });
    // Assert the LOG, not just the reply: §4.1 is a durability property (task 139), and a per-op
    // reply not backed by a committed row would be the same defect wearing a 200 (§2.11).
    expect(await logHas(good.id)).toBe(true);
    expect(await logHas(attack.id)).toBe(false);
    expect(await noteRow(good.entityId)).toMatchObject({
      title: 'jujur',
      mediaSha256: 'e'.repeat(64),
    });
  });

  // ── POSITIVE CONTROL: a correctly-bound ref is accepted and folded ────────────────────────────
  //
  // Without this the fix could be "reject EVERY v3 media op" and still look green on the rejects.
  test('POSITIVE CONTROL — a correctly-bound ref (ids = envelope) is accepted and folded', async () => {
    const { world, builder, auth } = await seedAtGenesis(6104);
    const legit = noteCreatedV3(
      world,
      builder,
      v3PayloadWithRef({ userId: world.userId, deviceId: world.deviceId }, 'sah'),
    );

    const response = await h.push(auth, world.deviceId, [legit]);

    expect(response.status).toBe(200);
    expect((await readResults(response))[0]).toMatchObject({ status: 'accepted' });
    expect(await logHas(legit.id)).toBe(true);
    expect(await noteRow(legit.entityId)).toMatchObject({
      title: 'sah',
      mediaId: '01920000-0000-7000-8000-0000000f000a',
      mediaSha256: 'e'.repeat(64),
    });
  });

  // ── A v3 note with NO photo (mediaRef present-and-null, 05 §3) has nothing to bind → accepted ─
  test('NO-MEDIA — a v3 note whose mediaRef is null is unaffected by the binding check', async () => {
    const { world, builder, auth } = await seedAtGenesis(6105);
    const legit = noteCreatedV3(world, builder, {
      title: 'tanpa foto',
      body: 'no photo',
      mediaRef: null,
    });

    const response = await h.push(auth, world.deviceId, [legit]);

    expect(response.status).toBe(200);
    expect((await readResults(response))[0]).toMatchObject({ status: 'accepted' });
    expect(await noteRow(legit.entityId)).toMatchObject({ title: 'tanpa foto', mediaId: null });
  });
});
