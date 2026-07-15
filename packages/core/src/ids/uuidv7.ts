// UUIDv7 generator (08-stack-and-repo §2.3) — implemented inside @bolusi/core over the
// injected rng + clock, with NO uuid-library dependency. Used for the envelope `id` and
// `entityId` (05 §2.1). Deterministic-testable: given a seeded rng and a FakeClock the
// sequence reproduces bit-for-bit (T-6), which is what lets canonical ordering be stable
// across a chaos run.
//
// Layout (RFC 9562 §5.7): 48-bit unix_ts_ms | ver=0111 | 12-bit rand_a | var=10 |
// 62-bit rand_b. Text is lowercase canonical (10-db §2), so `deviceId ASC` / id ordering
// is bytewise === lexicographic, identical on Hermes and Postgres.
//
// Monotonicity (RFC 9562 §6.2, "monotonic random"): within a single millisecond the 74
// random bits (rand_a‖rand_b) are treated as one counter and advanced by a random step,
// so ids minted in the same ms still sort in creation order. A backwards clock never
// regresses ordering — the last-seen ms is held (an anti-rollback guard), so a drifted
// device clock cannot mint an id that sorts before an earlier one.

/** The injected effects the generator needs — a clock and an rng, nothing else. */
export interface UuidV7Options {
  /** ms epoch (integer). Tests inject a FakeClock; production injects the system clock. */
  readonly now: () => number;
  /** CSPRNG bytes in production; a seeded PRNG in tests (T-6). */
  readonly randomBytes: (length: number) => Uint8Array;
}

/** A stateful id source: each call returns the next monotonic UUIDv7. */
export type UuidV7Source = () => string;

const MAX_MS = (1n << 48n) - 1n;
const RAND_BITS = 74n;
const RAND_MASK = (1n << RAND_BITS) - 1n;
const RAND_B_MASK = (1n << 62n) - 1n;
const VERSION = 0x7n;
const VARIANT = 0b10n;

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

/** Assemble the 128-bit value and render canonical lowercase 8-4-4-4-12 text. */
function format(ms: bigint, rand74: bigint): string {
  const value =
    (ms << 80n) |
    (VERSION << 76n) |
    ((rand74 >> 62n) << 64n) |
    (VARIANT << 62n) |
    (rand74 & RAND_B_MASK);
  const hex = value.toString(16).padStart(32, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createUuidV7Generator(options: UuidV7Options): UuidV7Source {
  let lastMs = -1n;
  let lastRand = 0n;

  // 74 fresh random bits from 10 CSPRNG bytes (80 bits), masked down.
  const freshRand = (): bigint => bytesToBigInt(options.randomBytes(10)) & RAND_MASK;
  // A positive same-ms increment from 4 rng bytes — guarantees strict monotonicity.
  const randStep = (): bigint => (bytesToBigInt(options.randomBytes(4)) & 0xffffffffn) + 1n;

  return () => {
    let ms = BigInt(Math.trunc(options.now()));
    if (ms < 0n) ms = 0n;
    if (ms > MAX_MS) ms = MAX_MS;

    if (ms > lastMs) {
      lastMs = ms;
      lastRand = freshRand();
    } else {
      // Same ms, or the clock went backwards: hold `lastMs` and advance the random
      // counter so ordering never regresses (RFC 9562 §6.2 + anti-rollback).
      let next = lastRand + randStep();
      if (next > RAND_MASK) {
        // 74-bit rollover inside one ms (astronomically unlikely) — bump the timestamp.
        lastMs = lastMs >= MAX_MS ? MAX_MS : lastMs + 1n;
        next = freshRand();
      }
      lastRand = next;
    }
    return format(lastMs, lastRand);
  };
}
