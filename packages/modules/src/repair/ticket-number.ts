// Offline ticket numbers.
//
// A ticket number must be minted with no network, on any of a store's phones or counter PCs, and
// be short enough to read aloud and write on paper. It is `<device code>-<per-device counter>`,
// e.g. `K7Q-0042`. The device code is derived from the random tail of the device's UUIDv7, so it
// needs no server assignment; the counter comes from this device's own tickets in the projection,
// and is carried in the signed payload so a re-fold reproduces the same number.
//
// Two devices in one store sharing a code is unlikely (32,768 codes) but possible. That is
// tolerated rather than prevented: tickets are keyed by id, and a search for a number simply
// shows both matches.

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

export function formatTicketNumber(deviceId: string, counter: number): string {
  return `${deviceCode(deviceId)}-${String(counter).padStart(4, '0')}`;
}

/** The per-device counter part of a ticket number, or null if it is not one of ours. */
export function ticketCounter(ticketNumber: string): number | null {
  const match = /^[0-9A-Z]{3}-(\d{4,})$/.exec(ticketNumber);
  return match === null ? null : Number(match[1]);
}
