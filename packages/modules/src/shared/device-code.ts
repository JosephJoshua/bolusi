// A short code for a device, so records it numbers offline (servisan, supplier orders) read
// `K7Q-0042` with no server assignment. Derived from the random tail of the device's UUIDv7.

/** Crockford base32 minus easily confused letters (no I, L, O, U). */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A 3-character code for a device id. Uses the UUID's random tail, not its timestamp prefix. */
export function deviceCode(deviceId: string): string {
  const hex = deviceId.replace(/-/g, '').slice(-8);
  let value = Number.parseInt(hex, 16);
  if (!Number.isFinite(value)) throw new Error(`deviceCode: not a uuid: ${deviceId}`);
  let code = '';
  for (let i = 0; i < 3; i += 1) {
    code = ALPHABET[value % 32]! + code;
    value = Math.floor(value / 32);
  }
  return code;
}
