// Byte <-> text codecs. Pure TS on purpose: core is platform-free (08 §3.3 rule 3), so
// `node:buffer` is unavailable, and Hermes guarantees neither `btoa` nor `atob`.
//
// The envelope stores `hash` as hex and `signature` as base64 (05 §2.2), but everything
// crypto-facing works in raw bytes — these are the only two places the conversion happens.

const HEX_DIGITS = '0123456789abcdef';
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** The alphabet as character codes, and `=`, for building output without per-character strings. */
const BASE64_CODES = /* @__PURE__ */ Uint8Array.from(BASE64_ALPHABET, (char) => char.charCodeAt(0));
const PAD_CODE = 0x3d;

/**
 * Code units per `String.fromCharCode.apply` call, far below every engine's argument limit. Building a
 * string a character at a time costs about 100 ns per character on Hermes, which a sealed op log
 * cell pays thousands of times per op; one native call per chunk does not.
 */
const STRING_CHUNK = 4096;

/** The string of the first `length` UTF-16 code units in `units`. */
function stringFromCodeUnits(units: Uint8Array | Uint16Array, length: number): string {
  let out = '';
  for (let start = 0; start < length; start += STRING_CHUNK) {
    const chunk = units.subarray(start, Math.min(start + STRING_CHUNK, length));
    out += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return out;
}

/** Reverse lookup, built once. -1 = not a base64 digit. */
const BASE64_LOOKUP = /* @__PURE__ */ (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < BASE64_ALPHABET.length; i += 1) {
    table[BASE64_ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

/** Lowercase hex. Lowercase is normative: `zSha256Hex` accepts nothing else. */
export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += HEX_DIGITS[byte >>> 4];
    out += HEX_DIGITS[byte & 0x0f];
  }
  return out;
}

/**
 * Parse lowercase-or-uppercase hex.
 *
 * @throws {RangeError} on odd length or a non-hex character — a malformed hash must
 * never silently become a different byte string.
 */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new RangeError(`hex string has odd length: ${hex.length}`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    // parseInt is far too tolerant ('0x', '1z', ' 1') — re-validate explicitly.
    if (!Number.isInteger(byte) || !/^[0-9a-fA-F]{2}$/.test(hex.slice(i * 2, i * 2 + 2))) {
      throw new RangeError(`invalid hex at offset ${i * 2}`);
    }
    out[i] = byte;
  }
  return out;
}

/** Standard base64 with padding (RFC 4648 §4) — the `signature` encoding of 05 §2.2. */
export function bytesToBase64(bytes: Uint8Array): string {
  const out = new Uint8Array(Math.ceil(bytes.length / 3) * 4);
  let n = 0;
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];

    out[n++] = BASE64_CODES[b0 >>> 2] as number;
    out[n++] = BASE64_CODES[((b0 & 0x03) << 4) | ((b1 ?? 0) >>> 4)] as number;
    out[n++] =
      b1 === undefined
        ? PAD_CODE
        : (BASE64_CODES[((b1 & 0x0f) << 2) | ((b2 ?? 0) >>> 6)] as number);
    out[n++] = b2 === undefined ? PAD_CODE : (BASE64_CODES[b2 & 0x3f] as number);
  }
  return stringFromCodeUnits(out, n);
}

/** The 6-bit value of the base64 digit at `index`, 0 for `=`; throws on anything else. */
function base64DigitAt(base64: string, index: number): number {
  const char = base64.charCodeAt(index);
  if (char === PAD_CODE) return 0;
  const value = char < 128 ? (BASE64_LOOKUP[char] as number) : -1;
  if (value < 0) {
    throw new RangeError(`invalid base64 character at offset ${index}`);
  }
  return value;
}

/**
 * Whether `base64ToBytes` would accept `base64`, answered without decoding it: a cheap check for a
 * caller that only needs to know (the column cipher asks it of every value every query reads).
 */
export function isCanonicalBase64(base64: string): boolean {
  if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) return false;
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  if (padding === 0) return true;
  const tailValue = BASE64_LOOKUP[base64.charCodeAt(base64.length - padding - 1)] as number;
  return (tailValue & (padding === 1 ? 0x03 : 0x0f)) === 0;
}

/**
 * Parse standard padded base64.
 *
 * Strict by design — length, alphabet, padding placement and non-zero tail bits are all
 * errors. Lenient base64 parsing makes signatures malleable: several distinct texts
 * would decode to the same bytes, so a signature could be re-encoded and still verify.
 *
 * @throws {RangeError} on anything that is not exactly one canonical encoding.
 */
export function base64ToBytes(base64: string): Uint8Array {
  if (base64.length % 4 !== 0) {
    throw new RangeError(`base64 length must be a multiple of 4: ${base64.length}`);
  }
  if (base64.length === 0) return new Uint8Array(0);

  // Padding is legal ONLY as a 1- or 2-character suffix of the whole string. Anything
  // else ('AA=A', '=AAA', 'A=AA') is rejected: accepting interior padding would let two
  // different texts decode to the same bytes.
  const firstPad = base64.indexOf('=');
  if (firstPad !== -1) {
    const padding = base64.length - firstPad;
    if (padding > 2 || !/^=+$/.test(base64.slice(firstPad))) {
      throw new RangeError(`misplaced '=' padding at offset ${firstPad}`);
    }
  }
  const padding = firstPad === -1 ? 0 : base64.length - firstPad;

  const out = new Uint8Array((base64.length / 4) * 3 - padding);
  let outIndex = 0;

  for (let i = 0; i < base64.length; i += 4) {
    const triple =
      (base64DigitAt(base64, i) << 18) |
      (base64DigitAt(base64, i + 1) << 12) |
      (base64DigitAt(base64, i + 2) << 6) |
      base64DigitAt(base64, i + 3);

    if (outIndex < out.length) out[outIndex++] = (triple >>> 16) & 0xff;
    if (outIndex < out.length) out[outIndex++] = (triple >>> 8) & 0xff;
    if (outIndex < out.length) out[outIndex++] = triple & 0xff;
  }

  // Reject non-canonical encodings whose discarded tail bits are not zero.
  if (padding > 0) {
    const lastChars = base64.slice(-4);
    const tailIndex = 4 - padding - 1;
    const tailValue = BASE64_LOOKUP[lastChars.charCodeAt(tailIndex)] as number;
    const unusedBits = padding === 1 ? 0x03 : 0x0f;
    if ((tailValue & unusedBits) !== 0) {
      throw new RangeError('non-canonical base64: unused tail bits must be zero');
    }
  }

  return out;
}

/**
 * UTF-8 decode without `TextDecoder` (not guaranteed on Hermes) — the inverse of `utf8ToBytes`.
 *
 * STRICT, and for the same reason `base64ToBytes` is: the lenient behaviour every platform decoder
 * ships — substitute U+FFFD and carry on — turns "these bytes are not valid UTF-8" into "here is a
 * string", so a caller cannot tell a corrupted input from a real one. The query cursor codec
 * (query/cursor.ts) decodes caller-supplied bytes through this, and a cursor that silently decoded
 * to replacement characters would parse as JSON-garbage rather than as the typed rejection 04 §6
 * requires. Overlong encodings, surrogates encoded as 3-byte sequences (CESU-8), truncated
 * sequences and out-of-range code points are all errors.
 *
 * @throws {RangeError} on anything that is not exactly one canonical UTF-8 encoding.
 */
export function bytesToUtf8(bytes: Uint8Array): string {
  // ASCII (most signed op text) is its own UTF-16: convert the bytes directly, without a copy.
  let i = 0;
  while (i < bytes.length && (bytes[i] as number) < 0x80) i += 1;
  if (i === bytes.length) return stringFromCodeUnits(bytes, bytes.length);

  // UTF-16 never needs more code units than UTF-8 needs bytes for the same text.
  const units = new Uint16Array(bytes.length);
  units.set(bytes.subarray(0, i));
  let n = i;

  while (i < bytes.length) {
    const b0 = bytes[i] as number;
    if (b0 < 0x80) {
      units[n++] = b0;
      i += 1;
      continue;
    }
    let codePoint: number;
    let width: number;

    if ((b0 & 0xe0) === 0xc0) {
      codePoint = b0 & 0x1f;
      width = 2;
    } else if ((b0 & 0xf0) === 0xe0) {
      codePoint = b0 & 0x0f;
      width = 3;
    } else if ((b0 & 0xf8) === 0xf0) {
      codePoint = b0 & 0x07;
      width = 4;
    } else {
      // A continuation byte in leading position, or an F8..FF byte that no UTF-8 encoding produces.
      throw new RangeError(`invalid UTF-8 leading byte 0x${b0.toString(16)} at offset ${i}`);
    }

    if (i + width > bytes.length) {
      throw new RangeError(`truncated UTF-8 sequence at offset ${i}`);
    }
    for (let j = 1; j < width; j += 1) {
      const cont = bytes[i + j] as number;
      if ((cont & 0xc0) !== 0x80) {
        throw new RangeError(`invalid UTF-8 continuation byte at offset ${i + j}`);
      }
      codePoint = (codePoint << 6) | (cont & 0x3f);
    }

    // Overlong: the shortest encoding of this code point is narrower than `width`. Overlongs are
    // the classic filter bypass — '/' encoded as 0xC0 0xAF passes a byte-wise check for 0x2F.
    const minimum = width === 1 ? 0 : width === 2 ? 0x80 : width === 3 ? 0x800 : 0x10000;
    if (codePoint < minimum) {
      throw new RangeError(`overlong UTF-8 encoding at offset ${i}`);
    }
    // Lone surrogates are not valid UTF-8 (they are a UTF-16 artifact); > U+10FFFF does not exist.
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
      throw new RangeError(
        `UTF-8 encodes a lone surrogate U+${codePoint.toString(16)} at offset ${i}`,
      );
    }
    if (codePoint > 0x10ffff) {
      throw new RangeError(`UTF-8 code point out of range at offset ${i}`);
    }

    // Back to UTF-16, re-splitting astral code points into a surrogate pair.
    if (codePoint < 0x10000) {
      units[n++] = codePoint;
    } else {
      const offset = codePoint - 0x10000;
      units[n++] = 0xd800 + (offset >> 10);
      units[n++] = 0xdc00 + (offset & 0x3ff);
    }
    i += width;
  }

  return stringFromCodeUnits(units, n);
}

/** Concatenate byte arrays without Buffer, which is unavailable on mobile Hermes. */
export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** UTF-8 encode without `TextEncoder` (not guaranteed on Hermes). Handles surrogate pairs. */
export function utf8ToBytes(text: string): Uint8Array {
  // One UTF-16 code unit encodes to at most 3 bytes (a surrogate pair: 4 bytes for 2 units).
  const out = new Uint8Array(text.length * 3);
  let n = 0;
  for (let i = 0; i < text.length; i += 1) {
    let codePoint = text.charCodeAt(i);

    if (codePoint >= 0xd800 && codePoint <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        codePoint = (codePoint - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
        i += 1;
      }
    }

    if (codePoint < 0x80) {
      out[n++] = codePoint;
    } else if (codePoint < 0x800) {
      out[n++] = 0xc0 | (codePoint >> 6);
      out[n++] = 0x80 | (codePoint & 0x3f);
    } else if (codePoint < 0x10000) {
      out[n++] = 0xe0 | (codePoint >> 12);
      out[n++] = 0x80 | ((codePoint >> 6) & 0x3f);
      out[n++] = 0x80 | (codePoint & 0x3f);
    } else {
      out[n++] = 0xf0 | (codePoint >> 18);
      out[n++] = 0x80 | ((codePoint >> 12) & 0x3f);
      out[n++] = 0x80 | ((codePoint >> 6) & 0x3f);
      out[n++] = 0x80 | (codePoint & 0x3f);
    }
  }
  return out.slice(0, n);
}
