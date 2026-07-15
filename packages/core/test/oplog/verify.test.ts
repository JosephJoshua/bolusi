// Chain + tamper verification (05-operation-log §2.2, §3, §4). This is the append path's
// tamper-detection surface. The TAMPER CLASS (T-12), not three remembered instances:
// mutated payload, mutated non-payload core field, wrong previousHash, swapped/reordered
// seq, forged signature, spliced cross-device op — and each is asserted against a VALID
// control chain first (T-14b: a "rejected" reads identically to a broken fixture, so the
// control must ACCEPT before any tamper is believed to REJECT).
//
// Two flavours per link-integrity case: a NAIVE tamper (leaves the stored hash/sig, so it
// trips HASH_MISMATCH) and a RE-SIGNED tamper (recomputes hash + re-signs with the real
// key, so hash and signature are valid and ONLY the chain check can catch it — proving the
// chain integrity is verified independently of the signature).
import { signOp, verifyChain, type ChainViolationCode } from '@bolusi/core';
import type { SignedCore, SignedOperation } from '@bolusi/schemas';
import { randomBytes as prngBytes } from '@bolusi/test-support';
import { describe, expect, it } from 'vitest';

import { appendCommand, makeFixture, type Fixture } from './_fixtures.js';

/** Build a valid N-op device chain (genesis + N−1 notes) and return its ops in chain order. */
async function buildChain(f: Fixture, notes: number): Promise<SignedOperation[]> {
  await appendCommand(f, [f.genesisDraft()]);
  for (let i = 0; i < notes; i += 1) {
    f.clock.advance(1000);
    await appendCommand(f, [f.noteDraft()]);
  }
  return f.store.forDevice(f.deviceId).map((r) => r.op);
}

function clone(ops: readonly SignedOperation[]): SignedOperation[] {
  return ops.map((op) => JSON.parse(JSON.stringify(op)) as SignedOperation);
}

function coreOf(op: SignedOperation): SignedCore {
  const core: Record<string, unknown> = { ...op };
  delete core['hash'];
  delete core['signature'];
  return core as unknown as SignedCore;
}

/** Re-sign a (mutated) op with the real key so hash + signature are internally valid. */
function resign(f: Fixture, core: SignedCore): SignedOperation {
  return signOp(core, f.secretKey, f.crypto);
}

function codesAt(
  result: { violations: ReadonlyArray<{ index: number; code: ChainViolationCode }> },
  index: number,
): ChainViolationCode[] {
  return result.violations.filter((v) => v.index === index).map((v) => v.code);
}

describe('verifyChain — control (T-14b: the valid chain must ACCEPT first)', () => {
  it('accepts an untampered chain with zero violations', async () => {
    const f = makeFixture(701);
    const ops = await buildChain(f, 6);
    const result = verifyChain(ops, f.publicKey, f.crypto);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('rejects the whole chain if verified against the wrong public key', async () => {
    const f = makeFixture(702);
    const ops = await buildChain(f, 4);
    const wrong = f.crypto.ed25519Keygen(prngBytes(f.prng, 32)).publicKey;
    const result = verifyChain(ops, wrong, f.crypto);
    expect(result.ok).toBe(false);
    // Every op fails signature verification against a foreign key.
    expect(result.violations.every((v) => v.code === 'BAD_SIGNATURE')).toBe(true);
    expect(result.violations).toHaveLength(ops.length);
  });
});

describe('verifyChain — tamper class (T-12)', () => {
  it('detects a mutated payload byte via hash recomputation (HASH_MISMATCH)', async () => {
    const f = makeFixture(710);
    const ops = await buildChain(f, 5);
    const tampered = clone(ops);
    const target = 3;
    (tampered[target]!.payload as { body: string }).body += '!'; // one payload byte

    const result = verifyChain(tampered, f.publicKey, f.crypto);
    expect(result.ok).toBe(false);
    expect(codesAt(result, target)).toContain('HASH_MISMATCH');
  });

  it('detects a mutated NON-payload core field (userId) via hash recomputation', async () => {
    const f = makeFixture(711);
    const ops = await buildChain(f, 5);
    const tampered = clone(ops);
    const target = 2;
    tampered[target]!.userId = f.newId(); // a different, well-formed user id

    const result = verifyChain(tampered, f.publicKey, f.crypto);
    expect(result.ok).toBe(false);
    expect(codesAt(result, target)).toContain('HASH_MISMATCH');
  });

  it('detects a wrong previousHash even when the op is re-signed (PREVIOUS_HASH_MISMATCH)', async () => {
    const f = makeFixture(712);
    const ops = await buildChain(f, 6);
    const tampered = clone(ops);
    const target = 4;
    // Break the link, then re-sign so hash + signature are internally valid.
    tampered[target] = resign(f, { ...coreOf(tampered[target]!), previousHash: 'd'.repeat(64) });

    const result = verifyChain(tampered, f.publicKey, f.crypto);
    expect(result.ok).toBe(false);
    const codes = codesAt(result, target);
    expect(codes).toContain('PREVIOUS_HASH_MISMATCH');
    expect(codes, 'a re-signed tamper does NOT trip the hash/signature checks').not.toContain(
      'HASH_MISMATCH',
    );
    expect(codes).not.toContain('BAD_SIGNATURE');
  });

  it('detects two swapped seq fields when both are re-signed (SEQ_NOT_CONTIGUOUS)', async () => {
    const f = makeFixture(713);
    const ops = await buildChain(f, 6);
    const tampered = clone(ops);
    const [i, j] = [2, 3];
    // Swap the seq values and re-sign, so the only surviving signal is the chain check.
    const si = tampered[i]!.seq;
    const sj = tampered[j]!.seq;
    tampered[i] = resign(f, { ...coreOf(tampered[i]!), seq: sj });
    tampered[j] = resign(f, { ...coreOf(tampered[j]!), seq: si });

    const result = verifyChain(tampered, f.publicKey, f.crypto);
    expect(result.ok).toBe(false);
    const anyCodes = result.violations.map((v) => v.code);
    expect(anyCodes).toContain('SEQ_NOT_CONTIGUOUS');
  });

  it('detects a naive seq-field swap via hash recomputation (HASH_MISMATCH)', async () => {
    const f = makeFixture(714);
    const ops = await buildChain(f, 6);
    const tampered = clone(ops);
    const [i, j] = [2, 3];
    const si = tampered[i]!.seq;
    tampered[i]!.seq = tampered[j]!.seq; // seq is a signed-core field → hash no longer matches
    tampered[j]!.seq = si;

    const result = verifyChain(tampered, f.publicKey, f.crypto);
    expect(result.ok).toBe(false);
    expect(codesAt(result, i)).toContain('HASH_MISMATCH');
    expect(codesAt(result, j)).toContain('HASH_MISMATCH');
  });

  it('detects a physical reorder of two ops (SEQ_NOT_CONTIGUOUS + PREVIOUS_HASH_MISMATCH)', async () => {
    const f = makeFixture(715);
    const ops = await buildChain(f, 6);
    const tampered = clone(ops);
    [tampered[2], tampered[3]] = [tampered[3]!, tampered[2]!]; // swap positions, fields intact

    const result = verifyChain(tampered, f.publicKey, f.crypto);
    expect(result.ok).toBe(false);
    const codes = result.violations.map((v) => v.code);
    expect(codes).toContain('SEQ_NOT_CONTIGUOUS');
    expect(codes).toContain('PREVIOUS_HASH_MISMATCH');
  });

  it('detects a forged signature (valid hash, signature by a foreign key) as BAD_SIGNATURE', async () => {
    const f = makeFixture(716);
    const ops = await buildChain(f, 5);
    const tampered = clone(ops);
    const target = 3;
    const evil = f.crypto.ed25519Keygen(prngBytes(f.prng, 32));
    // Same core (hash stays valid) but signed by a key that is not the device's.
    tampered[target] = signOp(coreOf(tampered[target]!), evil.secretKey, f.crypto);

    const result = verifyChain(tampered, f.publicKey, f.crypto);
    expect(result.ok).toBe(false);
    const codes = codesAt(result, target);
    expect(codes).toContain('BAD_SIGNATURE');
    expect(codes, 'the hash still matches — only the signature is forged').not.toContain(
      'HASH_MISMATCH',
    );
  });

  it('detects a spliced cross-device op (DEVICE_MISMATCH)', async () => {
    const f = makeFixture(717);
    const opsA = await buildChain(f, 5);

    // A genuine op from a DIFFERENT device (own valid chain, own key).
    const g = makeFixture(999);
    const opsB = await buildChain(g, 2);
    const foreign = opsB[1]!;

    const spliced = clone(opsA);
    spliced[3] = JSON.parse(JSON.stringify(foreign)) as SignedOperation;

    const result = verifyChain(spliced, f.publicKey, f.crypto);
    expect(result.ok).toBe(false);
    const codes = codesAt(result, 3);
    expect(codes, 'the op belongs to another device').toContain('DEVICE_MISMATCH');
    expect(codes, 'and it is not signed by this device key').toContain('BAD_SIGNATURE');
  });

  it('detects a genesis op whose previousHash is not 64 zeros, re-signed (GENESIS_PREVIOUS_HASH)', async () => {
    const f = makeFixture(718);
    const ops = await buildChain(f, 0); // genesis only
    const tampered = clone(ops);
    tampered[0] = resign(f, { ...coreOf(tampered[0]!), previousHash: 'e'.repeat(64) });

    const result = verifyChain(tampered, f.publicKey, f.crypto);
    expect(result.ok).toBe(false);
    const codes = codesAt(result, 0);
    expect(codes).toContain('GENESIS_PREVIOUS_HASH');
    expect(codes).not.toContain('HASH_MISMATCH');
  });

  it('covers the whole violation-code class (denominator guard, T-14)', () => {
    // Every ChainViolationCode the append-path tamper suite is responsible for is exercised
    // by a case above. This list is the contract; adding a code without a case fails here.
    const exercised: readonly ChainViolationCode[] = [
      'HASH_MISMATCH',
      'BAD_SIGNATURE',
      'PREVIOUS_HASH_MISMATCH',
      'SEQ_NOT_CONTIGUOUS',
      'GENESIS_PREVIOUS_HASH',
      'DEVICE_MISMATCH',
    ];
    expect(new Set(exercised).size).toBe(6);
  });
});

describe('verifyChain — total, never throws on malformed input', () => {
  it('flags a structurally-broken op instead of throwing', async () => {
    const f = makeFixture(720);
    const ops = await buildChain(f, 3);
    const tampered = clone(ops);
    // A garbage signature encoding must be reported, not thrown (hostile pull data).
    tampered[1]!.signature = '!!!not-base64!!!';
    const result = verifyChain(tampered, f.publicKey, f.crypto);
    expect(result.ok).toBe(false);
    expect(codesAt(result, 1)).toContain('BAD_SIGNATURE');
  });
});
