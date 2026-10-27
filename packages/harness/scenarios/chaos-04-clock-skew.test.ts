// CHAOS-04 — clock skew (testing-guide §3.6 / 05 §6). A PAST timestamp is flagged, never rejected
// (assume drift, not malice): the SAME −72h skew is FLAGGED for a just-synced device (narrow ~48h
// allowance) and NOT flagged for a 5-days-offline device (allowance widened to ~168h) — the flag is a
// function of the device's offline window, not of the timestamp alone. A FUTURE timestamp beyond the
// margin is refused CLOCK_AHEAD (owner decision 2026-10-26, core sync/clock-guard.ts): it would win
// last-writer-wins over every honest change until then.
//
// Setup (§3.6): A clock −72h and `lastSyncAt` < 1h ago (threshold ≈ 48h → flagged); B +72h (refused);
// C offline 5 days with −72h skew (threshold ≈ 48h + 120h → within allowance, unflagged); D honest;
// E +5 min (inside the margin → accepted, unflagged). All push to the REAL server (its production
// steps run verbatim — T-7). PASS: A flagged, C/D/E unflagged, B refused with a device alarm and
// nothing of B's in the log, flagged ops project like any other, and the merged projection converges.
//
// Falsification (§2.11): the flag matrix carries BOTH values in one run — A is `true`, D is `false`,
// and the refusal matrix carries both too (B refused, E accepted at +5 min).
import { sql } from 'kysely';
import { describe, expect, test } from 'vitest';

import { FakeClock, mulberry32 } from '@bolusi/test-support';
import { notesOnly } from '@bolusi/test-support/chaos';
import type { SignedOperation } from '@bolusi/schemas';

import { VirtualDevice } from '../src/device.js';
import { HarnessServer } from '../src/server.js';
import { mintIdentities } from '../src/identities.js';
import { canonicalFold, assertConvergence, notesRows } from '../src/oracle.js';
import { HttpTransport } from '../src/transport.js';
import { resolveSeeds, withSeed } from '../src/index.js';

const H = 3_600_000;
const R = 1_726_100_000_000; // == HarnessServer's SERVER_CLOCK_BASE: the server receivedAt.

interface SkewDevice {
  readonly label: 'A' | 'B' | 'C' | 'D' | 'E';
  readonly clockBase: number;
  readonly lastSyncAt: number | null;
  /** `refused`: every op comes back CLOCK_AHEAD; otherwise accepted with this flag. */
  readonly expect: 'flagged' | 'unflagged' | 'refused';
}

// A −72h: just synced (lastSyncAt 30m ago → threshold ~48.5h) → 72h > threshold → FLAGGED.
// B +72h: ahead of the server beyond the margin → REFUSED.
// C −72h: 5 days offline (lastSyncAt 120h ago → threshold 168h) → 72h < threshold → unflagged.
// D honest → unflagged. E +5 min: ordinary drift inside the margin → accepted, unflagged.
const PLAN: readonly SkewDevice[] = [
  { label: 'A', clockBase: R - 72 * H, lastSyncAt: R - 30 * 60_000, expect: 'flagged' },
  { label: 'B', clockBase: R + 72 * H, lastSyncAt: R - 30 * 60_000, expect: 'refused' },
  { label: 'C', clockBase: R - 72 * H, lastSyncAt: R - 120 * H, expect: 'unflagged' },
  { label: 'D', clockBase: R, lastSyncAt: null, expect: 'unflagged' },
  { label: 'E', clockBase: R + 5 * 60_000, lastSyncAt: null, expect: 'unflagged' },
];

async function setLastSync(
  server: HarnessServer,
  deviceId: string,
  at: number | null,
): Promise<void> {
  await sql`UPDATE devices SET last_sync_at = ${at} WHERE id = ${deviceId}`.execute(server.db);
}

async function flagsByDevice(server: HarnessServer): Promise<Map<string, boolean[]>> {
  const rows = await sql<{ deviceId: string; clockSkewFlagged: boolean }>`
    SELECT device_id AS "deviceId", clock_skew_flagged AS "clockSkewFlagged" FROM operations
  `.execute(server.db);
  const byDevice = new Map<string, boolean[]>();
  for (const row of rows.rows) {
    const list = byDevice.get(row.deviceId) ?? [];
    list.push(row.clockSkewFlagged === true);
    byDevice.set(row.deviceId, list);
  }
  return byDevice;
}

describe('CHAOS-04 clock skew (flag the past, refuse the future)', () => {
  for (const seed of resolveSeeds()) {
    test(`CHAOS-04 A flagged, B refused, C/D/E unflagged, projections converge [seed ${seed}]`, async () => {
      await withSeed(
        seed,
        async () => {
          const server = await HarnessServer.boot();
          const ids = mintIdentities(seed, PLAN.length);
          const devices = await Promise.all(
            PLAN.map((plan, i) =>
              VirtualDevice.open({
                identity: ids.devices[i]!,
                clock: new FakeClock(plan.clockBase),
                prng: mulberry32(seed * PLAN.length + i),
              }),
            ),
          );
          try {
            for (let i = 0; i < PLAN.length; i += 1) {
              const seeded = await server.seedDevice(ids.devices[i]!);
              await setLastSync(server, ids.devices[i]!.deviceId, PLAN[i]!.lastSyncAt);
              // Author a few notes, clock advancing only seconds so every op stays near clockBase.
              for (let n = 0; n < 5; n += 1) {
                devices[i]!.clock.advance(1_000 + n);
                await devices[i]!.createNote({
                  title: `${PLAN[i]!.label}-${n}`,
                  body: `body-${seed}-${i}-${n}`,
                });
              }
              const ops = await devices[i]!.wireOps();
              const res = await new HttpTransport(server.fetch, seeded.auth).push({
                deviceId: ids.devices[i]!.deviceId,
                ops,
              });
              if (PLAN[i]!.expect === 'refused') {
                expect(
                  res.results.every((r) => r.status === 'rejected' && r.code === 'CLOCK_AHEAD'),
                ).toBe(true);
              } else {
                // A past timestamp is never rejected, however skewed (05 §6).
                expect(res.results.every((r) => r.status === 'accepted')).toBe(true);
              }
            }

            // The flag matrix, read off the REAL server's persisted column.
            const flags = await flagsByDevice(server);
            for (let i = 0; i < PLAN.length; i += 1) {
              const plan = PLAN[i]!;
              const deviceFlags = flags.get(ids.devices[i]!.deviceId) ?? [];
              if (plan.expect === 'refused') {
                // Nothing of B's entered the log, and its clock raised a device alarm.
                expect(deviceFlags).toEqual([]);
                const alarms = await sql<{ kind: string }>`
                  SELECT kind FROM device_anomalies WHERE device_id = ${ids.devices[i]!.deviceId}
                `.execute(server.db);
                expect(alarms.rows.length).toBeGreaterThan(0);
                expect(alarms.rows.every((row) => row.kind === 'CLOCK_SKEW')).toBe(true);
                continue;
              }
              const flagged = plan.expect === 'flagged';
              expect(deviceFlags.length).toBeGreaterThan(0); // denominator (T-14)
              expect(
                deviceFlags.every((f) => f === flagged),
                `device ${plan.label} expected clockSkewFlagged=${flagged}, got ${JSON.stringify(deviceFlags)}`,
              ).toBe(true);
            }
            // The matrix genuinely carries both values (a constant flag would fail one, §2.11).
            expect(flags.get(ids.devices[0]!.deviceId)?.some((f) => f)).toBe(true); // A flagged
            expect(flags.get(ids.devices[3]!.deviceId)?.every((f) => !f)).toBe(true); // D unflagged

            // Convergence: cross-feed every device's notes ops, then all digests == canonical fold —
            // flagged ops project like any other and the future timestamps still sort deterministically.
            const merged = devices.filter((_, i) => PLAN[i]!.expect !== 'refused');
            const universe: SignedOperation[] = [];
            for (const device of merged) universe.push(...notesOnly(await device.wireOps()));
            for (const device of merged) {
              const held = new Set((await device.wireOps()).map((op) => op.id));
              for (const op of universe) if (!held.has(op.id)) await device.applyForeign(op);
            }
            const reference = await canonicalFold(universe);
            assertConvergence(
              reference,
              await Promise.all(
                merged.map(async (device, i) => ({
                  name: `device-${i}`,
                  digest: await device.digest(),
                  rows: await notesRows(device.db),
                })),
              ),
            );
            // Flagged ops ARE in the projection (A's notes present) — 4 accepted devices × 5 notes.
            expect(reference.rows).toHaveLength(merged.length * 5);
          } finally {
            for (const device of devices) await device.close();
            await server.close();
          }
        },
        'CHAOS-04',
      );
    });
  }
});
