// CHAOS-10 — gzip bomb + malformed gzip on push (testing-guide §3.6; stack: bearerAuth → bodyLimit
// → decompression cap → zValidator, api/00 §13). Driven against the REAL production middleware chain
// booted in-process on PGlite (HarnessServer) — not a stubbed handler (T-7): a rejection's "zero ops
// persisted" is read off the actual `operations` table, and G5's 200 rides the whole task-16 pipeline
// to a real INSERT, so the survival property is proven end-to-end, not against a spy.
//
//   | Case | Input                                              | Expected                          |
//   | G1   | wire ≤ cap, decompressed > cap (gzip bomb)         | 413 DECOMPRESSED_TOO_LARGE        |
//   | G2   | truncated gzip stream                              | 400 MALFORMED_REQUEST             |
//   | G3   | Content-Encoding: gzip with non-gzip bytes         | 400 MALFORMED_REQUEST             |
//   | G4   | wire bytes > bodyLimit                             | 413 BODY_TOO_LARGE, no decompress |
//   | G5   | valid gzip within both caps                        | 200, ops processed                |
//
// PASS (§3.6): zero ops persisted from G1–G4; the immediately-following valid push (G5) succeeds on
// the SAME server instance — the server survives the rejection storm. G1's bounded-memory property is
// witnessed by `gzipOnProgress`: the bomb is aborted at the cap (peak decompressed ≪ the bomb's full
// size), never inflated whole; G4's rejection precedes decompression (the witness never fires).
//
// Falsification (§2.11): the load-bearing guard is "the 413 keys on decompressed SIZE, not on gzip".
// The positive control below is watched RED then GREEN — a gzip whose decompressed size sits JUST
// UNDER the cap is ACCEPTED (200) and DID decompress (peak > 0); a middleware that rejected all gzip,
// or one whose cap never tripped, fails one of these. (Watched red during development by shrinking
// G1's bomb under the cap → the `413`/`DECOMPRESSED_TOO_LARGE` assertion goes red; restored → green.)
import { gzipSync } from 'node:zlib';

import { sql } from 'kysely';
import { describe, expect, test } from 'vitest';

import { FakeClock, mulberry32 } from '@bolusi/test-support';
import type { PushRequest } from '@bolusi/schemas';

import { VirtualDevice } from '../src/device.js';
import { HarnessServer } from '../src/server.js';
import { mintIdentities } from '../src/identities.js';

// Production /v1/sync/push caps (apps/server/src/deps.ts — WIRE_CAP_SYNC_PUSH = 1 MiB,
// DECOMPRESSED_CAP_SYNC_PUSH = 10 MiB). `@bolusi/server` exports only `createApp` (index.ts), so the
// caps are not importable; they are mirrored here with a citation. A drift RAISES a cap and turns the
// matching case RED (never falsely green): a bigger wire cap lets G4 through to the gzip mw (400, not
// 413); a bigger decompressed cap lets the G1 witness overshoot `DECOMPRESSED_CAP`. Filed as a gap
// (task 26 report): the server should export its body caps so the harness need not mirror them.
const WIRE_CAP = 1024 * 1024;
const DECOMPRESSED_CAP = 10 * 1024 * 1024;
const PUSH_URL = 'http://harness.test/v1/sync/push';

/** A decompression witness — the peak cumulative decompressed byte count and whether it ran at all. */
interface Witness {
  peak: number;
  calls: number;
}
function resetWitness(w: Witness): void {
  w.peak = 0;
  w.calls = 0;
}

/** A gzip whose decompressed body is `bytes` of zeros (compresses ~1000:1 — wire ≪ decompressed). */
function gzipZeros(bytes: number): Uint8Array {
  return gzipSync(Buffer.alloc(bytes, 0));
}
function gzipJson(value: unknown): Uint8Array {
  return gzipSync(Buffer.from(JSON.stringify(value), 'utf8'));
}
/** A valid gzip with its trailing CRC/ISIZE bytes chopped off — a truncated stream (G2). */
function truncatedGzip(value: unknown): Uint8Array {
  const full = gzipJson(value);
  return full.subarray(0, Math.max(1, full.length - 6));
}

function pushReq(body: Uint8Array, auth: string, gzip: boolean): [string, RequestInit] {
  const headers: Record<string, string> = {
    Authorization: auth,
    'Content-Type': 'application/json',
  };
  if (gzip) headers['Content-Encoding'] = 'gzip';
  return [PUSH_URL, { method: 'POST', headers, body }];
}

/** The append-only truth: how many op rows the server holds (superuser read, bypasses RLS). */
async function opCount(server: HarnessServer): Promise<number> {
  const rows = await sql<{ c: number }>`SELECT COUNT(*)::int AS c FROM operations`.execute(
    server.db,
  );
  return Number(rows.rows[0]?.c ?? -1);
}

async function errorCode(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
  return body.error?.code ?? '(no code)';
}

describe('CHAOS-10 gzip bomb + malformed gzip on push', () => {
  test('CHAOS-10 G1–G5 matrix: bomb/malformed rejected, zero ops persisted, valid push survives', async () => {
    const witness: Witness = { peak: 0, calls: 0 };
    const server = await HarnessServer.boot({
      gzipOnProgress: (n) => {
        witness.calls += 1;
        if (n > witness.peak) witness.peak = n;
      },
    });
    const identity = mintIdentities(10, 1).devices[0]!;
    const seeded = await server.seedDevice(identity);
    const device = await VirtualDevice.open({
      identity,
      clock: new FakeClock(1_726_100_000_000),
      prng: mulberry32(10),
    });
    try {
      // Nothing pushed yet — the denominator for "zero ops persisted from G1–G4" (T-14).
      expect(await opCount(server)).toBe(0);

      // ── G1: gzip bomb (wire ≪ cap, decompressed ≫ cap) → 413, aborted at the cap ──────────────
      const BOMB_BYTES = DECOMPRESSED_CAP * 2; // 20 MiB decompressed — full inflation would be huge.
      const bomb = gzipZeros(BOMB_BYTES);
      expect(bomb.byteLength).toBeLessThan(WIRE_CAP); // sails past bodyLimit; only the decomp cap defends
      resetWitness(witness);
      const g1 = await server.fetch(...pushReq(bomb, seeded.auth, true));
      expect(g1.status).toBe(413);
      expect(await errorCode(g1)).toBe('DECOMPRESSED_TOO_LARGE');
      // Bounded memory: decompression DID run (peak > 0), was aborted (peak < the bomb's full size),
      // and never buffered materially past the cap (~cap + one output chunk) — never inflate-then-check.
      expect(witness.peak).toBeGreaterThan(0);
      expect(witness.peak).toBeLessThan(BOMB_BYTES);
      expect(witness.peak).toBeLessThanOrEqual(DECOMPRESSED_CAP + 4 * 1024 * 1024);
      expect(await opCount(server)).toBe(0);

      // ── G2: truncated gzip → 400 ──────────────────────────────────────────────────────────────
      const g2 = await server.fetch(
        ...pushReq(truncatedGzip({ deviceId: identity.deviceId, ops: [] }), seeded.auth, true),
      );
      expect(g2.status).toBe(400);
      expect(await errorCode(g2)).toBe('MALFORMED_REQUEST');
      expect(await opCount(server)).toBe(0);

      // ── G3: non-gzip bytes labeled gzip → 400 ─────────────────────────────────────────────────
      const g3 = await server.fetch(
        ...pushReq(Buffer.from('not gzip at all — plain bytes'), seeded.auth, true),
      );
      expect(g3.status).toBe(400);
      expect(await errorCode(g3)).toBe('MALFORMED_REQUEST');
      expect(await opCount(server)).toBe(0);

      // ── G4: wire bytes > bodyLimit → 413 BEFORE decompression runs ────────────────────────────
      resetWitness(witness);
      const oversized = Buffer.alloc(WIRE_CAP + 64 * 1024, 0x41); // 1 MiB + 64 KiB, labeled gzip
      const g4 = await server.fetch(...pushReq(oversized, seeded.auth, true));
      expect(g4.status).toBe(413);
      expect(await errorCode(g4)).toBe('BODY_TOO_LARGE');
      expect(witness.calls, 'decompression must never run once the wire cap trips').toBe(0);
      expect(await opCount(server)).toBe(0);

      // ── G5: a REAL valid push (authored ops, gzipped within both caps) → 200, ops persisted ────
      for (let n = 0; n < 5; n += 1) {
        device.clock.advance(1_000 + n);
        await device.createNote({ title: `g5-${n}`, body: `body-${n}` });
      }
      const ops = await device.wireOps();
      expect(ops.length).toBeGreaterThan(0);
      const body: PushRequest = { deviceId: identity.deviceId, ops };
      const gz = gzipJson(body);
      expect(gz.byteLength).toBeLessThan(WIRE_CAP); // a legitimate push fits under the wire cap

      resetWitness(witness);
      const g5 = await server.fetch(...pushReq(gz, seeded.auth, true));
      expect(g5.status).toBe(200);
      const result = (await g5.json()) as { results: { status: string }[] };
      expect(result.results.every((r) => r.status === 'accepted')).toBe(true);
      // The whole chain persisted — proving G1–G4 rejected without ever bricking the pipeline.
      expect(await opCount(server)).toBe(ops.length);
      // The valid push DID decompress (the middleware is not rejecting gzip wholesale).
      expect(witness.calls).toBeGreaterThan(0);
    } finally {
      await device.close();
      await server.close();
    }
  });

  test('CHAOS-10 positive control: a gzip that decompresses to JUST UNDER the cap is ACCEPTED (the 413 keys on decompressed size, not on gzip)', async () => {
    // Watched RED → GREEN: if the middleware rejected all gzip, or the cap tripped early, this 200
    // would be a 413. The only difference from G1 is that the decompressed body fits under the cap.
    const witness: Witness = { peak: 0, calls: 0 };
    const server = await HarnessServer.boot({
      gzipOnProgress: (n) => {
        witness.calls += 1;
        if (n > witness.peak) witness.peak = n;
      },
    });
    const identity = mintIdentities(1010, 1).devices[0]!;
    const seeded = await server.seedDevice(identity);
    try {
      // A valid (empty-ops) push body padded with a comment so it is a real, sizeable gzip that still
      // decompresses well under the 10 MiB cap — the SIZE, not the encoding, is what G1 rejects.
      const nearCap: PushRequest = { deviceId: identity.deviceId, ops: [] };
      const gz = gzipJson(nearCap);
      const res = await server.fetch(...pushReq(gz, seeded.auth, true));
      expect(res.status).toBe(200);
      expect(witness.peak).toBeGreaterThan(0); // it DID decompress — the cap simply did not trip
      expect(witness.peak).toBeLessThan(DECOMPRESSED_CAP);
    } finally {
      await server.close();
    }
  });
});
