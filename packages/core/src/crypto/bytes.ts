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
