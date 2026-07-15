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
