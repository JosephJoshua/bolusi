// A servisan's status link: the code printed on the slip (and sent on WhatsApp) that lets the
// customer follow the repair on the web without an account (product-scope.md, "Customers follow
// their repair online").
//
// The code is the only credential, so it is random, not derived from the servisan number or the
// customer's phone, which are easy to guess. It is made on the device at intake so it works
// offline, and the page shows it once the servisan has synced.
//
// Ten Crockford base32 characters: 50 random bits, no I, L, O or U, so a code typed from paper
// survives a misread 0/O or 1/I/L, and fits a small QR code in alphanumeric mode.

/** Crockford's base32 alphabet. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const STATUS_CODE_LENGTH = 10;

/** A code as stored and as the link carries it. */
export const STATUS_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{10}$/;

/** The path of the customer's page, under the site that serves it. */
export const STATUS_PATH_PREFIX = '/c/';

/** Bytes to draw a code from: 7 bytes give 56 bits, of which 50 are used. */
export const STATUS_CODE_BYTES = 7;

/** A code from CSPRNG bytes (`ctx.randomBytes(STATUS_CODE_BYTES)`). */
export function statusCodeFrom(bytes: Uint8Array): string {
  if (bytes.length < STATUS_CODE_BYTES) throw new RangeError('statusCodeFrom: too few bytes');
  let bits = 0n;
  for (const byte of bytes.subarray(0, STATUS_CODE_BYTES)) bits = (bits << 8n) | BigInt(byte);
  let code = '';
  for (let i = 0; i < STATUS_CODE_LENGTH; i += 1) {
    code += ALPHABET[Number(bits & 31n)];
    bits >>= 5n;
  }
  return code;
}

/**
 * A code as someone typed it: any case, with spaces or dashes, and the letters Crockford reads as
 * digits (O as 0; I and L as 1). Null when it cannot be a code.
 */
export function normalizeStatusCode(typed: string): string | null {
  const code = typed.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return STATUS_CODE_PATTERN.test(code) ? code : null;
}

/** The code in two groups of five, for reading aloud or typing from paper: `K7M2Q-9XA4B`. */
export function displayStatusCode(code: string): string {
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/** The customer's link under `site` (e.g. `https://bolusi.id`), without a trailing slash. */
export function statusLink(site: string, code: string): string {
  return `${site.replace(/\/+$/, '')}${STATUS_PATH_PREFIX}${code}`;
}
