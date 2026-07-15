// Per-device chain positioning + genesis rules (05-operation-log §2.1, §4, §9.5).
import {
  assertGenesisRules,
  GENESIS_OP_TYPE,
  GenesisRuleError,
  nextChainPosition,
  type ChainHead,
  type GenesisRuleCode,
} from '@bolusi/core';
import { GENESIS_PREVIOUS_HASH } from '@bolusi/schemas';
import { describe, expect, it } from 'vitest';

const DEVICE = '0191c1a0-0000-7000-8000-000000000abc';

describe('nextChainPosition', () => {
  it('gives the genesis position (seq 1, 64-zero previousHash) for an empty chain', () => {
    expect(nextChainPosition(null)).toEqual({ seq: 1, previousHash: GENESIS_PREVIOUS_HASH });
  });

  it('advances seq and links previousHash to the head hash for a non-empty chain', () => {
    const head: ChainHead = { seq: 7, hash: 'b'.repeat(64) };
    expect(nextChainPosition(head)).toEqual({ seq: 8, previousHash: 'b'.repeat(64) });
  });
});

describe('assertGenesisRules (05 §9.5)', () => {
  function codeOf(fn: () => void): GenesisRuleCode | 'NO_THROW' {
    try {
      fn();
      return 'NO_THROW';
    } catch (error) {
      if (error instanceof GenesisRuleError) return error.code;
      throw error;
    }
  }

  it('ACCEPTS a valid genesis op: auth.device_enrolled, entityId = deviceId, empty chain', () => {
    expect(
      codeOf(() => assertGenesisRules({ type: GENESIS_OP_TYPE, entityId: DEVICE }, null, DEVICE)),
    ).toBe('NO_THROW');
  });

  it('rejects any non-genesis type as the first op on the device', () => {
    expect(
      codeOf(() =>
        assertGenesisRules({ type: 'notes.note_created', entityId: DEVICE }, null, DEVICE),
      ),
    ).toBe('NON_GENESIS_FIRST_OP');
  });

  it('rejects a genesis op whose entityId is not the device id', () => {
    expect(
      codeOf(() =>
        assertGenesisRules(
          { type: GENESIS_OP_TYPE, entityId: '0191c1a0-0000-7000-8000-000000000fff' },
          null,
          DEVICE,
        ),
      ),
    ).toBe('GENESIS_ENTITY_MISMATCH');
  });

  it('rejects a second auth.device_enrolled once the chain is non-empty', () => {
    const head: ChainHead = { seq: 3, hash: 'c'.repeat(64) };
    expect(
      codeOf(() => assertGenesisRules({ type: GENESIS_OP_TYPE, entityId: DEVICE }, head, DEVICE)),
    ).toBe('GENESIS_ON_NON_EMPTY_CHAIN');
  });

  it('ACCEPTS an ordinary op on a non-empty chain', () => {
    const head: ChainHead = { seq: 3, hash: 'c'.repeat(64) };
    expect(
      codeOf(() =>
        assertGenesisRules(
          { type: 'notes.note_created', entityId: '0191c1a0-0000-7000-8000-000000000eee' },
          head,
          DEVICE,
        ),
      ),
    ).toBe('NO_THROW');
  });
});
