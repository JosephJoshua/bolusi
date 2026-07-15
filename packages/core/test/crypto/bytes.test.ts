// Byte codecs (core is platform-free: no node:buffer, no guaranteed btoa on Hermes).
//
// These back the envelope's `hash` (hex) and `signature` (base64) fields, so a lenient
// decoder is a security bug: if two different texts decode to the same bytes, a
// signature becomes malleable — re-encodable and still valid.
import { base64ToBytes, bytesToBase64, bytesToHex, hexToBytes, utf8ToBytes } from '@bolusi/core';
import { describe, expect, it } from 'vitest';

describe('hex', () => {
  it('round-trips every byte value', () => {
    const all = new Uint8Array(256).map((_, index) => index);
    expect(hexToBytes(bytesToHex(all))).toEqual(all);
  });

  it('emits lowercase, zero-padded hex', () => {
    expect(bytesToHex(new Uint8Array([0, 1, 15, 16, 255]))).toBe('00010f10ff');
  });

  it('encodes the empty array as the empty string', () => {
    expect(bytesToHex(new Uint8Array(0))).toBe('');
    expect(hexToBytes('')).toEqual(new Uint8Array(0));
  });

  it('accepts uppercase input', () => {
    expect(hexToBytes('DEADBEEF')).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });

  it.each(['abc', 'a'])('rejects odd-length input %s', (input) => {
    expect(() => hexToBytes(input)).toThrow(RangeError);
  });

  it.each(['zz', '0x', 'g0', ' 1', '1 ', '+1', '-1'])('rejects non-hex input %s', (input) => {
    // parseInt would happily accept several of these ('0x' -> NaN, ' 1' -> 1).
    expect(() => hexToBytes(input)).toThrow(RangeError);
  });
});

describe('base64', () => {
  it('round-trips every byte value', () => {
    const all = new Uint8Array(256).map((_, index) => index);
    expect(base64ToBytes(bytesToBase64(all))).toEqual(all);
  });

  it.each([
    ['', ''],
    ['f', 'Zg=='],
    ['fo', 'Zm8='],
    ['foo', 'Zm9v'],
    ['foob', 'Zm9vYg=='],
    ['fooba', 'Zm9vYmE='],
    ['foobar', 'Zm9vYmFy'],
  ])('matches the RFC 4648 §10 vector for %s', (input, expected) => {
    expect(bytesToBase64(utf8ToBytes(input))).toBe(expected);
    expect(base64ToBytes(expected)).toEqual(utf8ToBytes(input));
  });

  it('round-trips a 64-byte signature-sized buffer', () => {
    const signature = new Uint8Array(64).map((_, index) => (index * 7) % 256);
    const encoded = bytesToBase64(signature);
    expect(encoded).toHaveLength(88);
    expect(base64ToBytes(encoded)).toEqual(signature);
  });

  it.each(['A', 'AB', 'ABC', 'Zm9vYmFy='])('rejects bad length %s', (input) => {
    expect(() => base64ToBytes(input)).toThrow(RangeError);
  });

  it.each(['A!==', 'Zm 9v', 'Zm9v Ymfy', '****'])('rejects non-alphabet input %s', (input) => {
    expect(() => base64ToBytes(input)).toThrow(RangeError);
  });

  it.each(['=AAA', 'A=AA', 'AA=A'])('rejects misplaced padding %s', (input) => {
    expect(() => base64ToBytes(input)).toThrow(RangeError);
  });

  it('rejects non-canonical encodings whose unused tail bits are set', () => {
    // 'Zg==' and 'Zh==' both decode to [0x66] under a lenient decoder — two texts, one
    // byte string, i.e. a malleable signature. Only the canonical form is accepted.
    expect(base64ToBytes('Zg==')).toEqual(new Uint8Array([0x66]));
    expect(() => base64ToBytes('Zh==')).toThrow(RangeError);
    expect(() => base64ToBytes('Zm9=')).toThrow(RangeError);
  });
});

// CLASS tests, not instance tests. The cases above pin encodings someone reasoned about;
// these enumerate the ENTIRE malleability space of the two base64 fields the envelope
// actually carries (05 §2.2) and assert it collapses to exactly one accepted string.
//
// Two distinct malleability classes exist, and fixing one leaves the other:
//   position — '=' somewhere other than a suffix ('AA=A', '=AAA')
//   pad bits — the final significant char's UNUSED low bits set ('Zh==' vs 'Zg==')
// Instance tests would let a future third class (or a regression in one prong) through.
//
// NOTE ON THE ORACLE: this suite never uses `Buffer.from(s, 'base64')` as the reference
// for "valid base64" — it is uselessly lenient and would accept every string below
// ('AA=A' -> 00, 'A A=' -> 00, '≡A==' -> 68). A decoder cannot be its own spec; the
// oracle here is the RFC 4648 alphabet and arithmetic, computed in the test.
describe('base64 canonical-form uniqueness (RFC 4648 §3.5)', () => {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  /** Every string that shares `canonical`'s significant bits but varies the unused ones. */
  function padBitVariants(canonical: string, padLength: 1 | 2): string[] {
    const lastIndex = canonical.length - padLength - 1;
    const lastValue = ALPHABET.indexOf(canonical[lastIndex] as string);
    const significantBits = padLength === 2 ? 2 : 4;
    const shift = 6 - significantBits;
    const stem = canonical.slice(0, lastIndex);
    const suffix = '='.repeat(padLength);

    const variants: string[] = [];
    for (let value = 0; value < 64; value += 1) {
      // Same significant high bits, every combination of the unused low bits.
      if (value >>> shift === lastValue >>> shift) {
        variants.push(stem + ALPHABET[value] + suffix);
      }
    }
    return variants;
  }

  it('accepts exactly one of the 16 pad-bit variants of a 64-byte signature', () => {
    // 64 = 3*21 + 1 -> final group is 2 chars + '==', whose last char carries 2
    // significant bits and 4 unused ones -> 2^4 = 16 strings for one signature.
    const signature = new Uint8Array(64).map((_, index) => (index * 37 + 11) % 256);
    const canonical = bytesToBase64(signature);
    expect(canonical).toHaveLength(88);
    expect(canonical.endsWith('==')).toBe(true);

    const variants = padBitVariants(canonical, 2);
    expect(variants).toHaveLength(16);
    expect(variants).toContain(canonical);

    const accepted = variants.filter((variant) => {
      try {
        base64ToBytes(variant);
        return true;
      } catch {
        return false;
      }
    });

    expect(accepted).toEqual([canonical]);
    expect(base64ToBytes(canonical)).toEqual(signature);
  });

  it('accepts exactly one of the 4 pad-bit variants of a 32-byte public key', () => {
    // 32 = 3*10 + 2 -> final group is 3 chars + '=', last char has 4 significant bits
    // and 2 unused -> 2^2 = 4 strings for one key.
    const publicKey = new Uint8Array(32).map((_, index) => (index * 53 + 7) % 256);
    const canonical = bytesToBase64(publicKey);
    expect(canonical).toHaveLength(44);
    expect(canonical.endsWith('=')).toBe(true);
    expect(canonical.endsWith('==')).toBe(false);

    const variants = padBitVariants(canonical, 1);
    expect(variants).toHaveLength(4);
    expect(variants).toContain(canonical);

    const accepted = variants.filter((variant) => {
      try {
        base64ToBytes(variant);
        return true;
      } catch {
        return false;
      }
    });

    expect(accepted).toEqual([canonical]);
    expect(base64ToBytes(canonical)).toEqual(publicKey);
  });

  it('accepts only the three legal padding positions across the whole 4-char group space', () => {
    // Exhaustive over the position class: all 2^4 strings of 'A' and '=' in one group.
    // 'A' is value 0, so its unused tail bits are always zero — this isolates PADDING
    // POSITION from the pad-BITS class above. Exactly three are legal RFC 4648 groups:
    //   AAAA -> 3 bytes, AAA= -> 2 bytes, AA== -> 1 byte.
    // The other 13 (interior '=', leading '=', '=' followed by data, over-padding) must
    // all be rejected. Enumerating the space means a new positional variant cannot slip
    // through by nobody having thought to write it down.
    const legal = new Map<string, number[]>([
      ['AAAA', [0, 0, 0]],
      ['AAA=', [0, 0]],
      ['AA==', [0]],
    ]);

    const space: string[] = [];
    for (let mask = 0; mask < 16; mask += 1) {
      let group = '';
      for (let bit = 3; bit >= 0; bit -= 1) group += (mask >> bit) & 1 ? '=' : 'A';
      space.push(group);
    }
    expect(space).toHaveLength(16);

    for (const group of space) {
      const expected = legal.get(group);
      if (expected) {
        expect([...base64ToBytes(group)], `${group} is a legal group`).toEqual(expected);
      } else {
        expect(() => base64ToBytes(group), `${group} must be rejected`).toThrow(RangeError);
      }
    }
  });
});

describe('utf8ToBytes', () => {
  it.each([
    ['ascii', 'abc', [0x61, 0x62, 0x63]],
    ['2-byte', 'ö', [0xc3, 0xb6]],
    ['3-byte', '€', [0xe2, 0x82, 0xac]],
    ['4-byte (surrogate pair)', '\u{1f600}', [0xf0, 0x9f, 0x98, 0x80]],
  ])('encodes %s correctly', (_label, input, expected) => {
    expect([...utf8ToBytes(input)]).toEqual(expected);
  });

  it('encodes the empty string as no bytes', () => {
    expect(utf8ToBytes('')).toEqual(new Uint8Array(0));
  });

  it('matches the RFC 8785 §3.2.4 euro-sign bytes', () => {
    expect([...utf8ToBytes('€$')]).toEqual([0xe2, 0x82, 0xac, 0x24]);
  });
});
