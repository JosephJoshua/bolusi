// hash / sign / verify for the signed core (05-operation-log §2.1–2.2, §3).
//
// Security surface (CLAUDE.md §2.5): the adversarial cases — byte-flips in the hash,
// signature and pubkey, post-hash payload mutation, cross-key substitution — ship HERE,
// with the implementation, not as a review afterthought. The chain/server-side rejection
// codes they feed (SEC-OPLOG-03/04/05) belong to tasks 06/07.
import {
  bytesToBase64,
  bytesToHex,
  hashSignedCore,
  hexToBytes,
  signOp,
  utf8ToBytes,
  verifyOp,
  type CryptoPort,
} from '@bolusi/core';
import type { SignedCore, SignedOperation } from '@bolusi/schemas';
import { ed25519Vectors, noblePort } from '@bolusi/test-support';
import { describe, expect, it } from 'vitest';

const crypto: CryptoPort = noblePort;

/** RFC 8032 TEST 1's seed — a published test key, never a production key. */
const seed = hexToBytes(ed25519Vectors[0]!.seedHex);
const publicKey = hexToBytes(ed25519Vectors[0]!.publicKeyHex);

/** A fixed, valid signed core. Each test derives its own variant from this. */
function makeCore(overrides: Partial<SignedCore> = {}): SignedCore {
  return {
    id: '018f3a5c-1c00-7000-8000-000000000001',
    tenantId: '11111111-1111-4111-8111-111111111111',
    storeId: '22222222-2222-4222-8222-222222222222',
    userId: '33333333-3333-4333-8333-333333333333',
    deviceId: '44444444-4444-4444-8444-444444444444',
    seq: 1,
    type: 'notes.note_created',
    entityType: 'note',
    entityId: '018f3a5c-1c00-7000-8000-000000000002',
    schemaVersion: 1,
    payload: { title: 'Catatan', priceIdr: 12500 },
    timestamp: 1_700_000_000_000,
    location: null,
    source: 'ui',
    agentInitiated: false,
    agentConversationId: null,
    previousHash: '0'.repeat(64),
    ...overrides,
  };
}

/** Flip one bit of the byte at `index`. */
function flipByte(bytes: Uint8Array, index: number): Uint8Array {
  const copy = Uint8Array.from(bytes);
  copy[index] = (copy[index] as number) ^ 0x01;
  return copy;
}

describe('hashSignedCore', () => {
  it('hashes exactly the §2.1 field set — the digest is SHA-256 over the JCS text', () => {
    const core = makeCore();
    const { jcs, hash, hashHex } = hashSignedCore(core, crypto);

    // Independently recompute rather than trusting the helper's own output.
    expect(hashHex).toBe(bytesToHex(crypto.sha256(utf8ToBytes(jcs))));
    expect(hash).toHaveLength(32);
    expect(hashHex).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns the JCS text with keys sorted and no bookkeeping fields', () => {
    const { jcs } = hashSignedCore(makeCore(), crypto);
    expect(jcs.startsWith('{"agentConversationId":null,"agentInitiated":false')).toBe(true);
    expect(jcs).not.toContain('syncStatus');
    expect(jcs).not.toContain('"hash"');
    expect(jcs).not.toContain('"signature"');
  });

  it('produces the recorded digest for a known envelope fixture', () => {
    // A pinned end-to-end tripwire over field set + key sorting + UTF-8 + SHA-256: a
    // behavioural drift in `canonicalize` or the hash pair moves this digest and fails
    // here (08 §2.1.5 asks for exactly this tripwire).
    //
    // The expected digest was verified INDEPENDENTLY of our stack — Python's hashlib
    // over the JCS text below reproduces it byte-for-byte — so this asserts more than
    // "the code agrees with itself".
    const { jcs, hashHex } = hashSignedCore(makeCore(), crypto);

    expect(jcs).toBe(
      '{"agentConversationId":null,"agentInitiated":false,' +
        '"deviceId":"44444444-4444-4444-8444-444444444444",' +
        '"entityId":"018f3a5c-1c00-7000-8000-000000000002","entityType":"note",' +
        '"id":"018f3a5c-1c00-7000-8000-000000000001","location":null,' +
        '"payload":{"priceIdr":12500,"title":"Catatan"},' +
        '"previousHash":"0000000000000000000000000000000000000000000000000000000000000000",' +
        '"schemaVersion":1,"seq":1,"source":"ui",' +
        '"storeId":"22222222-2222-4222-8222-222222222222",' +
        '"tenantId":"11111111-1111-4111-8111-111111111111",' +
        '"timestamp":1700000000000,"type":"notes.note_created",' +
        '"userId":"33333333-3333-4333-8333-333333333333"}',
    );
    expect(hashHex).toBe('c990dbf2905c97b91f4dc1df28b1a06e87d47dd022e8e3eddea8a19410bd58ad');
  });

  it('rejects a core carrying the derived `hash` key', () => {
    const withHash = { ...makeCore(), hash: 'a'.repeat(64) } as unknown as SignedCore;
    expect(() => hashSignedCore(withHash, crypto)).toThrow();
  });

  it('rejects a core carrying the derived `signature` key', () => {
    const withSignature = { ...makeCore(), signature: 'AAAA' } as unknown as SignedCore;
    expect(() => hashSignedCore(withSignature, crypto)).toThrow();
  });

  it.each([
    'syncStatus',
    'syncedAt',
    'rejectionCode',
    'serverSeq',
    'receivedAt',
    'clockSkewFlagged',
  ])('rejects a core carrying the bookkeeping key %s (§2.3/§2.4 are never signed)', (key) => {
    const polluted = { ...makeCore(), [key]: 'x' } as unknown as SignedCore;
    expect(() => hashSignedCore(polluted, crypto)).toThrow();
  });

  it('rejects a core with an omitted nullable key (05 §3 absent-vs-null)', () => {
    const core = makeCore();
    delete (core as Partial<SignedCore>).storeId;
    expect(() => hashSignedCore(core, crypto)).toThrow();
  });

  it('rejects an undefined inside the payload rather than dropping it', () => {
    const core = makeCore({ payload: { title: 'x', note: undefined } });
    expect(() => hashSignedCore(core, crypto)).toThrow(/UNDEFINED_VALUE/);
  });

  it('gives explicit-null and omitted-key cores different digests', () => {
    // If `undefined` were silently dropped, these two would collide — the exact
    // absent-vs-null failure 05 §3 forbids.
    const withNull = hashSignedCore(makeCore({ storeId: null }), crypto);
    const withValue = hashSignedCore(
      makeCore({ storeId: '22222222-2222-4222-8222-222222222222' }),
      crypto,
    );
    expect(withNull.hashHex).not.toBe(withValue.hashHex);
  });

  it('changes the digest when any single core field changes', () => {
    const baseline = hashSignedCore(makeCore(), crypto).hashHex;
    expect(hashSignedCore(makeCore({ seq: 2 }), crypto).hashHex).not.toBe(baseline);
    expect(hashSignedCore(makeCore({ timestamp: 1_700_000_000_001 }), crypto).hashHex).not.toBe(
      baseline,
    );
    expect(
      hashSignedCore(makeCore({ payload: { title: 'Catatan', priceIdr: 12501 } }), crypto).hashHex,
    ).not.toBe(baseline);
  });
});

describe('signOp', () => {
  it('signs the RAW 32-byte digest, not its hex string', () => {
    // The single most consequential detail of §2.2: the device lane (quick-crypto) and
    // the server (noble) must sign identical bytes. Signing `hashHex` would produce a
    // valid-looking signature over a DIFFERENT 64-byte message.
    const core = makeCore();
    const { hash } = hashSignedCore(core, crypto);

    const captured: Uint8Array[] = [];
    const spyPort: CryptoPort = {
      ...crypto,
      sign(message, secretKey) {
        captured.push(Uint8Array.from(message));
        return crypto.sign(message, secretKey);
      },
    };

    signOp(core, seed, spyPort);

    expect(captured).toHaveLength(1);
    expect(captured[0]).toHaveLength(32);
    expect(captured[0]).toEqual(hash);
    // Explicitly not the 64-byte hex rendering.
    expect(captured[0]).not.toEqual(utf8ToBytes(bytesToHex(hash)));
  });

  it('returns the core plus the derived hash and signature', () => {
    const core = makeCore();
    const op = signOp(core, seed, crypto);

    expect(op.hash).toBe(hashSignedCore(core, crypto).hashHex);
    expect(op.signature).toMatch(/^[A-Za-z0-9+/]+=*$/);
    // Ed25519 signatures are 64 bytes -> 88 base64 chars with padding.
    expect(op.signature).toHaveLength(88);
    expect(op.id).toBe(core.id);
  });

  it('is deterministic — Ed25519 signing has no randomness', () => {
    expect(signOp(makeCore(), seed, crypto).signature).toBe(
      signOp(makeCore(), seed, crypto).signature,
    );
  });
});

describe('verifyOp', () => {
  it('round-trips signOp -> verifyOp', () => {
    expect(verifyOp(signOp(makeCore(), seed, crypto), publicKey, crypto)).toBe(true);
  });

  it('returns false when any single byte of the signature is flipped', () => {
    const op = signOp(makeCore(), seed, crypto);
    // Take the raw signature straight from the port rather than decoding op.signature —
    // the decoder is code under test, and a test must not depend on it to build its input.
    const signature = crypto.sign(hashSignedCore(makeCore(), crypto).hash, seed);

    for (let index = 0; index < signature.length; index += 1) {
      const tampered: SignedOperation = {
        ...op,
        signature: bytesToBase64(flipByte(signature, index)),
      };
      expect(verifyOp(tampered, publicKey, crypto)).toBe(false);
    }
  });

  it('returns false when any single byte of the public key is flipped', () => {
    const op = signOp(makeCore(), seed, crypto);
    for (let index = 0; index < publicKey.length; index += 1) {
      expect(verifyOp(op, flipByte(publicKey, index), crypto)).toBe(false);
    }
  });

  it('returns false when any single byte of the claimed hash is flipped', () => {
    const op = signOp(makeCore(), seed, crypto);
    const hashBytes = hexToBytes(op.hash);
    for (let index = 0; index < hashBytes.length; index += 1) {
      const tampered: SignedOperation = { ...op, hash: bytesToHex(flipByte(hashBytes, index)) };
      expect(verifyOp(tampered, publicKey, crypto)).toBe(false);
    }
  });

  it('returns false when the payload is mutated after signing', () => {
    // The op keeps its original hash+signature; only the payload moved. Recomputing the
    // hash is what catches this — checking the signature against the CLAIMED hash would not.
    const op = signOp(makeCore(), seed, crypto);
    const mutated: SignedOperation = { ...op, payload: { title: 'Catatan', priceIdr: 999 } };
    expect(verifyOp(mutated, publicKey, crypto)).toBe(false);
  });

  it('returns false when a non-payload core field is mutated after signing', () => {
    const op = signOp(makeCore(), seed, crypto);
    const mutated: SignedOperation = { ...op, userId: '99999999-9999-4999-8999-999999999999' };
    expect(verifyOp(mutated, publicKey, crypto)).toBe(false);
  });

  it('returns false when both the payload AND the hash are rewritten to match', () => {
    // A tamperer who recomputes the hash still cannot produce a signature over it.
    const mutatedCore = makeCore({ payload: { title: 'Catatan', priceIdr: 999 } });
    const op = signOp(makeCore(), seed, crypto);
    const forged: SignedOperation = {
      ...op,
      ...mutatedCore,
      hash: hashSignedCore(mutatedCore, crypto).hashHex,
    };
    expect(verifyOp(forged, publicKey, crypto)).toBe(false);
  });

  it('returns false for a signature made by a different device key', () => {
    const otherSeed = hexToBytes(ed25519Vectors[1]!.seedHex);
    const op = signOp(makeCore(), otherSeed, crypto);
    expect(verifyOp(op, publicKey, crypto)).toBe(false);
  });

  it('returns false — never throws — for a malformed signature encoding', () => {
    const op = signOp(makeCore(), seed, crypto);
    for (const signature of ['', 'not base64!!', 'AAA', 'A'.repeat(87)]) {
      expect(verifyOp({ ...op, signature }, publicKey, crypto)).toBe(false);
    }
  });

  it('returns false — never throws — for a structurally invalid op', () => {
    // This runs against server-supplied data on the pull path (api/01 §4.2): an
    // exception here would be a denial-of-service lever, not a verification result.
    const op = signOp(makeCore(), seed, crypto);
    expect(verifyOp({ ...op, seq: -1 } as SignedOperation, publicKey, crypto)).toBe(false);
    expect(verifyOp({ ...op, timestamp: Number.NaN } as SignedOperation, publicKey, crypto)).toBe(
      false,
    );
  });

  it('returns false for a wrong-length public key', () => {
    expect(verifyOp(signOp(makeCore(), seed, crypto), new Uint8Array(31), crypto)).toBe(false);
  });
});
