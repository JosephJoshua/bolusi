// SEC-DEV-07 (security-guide §221) — the END-TO-END join its two partial legs never made.
//
// §221 requires: "Simulate extracted signing key: forge an op with correct signature but stale
// chain state → CHAIN_BROKEN + device_anomalies row recorded against the device and surfaced in
// GET /v1/devices anomaly counts (the documented §6.2 mitigation actually fires)."
//
// That guarantee ships across two files, but NEITHER completes it:
//   - GENERATION leg — apps/server/test/integration/oplog/sec-oplog.test.ts (SEC-OPLOG-03): a
//     `breakPreviousHash` forge (device's REAL key + stale chain) → CHAIN_BROKEN + a CHAIN_BROKEN
//     anomaly row, through the real pipeline. It never touches GET /v1/devices.
//   - SURFACING leg — apps/server/test/security/sec-dev.test.ts: GET /v1/devices surfaces anomaly
//     counts — but from SEEDED device_anomalies rows, not a forge.
// So the §6.2 mitigation was proven at each end and NOWHERE asserted to fire end-to-end (forge →
// row → owner-visible count). This is that single completing scenario, so its describe/test title
// carries the id VERBATIM (security-guide §2.1.6 — only the test that completes an id may embed it),
// and it uses a REAL forge and a REAL GET — no seeded anomaly rows anywhere.
//
// Why one file can join them: the identity harness (createApp + GET /v1/devices) and the oplog
// pipeline (processPushBatch) both run over @bolusi/db-server's `forTenant` — SET LOCAL ROLE
// bolusi_app + transaction-local app.tenant_id — against ONE real PostgreSQL 16 database. So the
// device_anomalies row the pipeline writes under the tenant is the very row the owner's GET reads
// back under RLS. If they resolved to different databases the count would read 0, which is exactly
// the failure the §2.11 falsification (below) drives.
import { afterEach, beforeEach, expect, test } from 'vitest';

import { breakPreviousHash, ChainBuilder, makeWorld, type ChainWorld } from '@bolusi/test-support';

import { serverCryptoPort } from '../../src/oplog/crypto.js';
import { processPushBatch } from '../../src/oplog/pipeline.js';
import { makeDeps, makeFakeClock } from '../integration/oplog/helpers.js';
import {
  makeIdentityHarness,
  provision,
  seedControlSession,
  seedDevice,
  type IdentityHarness,
} from '../helpers/identity-app.js';

let h: IdentityHarness;
beforeEach(async () => {
  h = await makeIdentityHarness();
});
afterEach(async () => {
  await h.close();
});

test('SEC-DEV-07 key-compromise containment end-to-end: a forged op (correct signature, stale chain) records a CHAIN_BROKEN anomaly through the real push pipeline that GET /v1/devices surfaces to the owner', async () => {
  // --- A real tenant + owner. main_owner holds auth.device_read tenant-wide, so the owner's
  //     GET /v1/devices lists every device in the tenant with its anomaly counts (§7.1). ---
  const p = await provision(h, {
    tenantName: 'T',
    storeNames: ['S'],
    ownerName: 'O',
    ownerLogin: `o-${Math.random()}`,
  });
  const storeId = p.storeIds[0] as string;
  const control = await seedControlSession(h, { tenantId: p.tenantId, userId: p.ownerUserId });

  // --- The compromised device: its signing_key_public is a REAL Ed25519 public key (the key the
  //     forger "extracted"), and it is enrolled in the owner's tenant/store. The owner user authors
  //     the ops — a tenant member, so a legitimate genesis passes scope. ---
  const raw = makeWorld(20_250_720, serverCryptoPort);
  const world: ChainWorld = { ...raw, tenantId: p.tenantId, storeId, userId: p.ownerUserId };
  await seedDevice(h, {
    tenantId: p.tenantId,
    storeId,
    enrolledBy: p.ownerUserId,
    deviceId: world.deviceId,
  });
  // Replace the harness's placeholder pubkey with the world's REAL public key, so the forged op's
  // signature verifies against the enrolled key — it must clear the crypto gate and trip the CHAIN
  // check (CHAIN_BROKEN), not fail as BAD_SIGNATURE for the wrong reason (testing-guide T-14b).
  await h.idb.db
    .updateTable('devices')
    .set({ signingKeyPublic: world.publicKeyB64 })
    .where('id', '=', world.deviceId)
    .execute();

  // --- The real push pipeline, over the SAME database's production-shape forTenant. A fixed clock
  //     near the builder's genesis timestamp: the anomaly's `at` is then deterministic (assertable
  //     as the surfaced last-anomaly-at) AND the honest genesis stays inside the 48h skew window,
  //     so it records no spurious CLOCK_SKEW anomaly that would inflate the count. ---
  const ANOMALY_AT = 1_726_000_050_000;
  const deps = makeDeps({ forTenant: h.idb.forTenant, clock: makeFakeClock(ANOMALY_AT) });
  const identity = { deviceId: world.deviceId, tenantId: world.tenantId };

  const builder = new ChainBuilder(world, serverCryptoPort);
  const genesis = builder.genesis();
  const op2 = builder.append({
    type: 'notes.note_created',
    entityType: 'note',
    payload: { title: 'a', body: 'b' },
  });

  // Genesis is accepted and advances the device chain head — the state a key-thief cannot perfectly
  // reproduce offline.
  const accepted = await processPushBatch(deps, identity, [genesis]);
  expect(accepted.results[0]).toMatchObject({ status: 'accepted', serverSeq: 1 });

  // THE FORGE: the extracted key re-signs op2 (a valid signature) but over a STALE previousHash the
  // forger could not reconstruct. Correct signature, stale chain → CHAIN_BROKEN — precisely the
  // tamper §6.2 says the alarm catches ("a forger who lacks perfect chain state").
  const forged = breakPreviousHash(op2, '1'.repeat(64), world.secretKey, serverCryptoPort);
  const rejected = await processPushBatch(deps, identity, [forged]);
  expect(rejected.results[0]).toMatchObject({ status: 'rejected', code: 'CHAIN_BROKEN' });

  // --- The owner opens the device-management view. GET /v1/devices must surface the anomaly the
  //     forge just produced — count 1, last-anomaly-at = the pipeline write's timestamp. The mitigation
  //     fires end-to-end: forge → real anomaly row → owner-visible count. NOTHING seeded. ---
  const list = await h.app.request('http://srv.test/v1/devices', {
    headers: { Authorization: `Bearer ${control}` },
  });
  expect(list.status).toBe(200);
  const devices = (
    (await list.json()) as {
      devices: Array<{ deviceId: string; anomalyCount: number; lastAnomalyAt: number | null }>;
    }
  ).devices;
  const row = devices.find((d) => d.deviceId === world.deviceId);
  expect(row?.anomalyCount).toBe(1);
  expect(row?.lastAnomalyAt).toBe(ANOMALY_AT);
});
