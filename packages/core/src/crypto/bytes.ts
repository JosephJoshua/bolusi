// Byte <-> text codecs. Pure TS on purpose: core is platform-free (08 §3.3 rule 3), so
// `node:buffer` is unavailable, and Hermes guarantees neither `btoa` nor `atob`.
//
// The envelope stores `hash` as hex and `signature` as base64 (05 §2.2), but everything
// crypto-facing works in raw bytes — these are the only two places the conversion happens.

const HEX_DIGITS = '0123456789abcdef';
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

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
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];

    out += BASE64_ALPHABET[b0 >>> 2];
    out += BASE64_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >>> 4)];
    out += b1 === undefined ? '=' : BASE64_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >>> 6)];
    out += b2 === undefined ? '=' : BASE64_ALPHABET[b2 & 0x3f];
  }
  return out;
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
    const digits = [0, 0, 0, 0];
    for (let j = 0; j < 4; j += 1) {
      const char = base64.charCodeAt(i + j);
      if (base64[i + j] === '=') {
        digits[j] = 0;
        continue;
      }
      const value = char < 128 ? (BASE64_LOOKUP[char] as number) : -1;
      if (value < 0) {
        throw new RangeError(`invalid base64 character at offset ${i + j}`);
      }
      digits[j] = value;
    }

    const triple =
      ((digits[0] as number) << 18) |
      ((digits[1] as number) << 12) |
      ((digits[2] as number) << 6) |
      (digits[3] as number);

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
  let out = '';
  let i = 0;

  while (i < bytes.length) {
    const b0 = bytes[i] as number;
    let codePoint: number;
    let width: number;

    if (b0 < 0x80) {
      codePoint = b0;
      width = 1;
    } else if ((b0 & 0xe0) === 0xc0) {
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
      out += String.fromCharCode(codePoint);
    } else {
      const offset = codePoint - 0x10000;
      out += String.fromCharCode(0xd800 + (offset >> 10), 0xdc00 + (offset & 0x3ff));
    }
    i += width;
  }

  return out;
}

/** UTF-8 encode without `TextEncoder` (not guaranteed on Hermes). Handles surrogate pairs. */
export function utf8ToBytes(text: string): Uint8Array {
  const out: number[] = [];
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
      out.push(codePoint);
    } else if (codePoint < 0x800) {
      out.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint < 0x10000) {
      out.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      out.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return new Uint8Array(out);
}
