// THE OLD-VERSION PAYLOAD GATE (task 127) — task 121 closed the version BOUNDARY (`> current`,
// non-integer); this closes its INTERIOR. A `schemaVersion` in `1..current-1` used to resolve to
// `validate: () => true` (deps.ts), so a v1/v2 `notes.note_created` payload was accepted with ZERO
// validation, entered the append-only log, and then threw inside the applier — an exception that
// propagates out of `forTenant` and rolls back the WHOLE push transaction (pipeline.ts), surfacing
// as `500 INTERNAL` (app.ts).
//
// WHY THAT IS HIGH, NOT COSMETIC. Two separate contracts break at once:
//   1. security-guide §4.1 — "one bad op must not poison honest neighbors, except behind a
//      CHAIN_BROKEN halt". The batch rollback takes the honest sibling ops down with it.
//   2. The client reads a 500 as a TRANSPORT failure (core/src/sync/loop.ts), keeps the ops `local`
//      (push.ts) and re-sends the identical batch forever (backoff.ts caps at 5 min and never
//      gives up). One malformed op wedges that device's sync permanently.
//
// THE FIX IS RETAINED PER-VERSION SCHEMAS, not "validate old payloads against the current schema":
// a legitimate v2 payload carries `mediaId`, which v3's `.strict()` rejects, so re-using the current
// schema would reject exactly the rolling-out old client task 121 was careful to keep working. The
// registry now carries `payloadByVersion` (04 §3), so `resolve(type, v)` has a REAL schema for every
// foldable `v`, which is what 05 §8's "(type, schemaVersion)" wording already presumed.
//
// THIS DRIVES THE REAL HTTP SURFACE — production `createApp` + the production `serverOpRegistry`
// (real SERVER_MODULES: the real v1/v2/v3 schemas AND the real applier that folds them) over real
// PG16. A hand-built registry would prove nothing: the whole point is the SAME registry validation
// and the SAME applier production runs. The DB that answered is asserted (T-14d).
//
// FALSIFICATION (§2.11): restore `deps.ts`'s `if (schemaVersion !== currentVersion) return
// { kind: 'known', validate: () => true }` — every REJECT leg below returns 500 with an undefined
// body (the batch rollback), while the POSITIVE CONTROLS stay green. Restore → green. Verbatim in
// the task Outcome.
import type { SignedOperation } from '@bolusi/schemas';
import { resign, type ChainBuilder, type ChainWorld } from '@bolusi/test-support';
import { beforeEach, afterEach, describe, expect, test } from 'vitest';

import { serverOpRegistry } from '../../../src/deps.js';
import { serverCryptoPort } from '../../../src/oplog/index.js';
import { makeSyncHarness, type SyncHarness } from './helpers.js';

let h: SyncHarness;

beforeEach(async () => {
  // The PRODUCTION registry, not the suite's `testRegistry`: this file is about what the real
  // per-version schemas do, so a stand-in would answer a different question (T-15).
  h = await makeSyncHarness({ registry: serverOpRegistry });
}, 120_000);

afterEach(async () => {
  await h.close();
});

/** A valid CURRENT (v3) `note_created` payload — `{title, body, mediaRef}` (01 §9). */
function v3Payload(world: ChainWorld, title: string): Record<string, unknown> {
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
      userId: world.userId,
      deviceId: world.deviceId,
    },
  };
}

/**
 * A `notes.note_created` chained by the builder, re-signed to claim `schemaVersion`/`payload`.
 * `resign` recomputes hash + signature over the mutated core, so the op is GENUINELY signed for
 * whatever (version, payload) it claims — the schema gate, never a bad signature, decides it.
 *
 * `previousHash` is overridable because re-signing CHANGES the op's hash: the builder's own head
 * still points at the pre-resign hash, so a second op in the same batch must be re-linked to the
 * FIRST op's post-resign hash or the chain step rejects it `CHAIN_BROKEN` before the schema step
 * ever runs — which would make this file green for the wrong reason (§2.11).
 */
function noteCreatedAt(
  world: ChainWorld,
  builder: ChainBuilder,
  schemaVersion: number,
  payload: Record<string, unknown>,
  previousHash?: string,
): SignedOperation {
  const built = builder.append({ type: 'notes.note_created', entityType: 'note', payload });
  const core = {
    ...built,
    schemaVersion,
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

describe('old-version note_created payloads — validated per version, never accepted-then-thrown', () => {
  test('provenance — the DB that answered (T-14d)', () => {
    console.log(`[task-127] old-version payload gate — real PG16 database: ${h.provenance}`);
    expect(h.provenance).not.toBe('');
  });

  // ── HTTP-A: a malformed OLD-version payload is a PER-OP rejection, not a 500 ──────────────────
  test('HTTP-A(i) — v2 with an EMPTY payload → 200 rejected/SCHEMA_INVALID, never logged', async () => {
    const { world, builder, auth } = await seedAtGenesis(4701);
    const junk = noteCreatedAt(world, builder, 2, {});

    const response = await h.push(auth, world.deviceId, [junk]);

    // BEFORE the fix this is 500 `{"error":{"code":"INTERNAL"}}`: the payload passed unvalidated,
    // the applier hit `null value in column "title"`, and the throw rolled the batch back.
    expect(response.status).toBe(200);
    expect((await readResults(response))[0]).toMatchObject({
      status: 'rejected',
      code: 'SCHEMA_INVALID',
    });
    expect(await logHas(junk.id)).toBe(false);
    expect(await noteRow(junk.entityId)).toBeUndefined();
  });

  test('HTTP-A(ii) — v2 whose mediaId is not a uuid → 200 rejected/SCHEMA_INVALID, never logged', async () => {
    // The v2 applier writes `payload.mediaId` straight into `notes.media_id uuid` (10-db §8), so a
    // non-uuid is UNFOLDABLE by construction: `invalid input syntax for type uuid`. A retained v2
    // schema that admitted it would be a guard that permits the thing it exists to stop (§2.11).
    const { world, builder, auth } = await seedAtGenesis(4702);
    const junk = noteCreatedAt(world, builder, 2, {
      title: 'Catatan',
      body: 'lama',
      mediaId: 'NOT-A-UUID-AT-ALL',
    });

    const response = await h.push(auth, world.deviceId, [junk]);

    expect(response.status).toBe(200);
    expect((await readResults(response))[0]).toMatchObject({
      status: 'rejected',
      code: 'SCHEMA_INVALID',
    });
    expect(await logHas(junk.id)).toBe(false);
  });

  test('HTTP-A(iii) — v1 carrying an unknown key → 200 rejected/SCHEMA_INVALID (the retained schema is strict)', async () => {
    // 04 §3: payload schemas are `.strict()`. That rule holds for a RETAINED version too — a v1 op
    // used to be accepted with any keys at all, so "claim v1" was a universal bypass of §3's
    // unknown-key rule for every type whose current version is > 1.
    const { world, builder, auth } = await seedAtGenesis(4703);
    const junk = noteCreatedAt(world, builder, 1, {
      title: 'Catatan',
      body: 'lama',
      whateverIWant: 'anything at all',
    });

    const response = await h.push(auth, world.deviceId, [junk]);

    expect(response.status).toBe(200);
    expect((await readResults(response))[0]).toMatchObject({
      status: 'rejected',
      code: 'SCHEMA_INVALID',
    });
    expect(await logHas(junk.id)).toBe(false);
  });

  // ── HTTP-B: the security-guide §4.1 property — one bad op must not poison honest neighbours ───
  test('HTTP-B — an honest sibling in the same batch is accepted AND DURABLY LOGGED', async () => {
    const { world, builder, auth } = await seedAtGenesis(4704);
    const good = noteCreatedAt(world, builder, 3, v3Payload(world, 'jujur'));
    const junk = noteCreatedAt(world, builder, 2, {}, good.hash);

    const response = await h.push(auth, world.deviceId, [good, junk]);

    // BEFORE: 500, `ops in log: 0`, good op logged FALSE, `notes` rows []. The honest op was
    // poisoned by its neighbour — security-guide §4.1 violated literally.
    expect(response.status).toBe(200);
    const results = await readResults(response);
    expect(results[0]).toMatchObject({ id: good.id, status: 'accepted' });
    expect(results[1]).toMatchObject({ id: junk.id, status: 'rejected', code: 'SCHEMA_INVALID' });
    // Assert the LOG, not the reply: §4.1 is a durability property, and a per-op reply that is not
    // backed by a committed row would be the same defect wearing a 200 (§2.11).
    expect(await logHas(good.id)).toBe(true);
    expect(await logHas(junk.id)).toBe(false);
    expect(await noteRow(good.entityId)).toMatchObject({ title: 'jujur' });
  });

  // ── POSITIVE CONTROLS: legitimate old versions still accept and fold ──────────────────────────
  //
  // Without these the fix could be "reject everything below current" and still look green — which
  // is the exact over-correction task 121 documented and deliberately avoided.
  test('POSITIVE CONTROL — a legitimate v2 payload is still accepted and folded (mediaId, no hash)', async () => {
    const { world, builder, auth } = await seedAtGenesis(4705);
    const mediaId = '01920000-0000-7000-8000-00000000beef';
    const legit = noteCreatedAt(world, builder, 2, {
      title: 'Klien v2',
      body: 'masih jalan',
      mediaId,
    });

    const response = await h.push(auth, world.deviceId, [legit]);

    expect(response.status).toBe(200);
    expect((await readResults(response))[0]).toMatchObject({ status: 'accepted' });
    expect(await logHas(legit.id)).toBe(true);
    // Folded by the v2 branch: the id lands, the SIGNED hash does not — v2 never carried one, and
    // there is nowhere honest to get it from now (applier.ts).
    expect(await noteRow(legit.entityId)).toMatchObject({
      title: 'Klien v2',
      mediaId,
      mediaSha256: null,
    });
  });

  test('POSITIVE CONTROL — a legitimate v1 payload is still accepted and folded (no media at all)', async () => {
    const { world, builder, auth } = await seedAtGenesis(4706);
    const legit = noteCreatedAt(world, builder, 1, { title: 'Klien v1', body: 'paling tua' });

    const response = await h.push(auth, world.deviceId, [legit]);

    expect(response.status).toBe(200);
    expect((await readResults(response))[0]).toMatchObject({ status: 'accepted' });
    expect(await logHas(legit.id)).toBe(true);
    expect(await noteRow(legit.entityId)).toMatchObject({
      title: 'Klien v1',
      mediaId: null,
      mediaSha256: null,
    });
  });

  test('POSITIVE CONTROL — the CURRENT version (v3) is unaffected', async () => {
    const { world, builder, auth } = await seedAtGenesis(4707);
    const legit = noteCreatedAt(world, builder, 3, v3Payload(world, 'sekarang'));

    const response = await h.push(auth, world.deviceId, [legit]);

    expect(response.status).toBe(200);
    expect((await readResults(response))[0]).toMatchObject({ status: 'accepted' });
    expect(await noteRow(legit.entityId)).toMatchObject({
      title: 'sekarang',
      mediaSha256: 'e'.repeat(64),
    });
  });
});
