// Draft completion + signing (04-module-contract §5.1 step 4; 05-operation-log §2.1–2.2,
// §3). Proves: every §2.1 field is completed with the right defaults; the hash is
// SHA-256(JCS(core)) recomputed INDEPENDENTLY (T-13 — the test's oracle is the raw crypto
// port + JCS, not the code under test's own claim); the signature verifies; the returned
// JCS is the verbatim preimage; the non-JSON guard rejects the whole class before
// canonicalization; and nullable fields are present-and-null in the actual bytes.
import {
  bytesToHex,
  canonicalizeJcs,
  completeDraft,
  JcsInputError,
  utf8ToBytes,
  verifyOp,
  type DraftCompletionContext,
  type JcsInputErrorCode,
  type JsonValue,
  type OpDraft,
} from '@bolusi/core';
import { GENESIS_PREVIOUS_HASH, type SignedOperation } from '@bolusi/schemas';
import { describe, expect, it } from 'vitest';

import { makeFixture, type Fixture } from './_fixtures.js';

/** A completion context bound to `f`, with a fresh op id and sane chain defaults. */
function ctxFor(f: Fixture, over?: Partial<DraftCompletionContext>): DraftCompletionContext {
  return {
    id: f.newId(),
    tenantId: f.tenantId,
    storeId: f.storeId,
    userId: f.userId,
    deviceId: f.deviceId,
    seq: 5,
    previousHash: 'a'.repeat(64),
    timestamp: 1_726_000_000_555,
    location: null,
    ...over,
  };
}

function coreOf(op: SignedOperation): Record<string, unknown> {
  const core: Record<string, unknown> = { ...op };
  delete core['hash'];
  delete core['signature'];
  return core;
}

describe('completeDraft — field completion', () => {
  it('fills every §2.1 field from the draft and the runtime context', () => {
    const f = makeFixture(11);
    const ctx = ctxFor(f);
    const draft: OpDraft = {
      type: 'notes.note_created',
      entityType: 'note',
      entityId: f.newId(),
      schemaVersion: 1,
      payload: { title: 'x', body: 'y' },
    };
    const { op } = completeDraft(draft, ctx, f.secretKey, f.crypto);
    expect(op.id).toBe(ctx.id);
    expect(op.tenantId).toBe(ctx.tenantId);
    expect(op.userId).toBe(ctx.userId);
    expect(op.deviceId).toBe(ctx.deviceId);
    expect(op.seq).toBe(5);
    expect(op.previousHash).toBe('a'.repeat(64));
    expect(op.timestamp).toBe(1_726_000_000_555);
    expect(op.type).toBe('notes.note_created');
    expect(op.entityId).toBe(draft.entityId);
    expect(op.payload).toEqual({ title: 'x', body: 'y' });
  });

  it('applies the spec defaults source="ui", agentInitiated=false, agentConversationId=null', () => {
    const f = makeFixture(12);
    const { op } = completeDraft(f.noteDraft(), ctxFor(f), f.secretKey, f.crypto);
    expect(op.source).toBe('ui');
    expect(op.agentInitiated).toBe(false);
    expect(op.agentConversationId).toBeNull();
  });

  it('honours explicit draft overrides for source/agent fields', () => {
    const f = makeFixture(13);
    const draft = f.noteDraft({
      source: 'agent',
      agentInitiated: true,
      agentConversationId: 'conv-1',
    });
    const { op } = completeDraft(draft, ctxFor(f), f.secretKey, f.crypto);
    expect(op.source).toBe('agent');
    expect(op.agentInitiated).toBe(true);
    expect(op.agentConversationId).toBe('conv-1');
  });
});

describe('completeDraft — hash, signature, verbatim JCS', () => {
  it('hash === SHA-256(JCS(core)) recomputed independently, and the signature verifies', () => {
    const f = makeFixture(14);
    const { op } = completeDraft(f.noteDraft(), ctxFor(f), f.secretKey, f.crypto);

    // Independent oracle: canonicalize the core ourselves and hash the raw bytes (T-13).
    const independentJcs = canonicalizeJcs(coreOf(op) as JsonValue);
    const independentHash = bytesToHex(f.crypto.sha256(utf8ToBytes(independentJcs)));
    expect(op.hash).toBe(independentHash);
    expect(verifyOp(op, f.publicKey, f.crypto)).toBe(true);
  });

  it('returns the verbatim JCS text, which is a parse∘canonicalize fixpoint (10-db §2.1)', () => {
    const f = makeFixture(15);
    const { op, jcs } = completeDraft(f.noteDraft(), ctxFor(f), f.secretKey, f.crypto);
    expect(jcs).toBe(canonicalizeJcs(coreOf(op) as JsonValue));
    expect(canonicalizeJcs(JSON.parse(jcs) as JsonValue)).toBe(jcs);
  });
});

describe('completeDraft — non-JSON guard (rejects the whole class before canonicalization)', () => {
  const badPayloads: ReadonlyArray<readonly [string, Record<string, unknown>, JcsInputErrorCode]> =
    [
      ['undefined', { title: 'ok', bad: undefined }, 'UNDEFINED_VALUE'],
      ['NaN', { bad: Number.NaN }, 'NON_FINITE_NUMBER'],
      ['Infinity', { bad: Number.POSITIVE_INFINITY }, 'NON_FINITE_NUMBER'],
      ['-Infinity', { bad: Number.NEGATIVE_INFINITY }, 'NON_FINITE_NUMBER'],
      ['BigInt', { bad: 10n }, 'BIGINT_VALUE'],
      ['symbol', { bad: Symbol('x') }, 'SYMBOL_VALUE'],
      ['function', { bad: () => 1 }, 'FUNCTION_VALUE'],
      ['Map', { bad: new Map([['a', 1]]) }, 'NON_PLAIN_OBJECT'],
      ['Set', { bad: new Set([1]) }, 'NON_PLAIN_OBJECT'],
      ['Date', { bad: new Date(0) }, 'NON_PLAIN_OBJECT'],
      ['nested undefined', { items: [{ qty: undefined }] }, 'UNDEFINED_VALUE'],
    ];

  it('ACCEPTS a valid control payload (fixture assertion before believing the rejections, T-14b)', () => {
    const f = makeFixture(16);
    expect(() =>
      completeDraft(
        {
          type: 'notes.note_created',
          entityType: 'note',
          entityId: f.newId(),
          schemaVersion: 1,
          payload: { title: 'ok', body: 'ok' },
        },
        ctxFor(f),
        f.secretKey,
        f.crypto,
      ),
    ).not.toThrow();
  });

  it.each(badPayloads)('rejects %s with JcsInputError before hashing', (_name, payload, code) => {
    const f = makeFixture(17);
    let thrown: unknown;
    try {
      completeDraft(
        {
          type: 'notes.note_created',
          entityType: 'note',
          entityId: f.newId(),
          schemaVersion: 1,
          payload,
        },
        ctxFor(f),
        f.secretKey,
        f.crypto,
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(JcsInputError);
    expect((thrown as JcsInputError).code).toBe(code);
  });

  it('covers every payload-reachable JcsInputErrorCode (denominator guard, T-14)', () => {
    const covered = new Set(badPayloads.map(([, , code]) => code));
    expect([...covered].sort()).toEqual(
      [
        'BIGINT_VALUE',
        'FUNCTION_VALUE',
        'NON_FINITE_NUMBER',
        'NON_PLAIN_OBJECT',
        'SYMBOL_VALUE',
        'UNDEFINED_VALUE',
      ].sort(),
    );
  });
});

describe('completeDraft — absent-vs-null on the produced bytes (05 §3)', () => {
  it('emits nullable core fields as explicit null when unset', () => {
    const f = makeFixture(18);
    const { jcs } = completeDraft(
      f.noteDraft(),
      ctxFor(f, { storeId: null, location: null }),
      f.secretKey,
      f.crypto,
    );
    const parsed = JSON.parse(jcs) as Record<string, unknown>;
    expect('storeId' in parsed).toBe(true);
    expect(parsed['storeId']).toBeNull();
    expect('location' in parsed).toBe(true);
    expect(parsed['location']).toBeNull();
    expect('agentConversationId' in parsed).toBe(true);
    expect(parsed['agentConversationId']).toBeNull();
  });

  it('round-trips a provided location fix through the signed bytes', () => {
    const f = makeFixture(19);
    const { jcs } = completeDraft(
      f.noteDraft(),
      ctxFor(f, { location: { lat: -6.2, lng: 106.8, accuracyMeters: 12.5 } }),
      f.secretKey,
      f.crypto,
    );
    const parsed = JSON.parse(jcs) as {
      location: { lat: number; lng: number; accuracyMeters: number };
    };
    expect(parsed.location).toEqual({ lat: -6.2, lng: 106.8, accuracyMeters: 12.5 });
  });

  it('genesis op completes with the 64-zero previousHash and entityId = deviceId (05 §9.5)', () => {
    const f = makeFixture(20);
    const { op } = completeDraft(
      f.genesisDraft(),
      ctxFor(f, { seq: 1, previousHash: GENESIS_PREVIOUS_HASH }),
      f.secretKey,
      f.crypto,
    );
    expect(op.seq).toBe(1);
    expect(op.previousHash).toBe(GENESIS_PREVIOUS_HASH);
    expect(op.entityId).toBe(f.deviceId);
    expect(verifyOp(op, f.publicKey, f.crypto)).toBe(true);
  });
});
