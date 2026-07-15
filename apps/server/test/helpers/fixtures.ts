// Deterministic per-seed fixtures (testing-guide T-3: unique values per case, no shared magic
// constants; T-6: no real RNG). Every value is derived from a seed string via SHA-256, so two
// tests never collide on a literal id or token, and a failure reproduces from its seed.
import { createHash } from 'node:crypto';

function bytesFromSeed(seed: string): Buffer {
  return createHash('sha256').update(seed).digest();
}

/** A valid RFC 4122 v4 UUID derived from `seed` (zUuid accepts any version). */
export function detUuid(seed: string): string {
  const b = bytesFromSeed(seed).subarray(0, 16);
  const withBits = Buffer.from(b);
  withBits.writeUInt8((withBits.readUInt8(6) & 0x0f) | 0x40, 6); // version 4
  withBits.writeUInt8((withBits.readUInt8(8) & 0x3f) | 0x80, 8); // variant
  const hex = withBits.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface Fixture {
  readonly tenantId: string;
  readonly storeId: string;
  readonly deviceId: string;
  readonly userId: string;
  readonly deviceToken: string;
  readonly controlToken: string;
}

export function makeFixture(seed: string): Fixture {
  return {
    tenantId: detUuid(`${seed}:tenant`),
    storeId: detUuid(`${seed}:store`),
    deviceId: detUuid(`${seed}:device`),
    userId: detUuid(`${seed}:user`),
    deviceToken: `bdt_${bytesFromSeed(`${seed}:dtok`).toString('hex')}`,
    controlToken: `bcs_${bytesFromSeed(`${seed}:ctok`).toString('hex')}`,
  };
}
