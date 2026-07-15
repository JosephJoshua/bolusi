// Push per-op result semantics through the WIRE (api/01-sync §3; 05 §8). The task-07 pipeline owns
// the classification; this asserts the sync endpoint SURFACES it faithfully — independent per-op
// statuses, CHAIN_BROKEN → CHAIN_HALTED remainder, skip-ahead → CHAIN_GAP (distinct from tamper).
import { breakPreviousHash, resign } from '@bolusi/test-support';
import type { PushResponse } from '@bolusi/schemas';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { serverCryptoPort } from '../../../src/oplog/index.js';
import { makeSyncHarness, type SyncHarness } from './helpers.js';

let h: SyncHarness;
beforeEach(async () => {
  h = await makeSyncHarness();
});
afterEach(async () => {
  await h.close();
});

const note = (title: string, body: string) => ({
  type: 'notes.note_created',
  entityType: 'note',
  payload: { title, body },
});
const WRONG_HASH = 'a'.repeat(64);
const FOREIGN_TENANT = '00000000-0000-4000-8000-000000000000';

async function pushJson(res: Response): Promise<PushResponse> {
  return (await res.json()) as PushResponse;
}

describe('mixed batch — per-op statuses are independent', () => {
  test('an accepted op precedes a foreign-tenant SCOPE_VIOLATION; the accepted op is unaffected', async () => {
    const dev = await h.seedDevice(20);
    const genesis = dev.builder.genesis(); // seq 1
    const note1 = dev.builder.append(note('x', 'y')); // seq 2, chains off genesis
    // Re-sign op 2 over a core whose tenantId is a DIFFERENT tenant: valid chain + signature, so it
    // reaches (and only trips) the scope gate, not BAD_SIGNATURE.
    const foreign = resign(
      { ...note1, tenantId: FOREIGN_TENANT },
      dev.world.secretKey,
      serverCryptoPort,
    );

    const body = await pushJson(await h.push(dev.auth, dev.world.deviceId, [genesis, foreign]));
    expect(body.results[0]).toMatchObject({ status: 'accepted', serverSeq: 1 });
    expect(body.results[1]).toMatchObject({ status: 'rejected', code: 'SCOPE_VIOLATION' });
    expect(Number.isInteger(body.serverTime)).toBe(true);
  });
});

describe('chain semantics surfaced on the wire (05 §8)', () => {
  test('CHAIN_BROKEN at op k → remainder CHAIN_HALTED (not re-validated)', async () => {
    const dev = await h.seedDevice(21);
    const genesis = dev.builder.genesis();
    const note1 = dev.builder.append(note('a', 'b')); // seq 2
    const note2 = dev.builder.append(note('c', 'd')); // seq 3
    const broken = breakPreviousHash(note1, WRONG_HASH, dev.world.secretKey, serverCryptoPort);

    const body = await pushJson(
      await h.push(dev.auth, dev.world.deviceId, [genesis, broken, note2]),
    );
    expect(body.results[0]?.status).toBe('accepted');
    expect(body.results[1]).toMatchObject({ status: 'rejected', code: 'CHAIN_BROKEN' });
    expect(body.results[2]).toMatchObject({ status: 'rejected', code: 'CHAIN_HALTED' });
  });

  test('skip-ahead seq → CHAIN_GAP (distinguished from a tampered CHAIN_BROKEN)', async () => {
    const dev = await h.seedDevice(22);
    const genesis = dev.builder.genesis(); // seq 1
    dev.builder.append(note('a', 'b')); // seq 2 — built but NOT pushed (creates the gap)
    const seq3 = dev.builder.append(note('c', 'd')); // seq 3

    await h.push(dev.auth, dev.world.deviceId, [genesis]); // accept seq 1, head = 1
    const body = await pushJson(await h.push(dev.auth, dev.world.deviceId, [seq3])); // seq 3 skips 2
    expect(body.results[0]).toMatchObject({ status: 'rejected', code: 'CHAIN_GAP' });
  });
});
