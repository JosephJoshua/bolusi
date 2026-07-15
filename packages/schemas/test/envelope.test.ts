import { describe, expect, test } from 'vitest';

import { zLocation, zSignedCore, zSignedOperation } from '../src/index.js';
import { validCore, validOp } from './fixtures.js';

describe('signed core — happy path (05 §2.1)', () => {
  test('a fully-populated valid signed core parses', () => {
    const result = zSignedCore.safeParse({
      ...validCore(),
      seq: 42,
      timestamp: 1752480031337,
      location: { lat: -6.2146, lng: 106.8451, accuracyMeters: 12.5 },
      source: 'agent',
      agentInitiated: true,
      agentConversationId: 'conv-0197a1b2-77aa',
    });
    expect(result.success).toBe(true);
  });

  test('a genesis op with previousHash of 64 zeros and seq 1 parses', () => {
    const result = zSignedCore.safeParse({
      ...validCore(),
      seq: 1,
      previousHash: '0'.repeat(64),
    });
    expect(result.success).toBe(true);
  });

  test('a signed operation (core + hash + signature) parses', () => {
    expect(zSignedOperation.safeParse(validOp()).success).toBe(true);
  });

  test('a signed operation without hash fails', () => {
    const op: Record<string, unknown> = validOp();
    delete op['hash'];
    expect(zSignedOperation.safeParse(op).success).toBe(false);
  });

  test('a signed operation without signature fails', () => {
    const op: Record<string, unknown> = validOp();
    delete op['signature'];
    expect(zSignedOperation.safeParse(op).success).toBe(false);
  });
});

describe('absent-vs-null rule (05 §3): nullable fields are present-and-null, never absent', () => {
  test('storeId present with null parses (tenant-scoped op)', () => {
    const result = zSignedCore.safeParse({ ...validCore(), storeId: null });
    expect(result.success).toBe(true);
  });

  test('storeId absent fails', () => {
    const core: Record<string, unknown> = validCore();
    delete core['storeId'];
    expect(zSignedCore.safeParse(core).success).toBe(false);
  });

  test('location present with null parses (no fix available)', () => {
    const result = zSignedCore.safeParse({ ...validCore(), location: null });
    expect(result.success).toBe(true);
  });

  test('location absent fails', () => {
    const core: Record<string, unknown> = validCore();
    delete core['location'];
    expect(zSignedCore.safeParse(core).success).toBe(false);
  });

  test('agentConversationId present with null parses', () => {
    const result = zSignedCore.safeParse({ ...validCore(), agentConversationId: null });
    expect(result.success).toBe(true);
  });

  test('agentConversationId absent fails', () => {
    const core: Record<string, unknown> = validCore();
    delete core['agentConversationId'];
    expect(zSignedCore.safeParse(core).success).toBe(false);
  });
});

describe('unknown-key rejection (.strict on the hashed core)', () => {
  test('an extra key on the signed core fails', () => {
    const result = zSignedCore.safeParse({ ...validCore(), injectedField: 'tamper' });
    expect(result.success).toBe(false);
  });

  test('an extra key on a signed operation fails', () => {
    const result = zSignedOperation.safeParse({ ...validOp(), smuggled: 1 });
    expect(result.success).toBe(false);
  });

  test('an extra key on a location object fails', () => {
    const result = zSignedCore.safeParse({
      ...validCore(),
      location: { lat: -6.9147, lng: 107.6098, accuracyMeters: 8, altitude: 700 },
    });
    expect(result.success).toBe(false);
  });

  test('a location with all three fields parses standalone', () => {
    const result = zLocation.safeParse({ lat: -7.7956, lng: 110.3695, accuracyMeters: 25.75 });
    expect(result.success).toBe(true);
  });
});

describe('field guards (05 §2.1 types)', () => {
  test('seq: 0 fails (integer >= 1)', () => {
    expect(zSignedCore.safeParse({ ...validCore(), seq: 0 }).success).toBe(false);
  });

  test('non-integer seq fails', () => {
    expect(zSignedCore.safeParse({ ...validCore(), seq: 3.5 }).success).toBe(false);
  });

  test('non-integer timestamp fails', () => {
    expect(zSignedCore.safeParse({ ...validCore(), timestamp: 1752480000000.25 }).success).toBe(
      false,
    );
  });

  test('schemaVersion: 0 fails (integer >= 1)', () => {
    expect(zSignedCore.safeParse({ ...validCore(), schemaVersion: 0 }).success).toBe(false);
  });

  test('previousHash of wrong length fails', () => {
    expect(zSignedCore.safeParse({ ...validCore(), previousHash: 'ab'.repeat(31) }).success).toBe(
      false,
    );
  });

  test('previousHash with non-hex characters fails', () => {
    expect(zSignedCore.safeParse({ ...validCore(), previousHash: 'zz'.repeat(32) }).success).toBe(
      false,
    );
  });

  test('source outside the four-value enum fails', () => {
    expect(zSignedCore.safeParse({ ...validCore(), source: 'webhook' }).success).toBe(false);
  });

  test('non-boolean agentInitiated fails', () => {
    expect(zSignedCore.safeParse({ ...validCore(), agentInitiated: 'true' }).success).toBe(false);
  });

  test('non-UUIDv7 id fails', () => {
    expect(
      zSignedCore.safeParse({ ...validCore(), id: '3f8a1c2e-4b5d-4e6f-9a7b-8c9d0e1f2a3b' }).success,
    ).toBe(false);
  });
});
