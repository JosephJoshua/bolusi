// CHAOS-05 — tampered chain / rejection matrix (testing-guide §3.6 / 05 §8, api/01 §3).
//
// The full T1–T9 rejection matrix driven against the REAL production server (createApp over PGlite),
// NEVER a harness-faked verdict (T-7). Two wire surfaces carry the matrix:
//   - the RAW WIRE CLIENT (raw-wire.ts) POSTs hand-built `SignedOperation` JSON the production client
//     refuses to construct — payloads mutated post-hash, chains re-signed with a foreign key, seqs
//     swapped, foreign tenant ids — built by task-07's `@bolusi/test-support` tamper transforms. It
//     reads the per-op `results[].status`/`code` (T1–T6/T8/T9) and the HTTP `401` envelope (T7).
//   - the REAL client push loop (`runPushPhase` via `pushDevice`) for the T7 halt-drain: a revoked
//     device's push is a `SyncTransportError`, not a per-op result, so the loop HALTS and the ops stay
//     `local` — resumable, never in the server log.
//
// UNBLOCKED BY TASK 103: the harness boots the server with `testAuthSeam` so the production
// `createVerifyToken`/`InMemoryTokenStore` render the genuine `401 DEVICE_REVOKED` from a
// `deviceStatus:'revoked'` record — the seam injects a verdict's INPUT (test DATA), never a bypass.
//
// PASS (§3.6): each row's exact code + status; rejected ops are ABSENT from the server log and never
// appear in another device's pull; on the client each rejected op stays `syncStatus=rejected`
// (terminal) with its `rejectionCode`, surfaced — never deleted, never silent; untampered devices
// still converge.
//
// FALSIFICATION (§2.11 / T-17): every fence ships its positive control. The matrix asserts the
// UNTAMPERED op in each batch is `accepted` and PRESENT in the log (so "the tampered op is absent"
// means validation worked, not that the fixture pushes nothing). The dedicated controls below watch
// the 401 key on REVOCATION (a byte-identical flow from a NON-revoked device is accepted) and the
// client-rejection path fire (the SAME op uncorrupted is accepted, not marked rejected).
import { sql } from 'kysely';
import { describe, expect, test } from 'vitest';

import { bytesToBase64, SyncTransportError } from '@bolusi/core';
import {
  breakPreviousHash,
  ChainBuilder,
  deriveDeviceKeypair,
  FakeClock,
  makeWorld,
  mulberry32,
  mutatePayloadPostHash,
  noblePort,
  resign,
  uuidV7,
  type ChainWorld,
} from '@bolusi/test-support';

import { VirtualDevice, type DeviceIdentity } from '../src/device.js';
import { HarnessServer } from '../src/server.js';
import { mintIdentities } from '../src/identities.js';
import { assertConvergence, canonicalFold, notesRows } from '../src/oracle.js';
import { rawPush } from '../src/raw-wire.js';
import { CaptureSurface, HttpTransport, pullDevice, pushDevice } from '../src/transport.js';
import { resolveSeeds, withSeed } from '../src/index.js';

const CLOCK_BASE = 1_726_100_000_000;
/** Another tenant's id, correctly-signed into an op for T6 (a cross-tenant splice). */
const FOREIGN_TENANT = '22222222-2222-4222-8222-222222222222';
const WRONG_HASH = 'b'.repeat(64);

/**
 * An OpSpec for a valid note (the workload, §3.2). Payload is the CURRENT v2 shape
 * `{title, body, mediaId}` (notes/operations.ts) — the harness boots the REAL `createApp`
 * registry, which validates every new push against the current schema (05 §7), so a v1
 * `{title, body}` would (correctly) be SCHEMA_INVALID, which is T8's job, not a valid op's.
 */
const note = (title: string, body: string) => ({
  type: 'notes.note_created',
  entityType: 'note',
  payload: { title, body, mediaId: null },
});

/** Adapt a raw-wire `ChainWorld` into the `DeviceIdentity` shape `HarnessServer.seedDevice` reads. */
function worldIdentity(world: ChainWorld): DeviceIdentity {
  return {
    tenantId: world.tenantId,
    storeId: world.storeId,
    userId: world.userId,
    deviceId: world.deviceId,
    // `seed`/`publicKey` are unread by `seedDevice` (only `publicKeyBase64` + the ids are); the
    // world's secret key stands in so the shape is total.
    seed: world.secretKey,
    publicKey: world.publicKey,
    publicKeyBase64: world.publicKeyB64,
  };
}

/** Seed a fresh raw-wire device (own tenant/store, own keypair) on the server; return its builder. */
async function seedWorld(
  server: HarnessServer,
  seedN: number,
): Promise<{ world: ChainWorld; builder: ChainBuilder; auth: string }> {
  const world = makeWorld(seedN, noblePort);
  const seeded = await server.seedDevice(worldIdentity(world));
  return { world, builder: new ChainBuilder(world, noblePort), auth: seeded.auth };
}

/** Every op-log id the server holds for `deviceId`, read as owner (bypasses RLS) — the append-only truth. */
async function serverOpIds(server: HarnessServer, deviceId: string): Promise<Set<string>> {
  const rows = await sql<{ id: string }>`
    SELECT id FROM operations WHERE device_id = ${deviceId}
  `.execute(server.db);
  return new Set(rows.rows.map((r) => r.id));
}

/** A device op's client bookkeeping — the terminal state a rejection leaves (03 §3, 05 §8). */
async function opSyncStatus(
  device: VirtualDevice,
  id: string,
): Promise<{ status: string; code: string | null }> {
  const rows = await sql<{ syncStatus: string; rejectionCode: string | null }>`
    SELECT sync_status AS "syncStatus", rejection_code AS "rejectionCode"
    FROM operations WHERE id = ${id}
  `.execute(device.db);
  const row = rows.rows[0];
  return { status: row?.syncStatus ?? 'MISSING', code: row?.rejectionCode ?? null };
}

describe('CHAOS-05 tampered chain / rejection matrix', () => {
  for (const seed of resolveSeeds()) {
    test(`CHAOS-05 T1–T9 exact codes; rejected ops absent from log + peer pull; untampered devices converge [seed ${seed}]`, async () => {
      await withSeed(
        seed,
        async () => {
          const server = await HarnessServer.boot({ testAuthSeam: true });
          try {
            // ── T1: payload modified post-hash → BAD_SIGNATURE (server recompute mismatch) ────────
            {
              const { world, builder, auth } = await seedWorld(server, seed * 100 + 1);
              const genesis = builder.genesis();
              const t1 = mutatePayloadPostHash(builder.append(note('t1', 'a')));
              const r = await rawPush(server.fetch, auth, {
                deviceId: world.deviceId,
                ops: [genesis, t1],
              });
              expect(r.httpStatus).toBe(200);
              expect(r.response!.results[0]?.status).toBe('accepted'); // positive control
              expect(r.response!.results[1]).toMatchObject({
                status: 'rejected',
                code: 'BAD_SIGNATURE',
              });
              const ids = await serverOpIds(server, world.deviceId);
              expect(ids.has(genesis.id)).toBe(true); // the accepted op landed (denominator, T-14)
              expect(ids.has(t1.id)).toBe(false); // the tampered op never entered the log
            }

            // ── T2: payload modified AND re-signed with a NON-enrolled key → BAD_SIGNATURE ─────────
            {
              const { world, builder, auth } = await seedWorld(server, seed * 100 + 2);
              const foreignKey = makeWorld(seed * 100 + 2 + 0x5eed, noblePort).secretKey;
              const genesis = builder.genesis();
              const t2 = resign(
                { ...builder.append(note('t2', 'a')), payload: { title: 'x', body: 'y' } },
                foreignKey,
                noblePort,
              );
              const r = await rawPush(server.fetch, auth, {
                deviceId: world.deviceId,
                ops: [genesis, t2],
              });
              expect(r.response!.results[1]).toMatchObject({
                status: 'rejected',
                code: 'BAD_SIGNATURE',
              });
              expect((await serverOpIds(server, world.deviceId)).has(t2.id)).toBe(false);
            }

            // ── T3: wrong previousHash → CHAIN_BROKEN, batch remainder CHAIN_HALTED ────────────────
            {
              const { world, builder, auth } = await seedWorld(server, seed * 100 + 3);
              const genesis = builder.genesis();
              const op2 = builder.append(note('t3', 'a'));
              const op3 = builder.append(note('t3', 'b'));
              const t3 = breakPreviousHash(op2, WRONG_HASH, world.secretKey, noblePort);
              const r = await rawPush(server.fetch, auth, {
                deviceId: world.deviceId,
                ops: [genesis, t3, op3],
              });
              expect(r.response!.results[1]).toMatchObject({
                status: 'rejected',
                code: 'CHAIN_BROKEN',
              });
              expect(r.response!.results[2]).toMatchObject({
                status: 'rejected',
                code: 'CHAIN_HALTED',
              });
              const ids = await serverOpIds(server, world.deviceId);
              expect(ids.has(t3.id)).toBe(false);
              expect(ids.has(op3.id)).toBe(false);
            }

            // ── T4: two ops' seq swapped (reorder) → first out-of-order op CHAIN_BROKEN ────────────
            {
              const { world, builder, auth } = await seedWorld(server, seed * 100 + 4);
              const genesis = builder.genesis(); // seq 1
              const opA = builder.append(note('t4', 'a')); // seq 2, previousHash = genesis.hash
              const opB = builder.append(note('t4', 'b')); // seq 3, previousHash = opA.hash
              // Swap the seq values and re-sign: B claims seq 2 while still linking to A's hash → its
              // previousHash mismatches the genesis head → CHAIN_BROKEN, not CHAIN_GAP.
              const bAsSeq2 = resign({ ...opB, seq: 2 }, world.secretKey, noblePort);
              const aAsSeq3 = resign({ ...opA, seq: 3 }, world.secretKey, noblePort);
              const r = await rawPush(server.fetch, auth, {
                deviceId: world.deviceId,
                ops: [genesis, bAsSeq2, aAsSeq3],
              });
              expect(r.response!.results[0]?.status).toBe('accepted');
              expect(r.response!.results[1]).toMatchObject({
                status: 'rejected',
                code: 'CHAIN_BROKEN',
              });
              expect(r.response!.results[2]).toMatchObject({
                status: 'rejected',
                code: 'CHAIN_HALTED',
              });
              const ids = await serverOpIds(server, world.deviceId);
              expect(ids.has(bAsSeq2.id)).toBe(false);
              expect(ids.has(aAsSeq3.id)).toBe(false);
            }

            // ── T5: seq skips ahead → CHAIN_GAP; re-push from the gap → accepted (not an error state) ─
            {
              const { world, builder, auth } = await seedWorld(server, seed * 100 + 5);
              const genesis = builder.genesis(); // seq 1
              const op2 = builder.append(note('t5', 'a')); // seq 2 — withheld to create the gap
              const op3 = builder.append(note('t5', 'b')); // seq 3
              await rawPush(server.fetch, auth, { deviceId: world.deviceId, ops: [genesis] });
              const gap = await rawPush(server.fetch, auth, {
                deviceId: world.deviceId,
                ops: [op3],
              });
              expect(gap.response!.results[0]).toMatchObject({
                status: 'rejected',
                code: 'CHAIN_GAP',
              });
              expect((await serverOpIds(server, world.deviceId)).has(op3.id)).toBe(false);
              // The client re-pushes from the gap: all ops eventually accepted (05 §8 — no error).
              const resend = await rawPush(server.fetch, auth, {
                deviceId: world.deviceId,
                ops: [op2, op3],
              });
              expect(resend.response!.results.map((r) => r.status)).toEqual([
                'accepted',
                'accepted',
              ]);
            }

            // ── T6: another tenant's tenantId, correctly signed → SCOPE_VIOLATION (fail closed, 05 §9) ─
            {
              const { world, builder, auth } = await seedWorld(server, seed * 100 + 6);
              const genesis = builder.genesis();
              const t6 = resign(
                { ...builder.append(note('t6', 'a')), tenantId: FOREIGN_TENANT },
                world.secretKey,
                noblePort,
              );
              const r = await rawPush(server.fetch, auth, {
                deviceId: world.deviceId,
                ops: [genesis, t6],
              });
              expect(r.response!.results[1]).toMatchObject({
                status: 'rejected',
                code: 'SCOPE_VIOLATION',
              });
              expect((await serverOpIds(server, world.deviceId)).has(t6.id)).toBe(false);
            }

            // ── T7: push from a REVOKED device → HTTP 401 DEVICE_REVOKED, nothing enters the log ───
            {
              const world = makeWorld(seed * 100 + 7, noblePort);
              const seeded = await server.seedDevice(worldIdentity(world), { status: 'revoked' });
              const builder = new ChainBuilder(world, noblePort);
              const r = await rawPush(server.fetch, seeded.auth, {
                deviceId: world.deviceId,
                ops: [builder.genesis()],
              });
              expect(r.httpStatus).toBe(401); // receipt-time cut (api/01 §2) — before any op is read
              expect(r.errorCode).toBe('DEVICE_REVOKED');
              expect((await serverOpIds(server, world.deviceId)).size).toBe(0);
            }

            // ── T8: correctly-signed op whose payload violates the registry schema → SCHEMA_INVALID ─
            {
              const { world, builder, auth } = await seedWorld(server, seed * 100 + 8);
              const genesis = builder.genesis();
              // notes.note_created requires {title, body}; omit `title` and sign correctly.
              const t8 = builder.append({
                type: 'notes.note_created',
                entityType: 'note',
                payload: { body: 'no title' },
              });
              const r = await rawPush(server.fetch, auth, {
                deviceId: world.deviceId,
                ops: [genesis, t8],
              });
              expect(r.response!.results[1]).toMatchObject({
                status: 'rejected',
                code: 'SCHEMA_INVALID',
              });
              expect((await serverOpIds(server, world.deviceId)).has(t8.id)).toBe(false);
            }

            // ── T9: correctly-signed op whose type is absent from the server registry → UNKNOWN_TYPE ─
            {
              const { world, builder, auth } = await seedWorld(server, seed * 100 + 9);
              const genesis = builder.genesis();
              const t9 = builder.append({
                type: 'ghost.module_event',
                entityType: 'ghost',
                payload: {},
              });
              const r = await rawPush(server.fetch, auth, {
                deviceId: world.deviceId,
                ops: [genesis, t9],
              });
              expect(r.response!.results[1]).toMatchObject({
                status: 'rejected',
                code: 'UNKNOWN_TYPE',
              });
              expect((await serverOpIds(server, world.deviceId)).has(t9.id)).toBe(false);
            }

            // ── Rejected ops never appear in another device's pull; the untampered peer CONVERGES ───
            {
              const aWorld = makeWorld(seed * 100 + 10, noblePort);
              await server.seedDevice(worldIdentity(aWorld));
              // A pushes genesis + one good note + one tampered note (BAD_SIGNATURE).
              const aBuilder = new ChainBuilder(aWorld, noblePort);
              const genesisA = aBuilder.genesis();
              const good = aBuilder.append(note('peer', 'travels'));
              const tampered = mutatePayloadPostHash(aBuilder.append(note('peer', 'blocked')));
              const aAuth = (await server.seedDevice(worldIdentity(aWorld))).auth;
              const pushA = await rawPush(server.fetch, aAuth, {
                deviceId: aWorld.deviceId,
                ops: [genesisA, good, tampered],
              });
              expect(pushA.response!.results.map((r) => r.status)).toEqual([
                'accepted',
                'accepted',
                'rejected',
              ]);

              // A peer (real VirtualDevice) in A's SAME tenant/store drains its real pull loop.
              const idPrng = mulberry32(seed ^ 0x05_05);
              const peerKp = deriveDeviceKeypair(seed, 7);
              const peerIdentity: DeviceIdentity = {
                tenantId: aWorld.tenantId,
                storeId: aWorld.storeId,
                userId: uuidV7(idPrng, CLOCK_BASE),
                deviceId: uuidV7(idPrng, CLOCK_BASE + 1),
                seed: peerKp.seed,
                publicKey: peerKp.publicKey,
                publicKeyBase64: bytesToBase64(peerKp.publicKey),
              };
              const peerAuth = (await server.seedDevice(peerIdentity)).auth;
              const peer = await VirtualDevice.open({
                identity: peerIdentity,
                clock: new FakeClock(CLOCK_BASE),
                prng: mulberry32(seed + 505),
              });
              try {
                const pull = await pullDevice(peer, new HttpTransport(server.fetch, peerAuth));
                expect(pull.applied).toBeGreaterThan(0);
                const peerIds = new Set((await peer.wireOps()).map((o) => o.id));
                expect(peerIds.has(good.id)).toBe(true); // positive control: the accepted op travelled
                expect(peerIds.has(genesisA.id)).toBe(true);
                expect(peerIds.has(tampered.id)).toBe(false); // the rejected op never travelled
                // The untampered device converges to the canonical fold of the accepted note.
                const reference = await canonicalFold([good]);
                assertConvergence(reference, [
                  {
                    name: `peer-${seed}`,
                    digest: await peer.digest(),
                    rows: await notesRows(peer.db),
                  },
                ]);
              } finally {
                await peer.close();
              }
            }
          } finally {
            await server.close();
          }
        },
        'CHAOS-05',
      );
    });
  }

  test('CHAOS-05 T7 positive control: a revoked device HALTS at 401 DEVICE_REVOKED (ops stay local, never in the log); a NON-revoked device with the identical flow is accepted', async () => {
    const server = await HarnessServer.boot({ testAuthSeam: true });
    const seed = 1;
    const [revokedId, activeId] = mintIdentities(seed, 2).devices as readonly [
      DeviceIdentity,
      DeviceIdentity,
    ];
    const revoked = await server.seedDevice(revokedId, { status: 'revoked' });
    const active = await server.seedDevice(activeId, { status: 'active' });
    const revokedDev = await VirtualDevice.open({
      identity: revokedId,
      clock: new FakeClock(CLOCK_BASE),
      prng: mulberry32(seed),
    });
    const activeDev = await VirtualDevice.open({
      identity: activeId,
      clock: new FakeClock(CLOCK_BASE),
      prng: mulberry32(seed + 1),
    });
    try {
      // Byte-identical flow on both: genesis + one note.
      revokedDev.clock.advance(1_000);
      await revokedDev.createNote({ title: 'r', body: 'r' });
      activeDev.clock.advance(1_000);
      await activeDev.createNote({ title: 'a', body: 'a' });

      // REVOKED: the real push loop HALTS on the 401 — a SyncTransportError, not a per-op result.
      let thrown: unknown;
      try {
        await pushDevice(revokedDev, new HttpTransport(server.fetch, revoked.auth));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(SyncTransportError);
      expect((thrown as SyncTransportError).status).toBe(401);
      expect((thrown as SyncTransportError).code).toBe('DEVICE_REVOKED');
      // Its ops NEVER entered the log …
      expect((await serverOpIds(server, revokedId.deviceId)).size).toBe(0);
      // … and stay `local` on the client (halt-drain is resumable — 05 §5, api/01 §1).
      for (const op of await revokedDev.wireOps()) {
        expect((await opSyncStatus(revokedDev, op.id)).status).toBe('local');
      }

      // NON-revoked control: identical flow → accepted, in the log, marked synced. Proves the 401
      // keys on REVOCATION, not on the flow.
      const result = await pushDevice(activeDev, new HttpTransport(server.fetch, active.auth));
      expect(result.rejected).toBe(0);
      expect(result.synced).toBeGreaterThan(0);
      const activeLog = await serverOpIds(server, activeId.deviceId);
      for (const op of await activeDev.wireOps()) {
        expect(activeLog.has(op.id)).toBe(true);
        expect((await opSyncStatus(activeDev, op.id)).status).toBe('synced');
      }
    } finally {
      await revokedDev.close();
      await activeDev.close();
      await server.close();
    }
  });

  test('CHAOS-05 the client keeps a server-rejected op as syncStatus=rejected with its code + surfaces it (never deleted, never silent); positive control: a correctly-keyed device is accepted', async () => {
    const server = await HarnessServer.boot({ testAuthSeam: true });
    // A device whose SEEDED pubkey does NOT match the key it signs with → every op is a genuine
    // BAD_SIGNATURE at the real server (05 §3 "recomputes, never trusts"), so the REAL push loop
    // marks each op `rejected` with the server's code and surfaces it. This corrupts NOTHING in the
    // append-only op log (05 §1): the divergence is purely which key the directory holds.
    const realId = mintIdentities(2, 1).devices[0]!;
    const wrongKp = deriveDeviceKeypair(2 ^ 0x0bad, 0);
    const mismatched: DeviceIdentity = {
      ...realId,
      publicKey: wrongKp.publicKey,
      publicKeyBase64: bytesToBase64(wrongKp.publicKey),
    };
    const rejectedSeed = await server.seedDevice(mismatched);
    // Signs with `realId.seed` — the key the server's directory does NOT hold.
    const rejectDev = await VirtualDevice.open({
      identity: realId,
      clock: new FakeClock(CLOCK_BASE),
      prng: mulberry32(2),
    });
    const okId = mintIdentities(3, 1).devices[0]!; // correctly-keyed control
    const acceptedSeed = await server.seedDevice(okId);
    const acceptDev = await VirtualDevice.open({
      identity: okId,
      clock: new FakeClock(CLOCK_BASE),
      prng: mulberry32(3),
    });
    try {
      rejectDev.clock.advance(1_000);
      await rejectDev.createNote({ title: 'keep', body: 'me' });
      const noteOp = (await rejectDev.wireOps()).find((o) => o.type === 'notes.note_created')!;
      const surface = new CaptureSurface();
      const rejectResult = await pushDevice(
        rejectDev,
        new HttpTransport(server.fetch, rejectedSeed.auth),
        { surface },
      );
      expect(rejectResult.rejected).toBeGreaterThan(0);
      expect(rejectResult.synced).toBe(0);
      const marked = await opSyncStatus(rejectDev, noteOp.id);
      expect(marked.status).toBe('rejected'); // terminal — never deleted (05 §8)
      expect(marked.code).toBe('BAD_SIGNATURE'); // the SERVER's code, stored verbatim
      const surfaced = surface.ofKind('op_rejected').filter((e) => e.opId === noteOp.id);
      expect(surfaced.length).toBeGreaterThan(0); // surfaced, never silent
      for (const event of surfaced) {
        expect(event.code).toBe('BAD_SIGNATURE');
        expect(event.labelKey).toBe('core.rejection.BAD_SIGNATURE'); // asserted by KEY (T-4)
      }
      expect((await serverOpIds(server, realId.deviceId)).has(noteOp.id)).toBe(false);

      // POSITIVE CONTROL: the correctly-keyed device, byte-identical flow → accepted, synced, never
      // rejected or surfaced. The ONLY difference is which key the directory holds, so the rejection
      // is proven to key on the signature verdict (watched red → green).
      acceptDev.clock.advance(1_000);
      await acceptDev.createNote({ title: 'keep', body: 'me' });
      const controlSurface = new CaptureSurface();
      const acceptResult = await pushDevice(
        acceptDev,
        new HttpTransport(server.fetch, acceptedSeed.auth),
        { surface: controlSurface },
      );
      expect(acceptResult.rejected).toBe(0);
      expect(controlSurface.ofKind('op_rejected')).toHaveLength(0);
      for (const op of await acceptDev.wireOps()) {
        expect((await opSyncStatus(acceptDev, op.id)).status).toBe('synced');
      }
    } finally {
      await rejectDev.close();
      await acceptDev.close();
      await server.close();
    }
  });
});
