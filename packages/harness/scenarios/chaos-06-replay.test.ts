// CHAOS-06 — duplicate replay / backup-restore (testing-guide §3.6 / 05 §5).
//
// Device A pushes a chain; then the ack is "lost" and A replays. PASS (§3.6):
//   (a)+(b) every replayed op returns `duplicate`; the server op count and each op's original
//           `serverSeq` are UNCHANGED (no re-insert, no re-numbering).
//   (c)     pull-applying an op whose `id` A already holds is a no-op.
// All digests unchanged — in particular every `edit_count` (§3.2) identical before/after, proving no
// projection double-application (a last-write-wins projection would hide it; `edit_count` cannot).
//
// The lost-ack retry (a) and the backup-restore (b) are ONE observable: the server accepted the ops
// but the client's marks did not land, so the client re-pushes the same bytes and the server, which
// dedups by op `id` (05 §5), returns `duplicate`. Modelled by pushing the batch to the REAL server
// while leaving the client ops `local` — precisely "the server has them, the client thinks it doesn't".
//
// Falsification (§2.11): the controls below watch both guards go RED — a re-push the server is seeing
// for the FIRST time comes back `accepted` (so `duplicate` is load-bearing, not the server's default),
// and NOVEL pulled ops DO apply and DO move `edit_count` (so `applied === 0` means dedup worked, not
// that the pull path is inert).
import { sql } from 'kysely';
import { describe, expect, test } from 'vitest';

import { FakeClock, mulberry32 } from '@bolusi/test-support';
import type { PushRequest } from '@bolusi/schemas';

import { VirtualDevice, type DeviceIdentity } from '../src/device.js';
import { HarnessServer } from '../src/server.js';
import { mintIdentities } from '../src/identities.js';
import { notesRows, type NotesRow } from '../src/oracle.js';
import { HttpTransport, ScriptedTransport, pullDevice } from '../src/transport.js';
import { resolveSeeds, withSeed } from '../src/index.js';

const CLOCK_BASE = 1_726_100_000_000;
const CHUNK = 150; // two chunks over ~300 ops → the "last 2 batches" the lost-ack retry re-sends.

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Every server op row (id → serverSeq), read as superuser (bypasses RLS) — the append-only truth. */
async function serverSeqById(server: HarnessServer): Promise<Map<string, number>> {
  const rows = await sql<{ id: string; serverSeq: string }>`
    SELECT id, server_seq AS "serverSeq" FROM operations ORDER BY server_seq
  `.execute(server.db);
  return new Map(rows.rows.map((r) => [r.id, Number(r.serverSeq)]));
}

/** Author ~300 ops (creates + repeated edits) so `edit_count` is non-trivial and replay-sensitive. */
async function authorHistory(device: VirtualDevice, seed: number): Promise<void> {
  const prng = mulberry32(seed ^ 0x06_06);
  const noteIds: string[] = [];
  for (let n = 0; n < 30; n += 1) {
    device.clock.advance(1_000);
    noteIds.push(await device.createNote({ title: `n-${seed}-${n}`, body: `b-${seed}-${n}` }));
  }
  for (let e = 0; e < 270; e += 1) {
    device.clock.advance(1_000);
    const target = noteIds[Math.floor(prng() * noteIds.length)]!;
    await device.editNote(target, `edit-${seed}-${e}`);
  }
}

describe('CHAOS-06 duplicate replay / backup-restore', () => {
  for (const seed of resolveSeeds()) {
    test(`CHAOS-06 replayed ops return duplicate, serverSeq + edit_count unchanged [seed ${seed}]`, async () => {
      await withSeed(
        seed,
        async () => {
          const server = await HarnessServer.boot();
          const identity = mintIdentities(seed, 1).devices[0]!;
          const seeded = await server.seedDevice(identity);
          const device = await VirtualDevice.open({
            identity,
            clock: new FakeClock(CLOCK_BASE),
            prng: mulberry32(seed),
          });
          try {
            await authorHistory(device, seed);
            const ops = await device.wireOps(); // genesis + notes, seq-ascending
            const batches = chunk(ops, CHUNK);
            const transport = new HttpTransport(server.fetch, seeded.auth);

            // First delivery: the server accepts the whole chain (this is what the ack would have
            // confirmed). Every op is `accepted` exactly once.
            for (const batch of batches) {
              const res = await transport.push({ deviceId: identity.deviceId, ops: batch });
              expect(res.results.every((r) => r.status === 'accepted')).toBe(true);
            }
            const seqBefore = await serverSeqById(server);
            const countBefore = seqBefore.size;
            expect(countBefore).toBe(ops.length); // denominator: the whole chain landed (T-14)
            const rowsBefore = await notesRows(device.db);
            const digestBefore = await device.digest();

            // (a)/(b) THE REPLAY — re-push the last 2 batches VERBATIM (lost-ack retry / restored backup).
            const replayed: PushRequest['ops'][] = batches.slice(-2);
            for (const batch of replayed) {
              const res = await transport.push({ deviceId: identity.deviceId, ops: batch });
              // Every replayed op comes back `duplicate` — never re-accepted, never re-inserted.
              expect(res.results.every((r) => r.status === 'duplicate')).toBe(true);
            }
            const seqAfter = await serverSeqById(server);
            // Server op count unchanged, and every op's ORIGINAL serverSeq unchanged (05 §5).
            expect(seqAfter.size).toBe(countBefore);
            expect([...seqAfter.entries()].sort()).toEqual([...seqBefore.entries()].sort());

            // (c) Pull-apply 50 ops A already holds → a no-op (dedup by id, 05 §5). A sidecar carries A
            // so no unknown-signer refetch muddies the count.
            const held = ops.filter((o) => o.type.startsWith('notes.')).slice(0, 50);
            expect(held.length).toBe(50);
            const pullTransport = new ScriptedTransport().scriptPull({
              ops: held,
              nextCursor: 999_999,
              hasMore: false,
              serverTime: CLOCK_BASE,
              devices: [
                {
                  id: identity.deviceId,
                  storeId: identity.storeId,
                  kind: 'member',
                  signingKeyPublic: identity.publicKeyBase64,
                  status: 'active',
                  revokedAt: null,
                },
              ],
              devicesDirectoryVersion: 1,
            });
            const pull = await pullDevice(device, pullTransport);
            expect(pull.applied).toBe(0); // every one already held → applied nothing

            // All digests unchanged — the edit_count invariant is the sharp one (§3.2).
            const rowsAfter = await notesRows(device.db);
            expect(await device.digest()).toBe(digestBefore);
            expect(rowsAfter).toEqual(rowsBefore);
            expect(sumEdits(rowsAfter)).toBe(sumEdits(rowsBefore));
            expect(sumEdits(rowsBefore)).toBeGreaterThan(0); // there WERE edits to double-count
          } finally {
            await device.close();
            await server.close();
          }
        },
        'CHAOS-06',
      );
    });
  }

  test('CHAOS-06 positive control: a first-seen push is `accepted` (so `duplicate` is load-bearing) and a NOVEL pulled op DOES apply + moves edit_count', async () => {
    const server = await HarnessServer.boot();
    const seed = 1;
    const [aId, bId] = mintIdentities(seed, 2).devices as readonly [DeviceIdentity, DeviceIdentity];
    const a = await server.seedDevice(aId);
    const deviceA = await VirtualDevice.open({
      identity: aId,
      clock: new FakeClock(CLOCK_BASE),
      prng: mulberry32(seed),
    });
    const deviceB = await VirtualDevice.open({
      identity: bId,
      clock: new FakeClock(CLOCK_BASE),
      prng: mulberry32(seed + 1),
    });
    try {
      // (a)-control: the server is seeing these ops for the FIRST time — they are `accepted`, NOT
      // `duplicate`. If the server defaulted to `duplicate` the main test would pass vacuously.
      const aOps = await (async () => {
        const noteId = await deviceA.createNote({ title: 'first', body: 'first' });
        await deviceA.editNote(noteId, 'first-edit');
        return deviceA.wireOps();
      })();
      const tA = new HttpTransport(server.fetch, a.auth);
      const firstSeen = await tA.push({ deviceId: aId.deviceId, ops: aOps });
      expect(firstSeen.results.every((r) => r.status === 'accepted')).toBe(true);

      // (c)-control: a NOVEL op from B (in the sidecar) applies and moves edit_count — proving the pull
      // path is not inert, so `applied === 0` in the main test means dedup worked.
      const bNoteId = await deviceB.createNote({ title: 'bn', body: 'bn' });
      await deviceB.editNote(bNoteId, 'b-edit');
      const bOps = (await deviceB.wireOps()).filter((o) => o.type.startsWith('notes.'));
      const before = sumEdits(await notesRows(deviceA.db));
      const pullTransport = new ScriptedTransport().scriptPull({
        ops: bOps,
        nextCursor: 1,
        hasMore: false,
        serverTime: CLOCK_BASE,
        devices: [
          {
            id: bId.deviceId,
            storeId: bId.storeId,
            kind: 'member',
            signingKeyPublic: bId.publicKeyBase64,
            status: 'active',
            revokedAt: null,
          },
        ],
        devicesDirectoryVersion: 1,
      });
      const pull = await pullDevice(deviceA, pullTransport);
      expect(pull.applied).toBe(bOps.length);
      expect(sumEdits(await notesRows(deviceA.db))).toBe(before + 1); // the novel edit landed
    } finally {
      await deviceA.close();
      await deviceB.close();
      await server.close();
    }
  });
});

function sumEdits(rows: readonly NotesRow[]): number {
  return rows.reduce((total, row) => total + row.editCount, 0);
}
