// Committed tamper fixtures (test/oplog/fixtures/tamper/*.json) — the reusable artifact
// for task 07 (server rejection leg) and CHAOS-05. This test loads the SHIPPED files and
// re-verifies them so a corrupted or accidentally-edited fixture fails loudly, and so the
// "reuse" contract (each file's `expectContains` codes are what verifyChain reports) is
// mechanically true, not just asserted in prose.
//
// Platform-free (core tests carry no node types): the fixtures are imported as JSON, not
// read via node:fs, and the base64 device key is decoded with core's own codec. The seven
// explicit imports ARE the denominator (T-14) — a missing fixture is a build error.
//
// Regenerate: the fixtures are produced deterministically from seeds 424242 (device A) and
// 999001 (device B) — see git history `fixtures/_gen.test.ts`, or rebuild via the same
// buildChain + signOp path used in verify.test.ts.
import { base64ToBytes, verifyChain, type ChainViolationCode } from '@bolusi/core';
import type { SignedOperation } from '@bolusi/schemas';
import { noblePort } from '@bolusi/test-support';
import { describe, expect, it } from 'vitest';

import validChain from './fixtures/tamper/valid-chain.json' with { type: 'json' };
import mutatedPayload from './fixtures/tamper/mutated-payload.json' with { type: 'json' };
import mutatedUserId from './fixtures/tamper/mutated-user-id.json' with { type: 'json' };
import wrongPreviousHash from './fixtures/tamper/wrong-previous-hash.json' with { type: 'json' };
import swappedSeq from './fixtures/tamper/swapped-seq.json' with { type: 'json' };
import forgedSignature from './fixtures/tamper/forged-signature.json' with { type: 'json' };
import crossDeviceSplice from './fixtures/tamper/cross-device-splice.json' with { type: 'json' };

interface TamperFixture {
  $comment: string;
  device: { id: string; publicKey: string };
  expectContains: string[];
  index: number | null;
  ops: unknown[];
}

const asFixture = (raw: unknown): TamperFixture => raw as TamperFixture;

const TAMPERED: ReadonlyArray<readonly [string, TamperFixture]> = [
  ['mutated-payload', asFixture(mutatedPayload)],
  ['mutated-user-id', asFixture(mutatedUserId)],
  ['wrong-previous-hash', asFixture(wrongPreviousHash)],
  ['swapped-seq', asFixture(swappedSeq)],
  ['forged-signature', asFixture(forgedSignature)],
  ['cross-device-splice', asFixture(crossDeviceSplice)],
];

function pubkey(fixture: TamperFixture): Uint8Array {
  return base64ToBytes(fixture.device.publicKey);
}

function ops(fixture: TamperFixture): SignedOperation[] {
  return fixture.ops as unknown as SignedOperation[];
}

describe('committed tamper fixtures', () => {
  it('loads exactly the valid control plus six tampered fixtures (denominator guard, T-14)', () => {
    expect(TAMPERED).toHaveLength(6);
    expect(asFixture(validChain).ops.length).toBe(8);
  });

  it('ACCEPTS the valid control chain with zero violations (T-14b)', () => {
    const fixture = asFixture(validChain);
    const result = verifyChain(ops(fixture), pubkey(fixture), noblePort);
    expect(result.ok, fixture.$comment).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it.each(TAMPERED)('detects the tamper in %s with its declared codes', (name, fixture) => {
    const result = verifyChain(ops(fixture), pubkey(fixture), noblePort);

    expect(result.ok, `${name}: ${fixture.$comment}`).toBe(false);
    expect(
      fixture.expectContains.length,
      `${name} declares at least one expected code`,
    ).toBeGreaterThan(0);

    const allCodes = result.violations.map((v) => v.code as string);
    for (const code of fixture.expectContains) {
      expect(allCodes, `${name} must report ${code}`).toContain(code);
      if (fixture.index !== null) {
        const atIndex = result.violations
          .filter((v) => v.index === fixture.index)
          .map((v) => v.code as string);
        expect(atIndex, `${name} reports ${code} at op #${fixture.index}`).toContain(code);
      }
    }
  });

  it('the fixture set exercises the core tamper codes (class coverage, T-12/T-14)', () => {
    const covered = new Set<string>();
    for (const [, fixture] of TAMPERED) {
      for (const code of fixture.expectContains) covered.add(code);
    }
    const required: ChainViolationCode[] = [
      'HASH_MISMATCH',
      'PREVIOUS_HASH_MISMATCH',
      'BAD_SIGNATURE',
      'DEVICE_MISMATCH',
    ];
    for (const code of required) {
      expect(covered.has(code), `class must include ${code}`).toBe(true);
    }
  });
});
