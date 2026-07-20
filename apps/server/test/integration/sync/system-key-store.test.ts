// TASK 78 — the DirectorySystemKeyStore is what FLIPS conflict detection ON in production.
//
// conflict-wiring.test.ts already proves the push route THREADS `detectConflicts` when a key store
// is injected (with an inline test store). The gap this task closes is that production `main.ts`
// injected NOTHING, so `detectConflicts` was undefined and detection was a visible no-op. This
// suite proves the REAL production composition — `loadConfig → systemKeyStoreFromConfig →
// resolveDeps → runPush` — activates detection, and falsifies the wiring in BOTH directions on real
// PG16 (task 20/40's lesson: a mechanism wired in a test but not in the composition root is inert).
//
//   * WITH `SYSTEM_KEY_DIR` set + a real key present ⇒ a colliding push DETECTS, persists, and
//     surfaces a conflict, and it is acknowledgeable (task 108).
//   * WITHOUT `SYSTEM_KEY_DIR` (or with the store not injected) ⇒ detection is OFF, no conflict —
//     proving the store injection is precisely what activates it.
//   * `SYSTEM_KEY_DIR` set but the key is missing / malformed / the WRONG tenant's ⇒ the push FAILS
//     LOUD (never a silent detection-off).
//
// FORMAT (§2.8 — byte-identical to what `provision-tenant` writes, or detection silently never
// activates): filename `system-device-<tenantId>.key` (cli/provision-tenant.ts:269 `defaultKeyPath`),
// content `<base64>\n` (cli/provision-tenant.ts:323), base64 = `Buffer.from(secretKey).toString(
// 'base64')` of the raw Ed25519 secret (cli/provision-tenant.ts:70). The store reads utf8, `.trim()`s
// the newline, and `base64ToBytes`-decodes — the exact inverse.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sql, type Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, inject, test } from 'vitest';

import { ChainBuilder, makeWorld, type ChainWorld } from '@bolusi/test-support';
import { type DB, type ForTenant, type TenantDb } from '@bolusi/db-server';
import { createTestDatabase } from '@bolusi/db-server/testing';

import { loadConfig } from '../../../src/config.js';
import { resolveDeps, type ServerDeps } from '../../../src/deps.js';
import { serverCryptoPort } from '../../../src/oplog/crypto.js';
import { runPush, type PushDeps } from '../../../src/sync/push.js';
import type { SystemSigner } from '../../../src/oplog/system-op.js';
import {
  DirectorySystemKeyStore,
  systemKeyStoreFromConfig,
  type ReadKeyFile,
} from '../../../src/sync/system-key-store.js';
import { seedDevice, seedWorld } from '../oplog/helpers.js';

const APP_ROLE = 'bolusi_app';
const NOTE_CREATED = 'notes.note_created';
const NOTE_EDITED = 'notes.note_body_edited';
const NOTE_ARCHIVED = 'notes.note_archived';
const CONFLICT_ACK = 'platform.conflict_acknowledged';
// Fixed server clock so the seeded ops (base ~1_726_000_xxx) stay inside the 48h skew window (05 §6).
const NOW = 1_726_100_000_000;

let db: Kysely<DB>;
let appForTenant: ForTenant;
let closeDb: (() => Promise<void>) | undefined;
let keyDir: string;

function forTenantOn(handle: Kysely<DB>, role?: string): ForTenant {
  return <T>(tenantId: string, fn: (tdb: TenantDb) => Promise<T>) =>
    handle.transaction().execute(async (trx) => {
      if (role !== undefined) await sql`SET LOCAL ROLE ${sql.id(role)}`.execute(trx);
      await sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
      return fn(trx);
    });
}

beforeEach(async () => {
  // Real PG16 clone from the pre-migrated template (D16), fresh per test so `conflicts` starts empty.
  const handle = await createTestDatabase(
    {
      maintenanceUri: inject('pgMaintenanceUri'),
      baseUri: inject('pgBaseUri'),
      owner: inject('pgOwner'),
    },
    expect.getState().testPath,
  );
  db = handle.db;
  closeDb = handle.close;
  appForTenant = forTenantOn(db, APP_ROLE);
  keyDir = mkdtempSync(join(tmpdir(), 'bolusi-syskey-'));
}, 120_000);

afterEach(async () => {
  await closeDb?.();
  closeDb = undefined;
  rmSync(keyDir, { recursive: true, force: true });
});

/** The EXACT bytes `provision-tenant` writes for a tenant's key file (cli/provision-tenant.ts). */
function writeProvisionedKey(tenantId: string, secretKey: Uint8Array): void {
  writeFileSync(
    join(keyDir, `system-device-${tenantId}.key`),
    `${Buffer.from(secretKey).toString('base64')}\n`,
  );
}

/** Map the production `resolveDeps` output onto the push route's dep shape. */
function pushDepsFrom(sd: ServerDeps): PushDeps {
  return {
    forTenant: sd.forTenant,
    crypto: sd.serverCrypto,
    now: sd.now,
    newId: sd.newOpLogId,
    registry: sd.opRegistry,
    projections: sd.projections,
    pokeHub: sd.pokeHub,
    ...(sd.detectConflicts === undefined ? {} : { detectConflicts: sd.detectConflicts }),
  };
}

/** Member device (deviceA) + a second member (deviceB) + the tenant system device (01 §3.6). */
async function seedCollisionWorld(seed: number): Promise<{
  member: ChainWorld;
  devB: ChainWorld;
  system: ChainWorld;
  mBuilder: ChainBuilder;
  bBuilder: ChainBuilder;
}> {
  const member = makeWorld(seed, serverCryptoPort);
  const mBuilder = new ChainBuilder(member, serverCryptoPort, 1_726_000_100_000);
  await seedWorld(db, member, { lastSeq: 1, lastHash: mBuilder.genesis().hash });

  const rawB = makeWorld(seed + 100, serverCryptoPort);
  const devB: ChainWorld = {
    ...rawB,
    tenantId: member.tenantId,
    storeId: member.storeId,
    userId: member.userId,
  };
  const bBuilder = new ChainBuilder(devB, serverCryptoPort, 1_726_000_200_000);
  await seedDevice(db, devB, { lastSeq: 1, lastHash: bBuilder.genesis().hash });

  const rawSys = makeWorld(seed + 500, serverCryptoPort);
  const system: ChainWorld = {
    ...rawSys,
    tenantId: member.tenantId,
    storeId: member.storeId,
    userId: member.userId,
  };
  await seedDevice(db, system, { deviceKind: 'system' });
  await db
    .insertInto('systemDeviceChainState')
    .values({ tenantId: member.tenantId, deviceId: system.deviceId })
    .execute();
  // The system actor is flagged by `users.is_system` (01 §3.6); the wiring reads it by that flag.
  await db.updateTable('users').set({ isSystem: true }).where('id', '=', member.userId).execute();

  return { member, devB, system, mBuilder, bBuilder };
}

async function conflictCount(): Promise<number> {
  const r = await sql<{ n: string }>`SELECT count(*) AS n FROM conflicts`.execute(db);
  return Number(r.rows[0]?.n ?? 0);
}

/** deviceA creates + archives a note; deviceB (offline through the archive) edits it — an
 *  edit-after-archive, the SIGNIFICANT Rule-2 case (01 §8.2, 03 §11 N2). Returns deviceB's result. */
async function pushCollision(
  deps: PushDeps,
  world: Awaited<ReturnType<typeof seedCollisionWorld>>,
): Promise<{ status: string | undefined; noteId: string }> {
  const { member, devB, mBuilder, bBuilder } = world;
  const noteId = makeWorld(9_999, serverCryptoPort).storeId;
  await runPush(
    deps,
    { deviceId: member.deviceId, tenantId: member.tenantId },
    {
      deviceId: member.deviceId,
      ops: [
        mBuilder.append({
          type: NOTE_CREATED,
          entityType: 'note',
          entityId: noteId,
          payload: { title: 't', body: 'a0', mediaId: null },
        }),
        mBuilder.append({ type: NOTE_ARCHIVED, entityType: 'note', entityId: noteId, payload: {} }),
      ],
    },
  );
  const res = await runPush(
    deps,
    { deviceId: devB.deviceId, tenantId: member.tenantId },
    {
      deviceId: devB.deviceId,
      ops: [
        bBuilder.append({
          type: NOTE_EDITED,
          entityType: 'note',
          entityId: noteId,
          payload: { body: 'b1' },
        }),
      ],
    },
  );
  return { status: res.results[0]?.status, noteId };
}

// ── The DirectorySystemKeyStore itself (fail-loud contract; format parity) ───────────────────────

describe('DirectorySystemKeyStore — reads provision-tenant keys; fails loud on broken ones', () => {
  test('a provisioned key file yields a signer that verifies against its derived public key', () => {
    const world = makeWorld(101, serverCryptoPort);
    writeProvisionedKey(world.tenantId, world.secretKey);
    const store = new DirectorySystemKeyStore(keyDir, serverCryptoPort);

    const signer = store.getSystemSigner(world.tenantId) as SystemSigner;
    expect(signer).toBeInstanceOf(Function);
    // The signer must sign with EXACTLY the key whose public half is on the device row: a message
    // signed by it verifies against `world.publicKey`. A format/parse drift would fail this.
    const message = serverCryptoPort.sha256(new Uint8Array([1, 2, 3]));
    expect(serverCryptoPort.verify(signer(message), message, world.publicKey)).toBe(true);
  });

  test('no key file for a tenant ⇒ undefined (not an error): "no configured key"', () => {
    const store = new DirectorySystemKeyStore(keyDir, serverCryptoPort);
    expect(store.getSystemSigner(makeWorld(102, serverCryptoPort).tenantId)).toBeUndefined();
  });

  test('a malformed key file ⇒ throws (fail loud, never silent detection-off)', () => {
    const world = makeWorld(103, serverCryptoPort);
    writeFileSync(join(keyDir, `system-device-${world.tenantId}.key`), 'not*valid*base64\n');
    const store = new DirectorySystemKeyStore(keyDir, serverCryptoPort);
    expect(() => store.getSystemSigner(world.tenantId)).toThrow(/not a valid Ed25519 secret key/);
  });

  test('a wrong-length key file ⇒ throws (fail loud)', () => {
    const world = makeWorld(104, serverCryptoPort);
    // Valid base64, but 16 bytes — not an Ed25519 secret key. Decode succeeds; the key does not.
    writeFileSync(
      join(keyDir, `system-device-${world.tenantId}.key`),
      `${Buffer.from(new Uint8Array(16)).toString('base64')}\n`,
    );
    const store = new DirectorySystemKeyStore(keyDir, serverCryptoPort);
    expect(() => store.getSystemSigner(world.tenantId)).toThrow(/not a valid Ed25519 secret key/);
  });

  test('a non-UUID tenant id ⇒ undefined and reads NO file (path-traversal guard)', () => {
    const reads: string[] = [];
    const spy: ReadKeyFile = (p) => {
      reads.push(p);
      return undefined;
    };
    const store = new DirectorySystemKeyStore(keyDir, serverCryptoPort, spy);
    expect(store.getSystemSigner('../../etc/passwd')).toBeUndefined();
    expect(store.getSystemSigner('..')).toBeUndefined();
    // The guard runs BEFORE any path is built, so no read is ever attempted for a non-tenant id.
    expect(reads).toHaveLength(0);
  });
});

// ── config → store composition (the exact wiring main.ts performs) ───────────────────────────────

describe('systemKeyStoreFromConfig — SYSTEM_KEY_DIR is the on/off switch main.ts reads', () => {
  test('no SYSTEM_KEY_DIR ⇒ no store (intentional detection-off)', () => {
    const config = loadConfig({ DATABASE_URL: 'postgres://x' });
    expect(config.systemKeyDir).toBeUndefined();
    expect(systemKeyStoreFromConfig(config, serverCryptoPort)).toBeUndefined();
  });

  test('SYSTEM_KEY_DIR set ⇒ a DirectorySystemKeyStore over that dir', () => {
    const config = loadConfig({ DATABASE_URL: 'postgres://x', SYSTEM_KEY_DIR: keyDir });
    expect(config.systemKeyDir).toBe(keyDir);
    expect(systemKeyStoreFromConfig(config, serverCryptoPort)).toBeInstanceOf(
      DirectorySystemKeyStore,
    );
  });
});

// ── Two-direction falsification on the REAL production composition (real PG16) ───────────────────

describe('conflict detection is ACTIVE in production iff a key store is wired (real PG16)', () => {
  test('SYSTEM_KEY_DIR set + real key ⇒ colliding push DETECTS, persists, surfaces, acknowledgeable', async () => {
    const world = await seedCollisionWorld(7010);
    writeProvisionedKey(world.member.tenantId, world.system.secretKey);

    // The EXACT production path: env → loadConfig → systemKeyStoreFromConfig → resolveDeps.
    const config = loadConfig({ DATABASE_URL: 'postgres://x', SYSTEM_KEY_DIR: keyDir });
    const store = systemKeyStoreFromConfig(config, serverCryptoPort);
    expect(store).toBeInstanceOf(DirectorySystemKeyStore);
    const deps = resolveDeps({
      forTenant: appForTenant,
      now: () => NOW,
      ...(store === undefined ? {} : { systemKeyStore: store }),
    });
    expect(deps.detectConflicts).toBeInstanceOf(Function); // the injection actually built it.

    const { status, noteId } = await pushCollision(pushDepsFrom(deps), world);
    expect(status).toBe('accepted'); // the server accepts + flags; it never rejects a conflict.

    // DETECTED + persisted at its resting status (03 §7: significant ⇒ surfaced).
    expect(await conflictCount()).toBe(1);
    // NB: the db handle carries Kysely's CamelCasePlugin, so raw-SQL result keys come back camelCased
    // (`entity_id` → `entityId`).
    const conflict = await sql<{ id: string; severity: string; status: string; entityId: string }>`
      SELECT id, severity, status, entity_id FROM conflicts`.execute(db);
    expect(conflict.rows[0]?.severity).toBe('significant');
    expect(conflict.rows[0]?.status).toBe('surfaced');
    expect(conflict.rows[0]?.entityId).toBe(noteId);
    // The detection op verified against the system pubkey at emission (appendSystemOp self-check);
    // that it committed at all IS that proof — the wrong-key test below falsifies it.
    const conflictId = conflict.rows[0]?.id as string;

    // ACKNOWLEDGEABLE (task 108): the owner's device pushes platform.conflict_acknowledged over the
    // conflict id → the projection folds surfaced → acknowledged (03 §7). Round-trips through push.
    const ack = await runPush(
      pushDepsFrom(deps),
      { deviceId: world.member.deviceId, tenantId: world.member.tenantId },
      {
        deviceId: world.member.deviceId,
        ops: [
          world.mBuilder.append({
            type: CONFLICT_ACK,
            entityType: 'conflict',
            entityId: conflictId,
            payload: { note: null },
            // The ack happens AFTER the owner sees the surfaced conflict, so its timestamp sorts
            // after the detection op's server time (NOW) in canonical order (05 §4) — otherwise the
            // §4.2 re-fold would replay ack-before-detection and the ack would fold as a no-op.
            timestamp: NOW + 60_000,
          }),
        ],
      },
    );
    expect(ack.results[0]?.status).toBe('accepted');
    const acked = await sql<{ status: string }>`
      SELECT status FROM conflicts WHERE id = ${conflictId}`.execute(db);
    expect(acked.rows[0]?.status).toBe('acknowledged');
  });

  test('no SYSTEM_KEY_DIR ⇒ detection OFF: the same collision produces NO conflict, push still succeeds', async () => {
    const world = await seedCollisionWorld(7020);
    writeProvisionedKey(world.member.tenantId, world.system.secretKey); // key on disk, but…

    // …unset SYSTEM_KEY_DIR ⇒ no store ⇒ resolveDeps leaves detectConflicts undefined.
    const config = loadConfig({ DATABASE_URL: 'postgres://x' });
    const store = systemKeyStoreFromConfig(config, serverCryptoPort);
    expect(store).toBeUndefined();
    const deps = resolveDeps({ forTenant: appForTenant, now: () => NOW });
    expect(deps.detectConflicts).toBeUndefined();

    const { status } = await pushCollision(pushDepsFrom(deps), world);
    expect(status).toBe('accepted'); // pushes succeed — detection off is not a failure.
    expect(await conflictCount()).toBe(0); // and NOTHING was detected: the direction-A control.
  });

  test('store built but NOT injected into resolveDeps ⇒ detection OFF (the break-the-wiring RED lever)', async () => {
    const world = await seedCollisionWorld(7030);
    writeProvisionedKey(world.member.tenantId, world.system.secretKey);

    // The store exists and is valid, but the composition root does not thread it: detection is off.
    // If the ACTIVE test's `toBe(1)` ever stayed green with the store absent here, this proves the
    // wiring — not something else — is what activates detection.
    const deps = resolveDeps({ forTenant: appForTenant, now: () => NOW });
    expect(deps.detectConflicts).toBeUndefined();
    await pushCollision(pushDepsFrom(deps), world);
    expect(await conflictCount()).toBe(0);
  });
});

describe('opted-in-but-broken fails LOUD, never silent detection-off (real PG16)', () => {
  test('SYSTEM_KEY_DIR set but the key file is MISSING for the tenant ⇒ the colliding push throws', async () => {
    const world = await seedCollisionWorld(7040);
    // No writeProvisionedKey → the tenant has no file. The store is injected (detection enabled),
    // so a real collision reaches emission with no signer → the wiring throws (conflict-wiring.ts).
    const store = new DirectorySystemKeyStore(keyDir, serverCryptoPort);
    const deps = resolveDeps({ forTenant: appForTenant, systemKeyStore: store, now: () => NOW });

    await expect(pushCollision(pushDepsFrom(deps), world)).rejects.toThrow(
      /key store produced no key/,
    );
    expect(await conflictCount()).toBe(0); // the transaction rolled back — nothing half-recorded.
  });

  test('SYSTEM_KEY_DIR set but the key file is MALFORMED ⇒ the colliding push throws', async () => {
    const world = await seedCollisionWorld(7050);
    writeFileSync(join(keyDir, `system-device-${world.member.tenantId}.key`), 'not*valid*base64\n');
    const store = new DirectorySystemKeyStore(keyDir, serverCryptoPort);
    const deps = resolveDeps({ forTenant: appForTenant, systemKeyStore: store, now: () => NOW });

    await expect(pushCollision(pushDepsFrom(deps), world)).rejects.toThrow(
      /not a valid Ed25519 secret key/,
    );
    expect(await conflictCount()).toBe(0);
  });

  test('the WRONG tenant’s key ⇒ appendSystemOp self-check throws; push rolls back (§2.5 falsify)', async () => {
    const world = await seedCollisionWorld(7060);
    // A valid Ed25519 key, but NOT the one on the system device row: the emitted op cannot verify
    // against the system pubkey, so appendSystemOp's self-check throws rather than ship an
    // unverifiable op to clients. This is the guard that the ACTIVE test's success depends on.
    const wrong = makeWorld(7061, serverCryptoPort);
    writeProvisionedKey(world.member.tenantId, wrong.secretKey);
    const store = new DirectorySystemKeyStore(keyDir, serverCryptoPort);
    const deps = resolveDeps({ forTenant: appForTenant, systemKeyStore: store, now: () => NOW });

    await expect(pushCollision(pushDepsFrom(deps), world)).rejects.toThrow(
      /does not verify against the system device pubkey/,
    );
    expect(await conflictCount()).toBe(0);
  });
});
