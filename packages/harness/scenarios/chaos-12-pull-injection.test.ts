// CHAOS-12 — pull-side injection (testing-guide §3.6 / api/01-sync §4.2: trust, but verify).
//
// A harness server variant injects into a pull response one op with a BAD signature and one op
// signed by a key NOT in the device's registry. The device runs its REAL pull loop (runPullPhase —
// never re-implemented here, T-7). PASS (§3.6): the bad-signature op is quarantined immediately; the
// unknown-pubkey op triggers EXACTLY ONE forced re-pull (`devicesDirectoryVersion: 0`) then, still
// unknown, is quarantined too; both sit in `quarantined_ops`, absent from projections and the applied
// set; the cursor ADVANCES past both (one bad op never bricks sync); surfaced via the `sync.quarantine.*`
// label key (T-4). A later sidecar carrying the missing key RELEASES the unknown-key op via the
// engine's out-of-order path while the bad-signature op stays quarantined; convergence holds over the
// VALID ops only.
//
// Falsification (§2.11 / T-17): the quarantine fence needs a positive control proving the fenced thing
// is real. The main test's `applied === 1` is that control (the honest op on the SAME batch applies —
// "nothing quarantined" cannot masquerade as "verification works"). The dedicated control below then
// watches the guard go RED: with the byte-flip REMOVED, the same op is NOT quarantined and DOES apply —
// the only difference is the cryptography (T-14b). A quarantine that fired on everything, or on nothing,
// fails one of these two.
import { sql } from 'kysely';
import { describe, expect, test } from 'vitest';

import { FakeClock, mulberry32 } from '@bolusi/test-support';
import type { DeviceInfo, SignedOperation } from '@bolusi/schemas';

import { VirtualDevice, type DeviceIdentity } from '../src/device.js';
import { mintIdentities } from '../src/identities.js';
import { canonicalFold, assertConvergence, notesRows } from '../src/oracle.js';
import { CaptureSurface, ScriptedTransport, pullDevice } from '../src/transport.js';
import { resolveSeeds, withSeed } from '../src/index.js';

const CLOCK_BASE = 1_726_100_000_000;

/** The sidecar row for one device (api/01 §4.1). */
function deviceInfoOf(identity: DeviceIdentity): DeviceInfo {
  return {
    id: identity.deviceId,
    storeId: identity.storeId,
    kind: 'member',
    signingKeyPublic: identity.publicKeyBase64,
    status: 'active',
    revokedAt: null,
  };
}

/** Author `count` REAL signed notes ops on a throwaway device (T-7 — real command path, real crypto). */
async function authorNotes(
  identity: DeviceIdentity,
  seed: number,
  count: number,
): Promise<SignedOperation[]> {
  const device = await VirtualDevice.open({
    identity,
    clock: new FakeClock(CLOCK_BASE),
    prng: mulberry32(seed ^ 0x0c12),
  });
  try {
    for (let n = 0; n < count; n += 1) {
      device.clock.advance(1_000 + n);
      await device.createNote({ title: `note-${seed}-${n}`, body: `body-${seed}-${n}` });
    }
    return (await device.wireOps()).filter((op) => op.type === 'notes.note_created');
  } finally {
    await device.close();
  }
}

/**
 * Corrupt an op's signature so it is VERIFIED-BAD, not merely absent (api/01 §4.2 / CHAOS-05 T1):
 * flip the payload body AFTER signing, leaving `hash`/`signature` untouched. It still parses and its
 * signer is known — the signature genuinely fails against the recomputed hash.
 */
function corruptSignature(op: SignedOperation): SignedOperation {
  return {
    ...op,
    payload: {
      ...(op.payload as object),
      body: 'tampered-post-signing',
    } as SignedOperation['payload'],
  };
}

async function quarantinedIds(device: VirtualDevice): Promise<string[]> {
  const rows = await sql<{ id: string }>`
    SELECT id FROM quarantined_ops ORDER BY server_seq
  `.execute(device.db);
  return rows.rows.map((r) => r.id);
}

async function cursor(device: VirtualDevice): Promise<number> {
  const rows = await sql<{ pullCursor: number }>`
    SELECT pull_cursor AS "pullCursor" FROM sync_state WHERE id = 1
  `.execute(device.db);
  return Number(rows.rows[0]?.pullCursor ?? -1);
}

async function inLog(device: VirtualDevice, id: string): Promise<boolean> {
  const rows = await sql<{
    c: number;
  }>`SELECT COUNT(*) AS c FROM operations WHERE id = ${id}`.execute(device.db);
  return Number(rows.rows[0]?.c ?? 0) > 0;
}

const NEXT_CURSOR = 4242;

describe('CHAOS-12 pull-side injection (trust, but verify)', () => {
  for (const seed of resolveSeeds()) {
    test(`CHAOS-12 bad-signature quarantined, unknown-pubkey re-pulled-once then quarantined, released on sidecar [seed ${seed}]`, async () => {
      await withSeed(
        seed,
        async () => {
          const ids = mintIdentities(seed, 3);
          const [dId, kId, sId] = ids.devices as readonly [
            DeviceIdentity,
            DeviceIdentity,
            DeviceIdentity,
          ];

          // K (known) authors two notes: one served good, one corrupted post-signing. S (stranger)
          // authors one — served by a signer the device does not yet hold.
          const [goodK, badSource] = await authorNotes(kId, seed, 2);
          const badSigK = corruptSignature(badSource!);
          const [unknownS] = await authorNotes(sId, seed + 777, 1);

          const device = await VirtualDevice.open({
            identity: dId,
            clock: new FakeClock(CLOCK_BASE),
            prng: mulberry32(seed),
          });
          const surface = new CaptureSurface();
          const transport = new ScriptedTransport();
          const injected = [goodK!, badSigK, unknownS!];
          const sidecarK: DeviceInfo[] = [deviceInfoOf(kId)];

          // Pull 1 sees an unknown signer (S) → the loop forces ONE re-pull at version 0; the server
          // STILL omits S. Both scripted replies carry the same batch (a server that will not produce
          // the key). `hasMore:false` → one batch, then the loop drains.
          transport.scriptPull(
            {
              ops: injected,
              nextCursor: NEXT_CURSOR,
              hasMore: false,
              serverTime: CLOCK_BASE,
              devices: sidecarK,
              devicesDirectoryVersion: 1,
            },
            {
              ops: injected,
              nextCursor: NEXT_CURSOR,
              hasMore: false,
              serverTime: CLOCK_BASE,
              devices: sidecarK,
              devicesDirectoryVersion: 1,
            },
          );

          try {
            const first = await pullDevice(device, transport, { surface });

            // POSITIVE CONTROL (T-14b): the honest op applied on the SAME batch — so "the bad ops did
            // not apply" means verification worked, not that the fixture applies nothing.
            expect(first.applied).toBe(1);
            expect(await notesRows(device.db)).toHaveLength(1);

            // Exactly ONE forced re-pull, at version 0, on the SAME cursor (api/01 §4.2 — a server must
            // not be able to spin the client). Counted, not assumed.
            expect(first.refetches).toBe(1);
            expect(transport.pulls).toHaveLength(2);
            expect(transport.pulls[1]?.devicesDirectoryVersion).toBe(0);
            expect(transport.pulls[1]?.cursor).toBe(transport.pulls[0]?.cursor);

            // Both bad ops quarantined, absent from the op log and projections.
            expect((await quarantinedIds(device)).sort()).toEqual(
              [badSigK.id, unknownS!.id].sort(),
            );
            expect(first.quarantined).toBe(2);
            expect(await inLog(device, badSigK.id)).toBe(false);
            expect(await inLog(device, unknownS!.id)).toBe(false);

            // The counter-intuitive half: the cursor advances PAST both bad ops (one bad op never bricks sync).
            expect(await cursor(device)).toBe(NEXT_CURSOR);

            // Surfaced loudly, asserted by label KEY not copy (T-4).
            const surfaced = surface.ofKind('quarantined');
            expect(surfaced.map((e) => e.opId).sort()).toEqual([badSigK.id, unknownS!.id].sort());
            for (const event of surfaced) expect(event.labelKey).toMatch(/^sync\.quarantine\./);

            // A later sidecar delivers S's key. Re-verification (triggered by the SIDECAR) releases the
            // unknown-key op via the engine's out-of-order path; the forgery stays — a bad signature
            // never becomes good.
            transport.scriptPull({
              ops: [],
              nextCursor: NEXT_CURSOR,
              hasMore: false,
              serverTime: CLOCK_BASE,
              devices: [deviceInfoOf(kId), deviceInfoOf(sId)],
              devicesDirectoryVersion: 2,
            });
            const second = await pullDevice(device, transport, { surface });

            expect(second.released).toBe(1);
            expect(await quarantinedIds(device)).toEqual([badSigK.id]);
            expect(await inLog(device, unknownS!.id)).toBe(true);

            // Convergence holds over the VALID ops only — the projection is exactly the canonical fold
            // of {goodK, releasedS}; the forgery is nowhere in it.
            const reference = await canonicalFold([goodK!, unknownS!]);
            assertConvergence(reference, [
              {
                name: `device-${seed}`,
                digest: await device.digest(),
                rows: await notesRows(device.db),
              },
            ]);
            expect(await notesRows(device.db)).toHaveLength(2);
          } finally {
            await device.close();
          }
        },
        'CHAOS-12',
      );
    });
  }

  test('CHAOS-12 positive control: with the byte-flip REMOVED the op is NOT quarantined — it applies (the quarantine is load-bearing)', async () => {
    const ids = mintIdentities(1, 3);
    const [dId, kId] = ids.devices as readonly [DeviceIdentity, DeviceIdentity];
    const [goodK, alsoGoodK] = await authorNotes(kId, 1, 2);

    const device = await VirtualDevice.open({
      identity: dId,
      clock: new FakeClock(CLOCK_BASE),
      prng: mulberry32(1),
    });
    const transport = new ScriptedTransport();
    // The SAME batch shape as the main test, but the second op is NOT corrupted. If quarantine fired
    // on everything this would still be held; it is not — the only difference from the main test is
    // the missing byte-flip, so the guard is proven to key on the signature (watched red → green).
    transport.scriptPull({
      ops: [goodK!, alsoGoodK!],
      nextCursor: NEXT_CURSOR,
      hasMore: false,
      serverTime: CLOCK_BASE,
      devices: [deviceInfoOf(kId)],
      devicesDirectoryVersion: 1,
    });
    try {
      const result = await pullDevice(device, transport);
      expect(result.applied).toBe(2);
      expect(result.quarantined).toBe(0);
      expect(await quarantinedIds(device)).toEqual([]);
      expect(await notesRows(device.db)).toHaveLength(2);
    } finally {
      await device.close();
    }
  });
});
