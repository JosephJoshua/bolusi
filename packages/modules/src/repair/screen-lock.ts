// How a phone's screen lock is written down at intake: a PIN, a password or an Android pattern.
// The ticket keeps it in its one passcode text (`device.passcode` on `repair.ticket_opened`) as
// "<kind>:<value>", so no operation changes shape; a passcode recorded before kinds existed reads
// back as `unknown` and is shown as typed. A pattern is the dots in drawing order on the 3 x 3
// grid, numbered 1-9 from the top left: "pattern:15963".

export const SCREEN_LOCK_KINDS = ['pin', 'password', 'pattern'] as const;
export type ScreenLockKind = (typeof SCREEN_LOCK_KINDS)[number];

export interface ScreenLock {
  readonly kind: ScreenLockKind | 'unknown';
  readonly value: string;
}

/** Android asks for at least four dots, so a shorter pattern was not finished. */
export const PATTERN_MIN_DOTS = 4;

/** A pattern as dots 1-9, each used once. */
export function isPattern(value: string): boolean {
  return /^[1-9]+$/.test(value) && new Set(value).size === value.length;
}

export function encodeScreenLock(lock: { kind: ScreenLockKind; value: string }): string {
  return `${lock.kind}:${lock.value}`;
}

export function decodeScreenLock(text: string): ScreenLock {
  const colon = text.indexOf(':');
  const kind = colon < 0 ? '' : text.slice(0, colon);
  const value = text.slice(colon + 1);
  if (kind === 'pin' || kind === 'password') return { kind, value };
  if (kind === 'pattern' && isPattern(value)) return { kind, value };
  return { kind: 'unknown', value: text };
}

/** "15963" → "1-5-9-6-3", for reading a pattern aloud or where it cannot be drawn. */
export function patternSteps(value: string): string {
  return [...value].join('-');
}
