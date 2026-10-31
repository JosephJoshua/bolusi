// A servisan's status link: the code printed on the slip (and sent on WhatsApp) that lets the
// customer follow the repair on the web without an account (product-scope.md, "Customers follow
// their repair online").
//
// The code is the only credential, so it is random, not derived from the servisan number or the
// customer's phone, which are easy to guess. It is made on the device at intake so it works
// offline, and the page shows it once the servisan has synced.
//
// The code is a hash of a random nonce and where the servisan lives (tenant, store, servisan). The op
// carries both, and its rule checks the one against the other on the device and on the server, so
// a code copied off a slip cannot be recorded for a servisan anywhere else, which would kill the
// customer's link or point it at another store; that would take a 60-bit hash preimage.
//
// Twelve Crockford base32 characters: 60 bits, no I, L, O or U, so a code typed from paper survives
// a misread 0/O or 1/I/L, and fits a small QR code in alphanumeric mode.
import { utf8ToBytes } from '@bolusi/core';

/** Crockford's base32 alphabet. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const STATUS_CODE_LENGTH = 12;

/** A code as stored and as the link carries it. */
export const STATUS_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{12}$/;

/** The path of the customer's page, under the site that serves it. */
export const STATUS_PATH_PREFIX = '/c/';

/** Random bytes in a link's nonce (`ctx.randomBytes(STATUS_NONCE_BYTES)`). */
export const STATUS_NONCE_BYTES = 16;

/** A nonce as the op carries it: lowercase hex. */
export const STATUS_NONCE_PATTERN = /^[0-9a-f]{32}$/;

/** Separates this hash from any other the app takes over the same ids. */
const DOMAIN = 'bolusi/repair-status-link/v1';

export function statusNonceFrom(bytes: Uint8Array): string {
  if (bytes.length < STATUS_NONCE_BYTES) throw new RangeError('statusNonceFrom: too few bytes');
  return Array.from(bytes.subarray(0, STATUS_NONCE_BYTES), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

/** Where a servisan lives: what its code is bound to. */
export interface StatusLinkOwner {
  readonly tenantId: string;
  readonly storeId: string;
  readonly ticketId: string;
}

/**
 * The code for a servisan's link nonce: the first 60 bits of a SHA-256 over both, by the injected
 * crypto port (`ctx.sha256`).
 */
export function statusCodeFor(
  owner: StatusLinkOwner,
  nonce: string,
  sha256: (data: Uint8Array) => Uint8Array,
): string {
  const input = [DOMAIN, owner.tenantId, owner.storeId, owner.ticketId, nonce].join('\n');
  const digest = sha256(utf8ToBytes(input));
  let bits = 0n;
  for (const byte of digest.subarray(0, 8)) bits = (bits << 8n) | BigInt(byte);
  let code = '';
  for (let i = 0; i < STATUS_CODE_LENGTH; i += 1) {
    code += ALPHABET[Number((bits >> BigInt(64 - 5 * (i + 1))) & 31n)];
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

/** The code in three groups of four, for reading aloud or typing from paper: `K7M2-Q9XA-4BRS`. */
export function displayStatusCode(code: string): string {
  return code.match(/.{1,4}/g)?.join('-') ?? code;
}

/** The customer's link under `site` (e.g. `https://bolusi.id`), without a trailing slash. */
export function statusLink(site: string, code: string): string {
  return `${site.replace(/\/+$/, '')}${STATUS_PATH_PREFIX}${code}`;
}
