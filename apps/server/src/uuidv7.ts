// UUIDv7 for X-Request-Id (api/00 §5.1: "UUIDv7 per request"). RFC 9562 layout: 48-bit
// big-endian ms timestamp, version nibble 0x7, RFC 4122 variant, remaining bits CSPRNG.
//
// @bolusi/core owns UUIDv7 for op/entity ids over an injected crypto port (08 §2.3); this is
// the server-transport id generator — Node-only, no port, deliberately separate so a request
// id never depends on the domain crypto stack.
import { randomBytes } from 'node:crypto';

/** Generate a UUIDv7 string. `nowMs` is injectable for deterministic tests (T-6). */
export function uuidv7(nowMs: number = Date.now()): string {
  const bytes = randomBytes(16);
  // 48-bit ms timestamp into the first 6 bytes (big-endian).
  bytes.writeUIntBE(nowMs % 0x1000000000000, 0, 6);
  // Version 7 in the high nibble of byte 6.
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x70, 6);
  // RFC 4122 variant (10xx) in the two high bits of byte 8.
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
