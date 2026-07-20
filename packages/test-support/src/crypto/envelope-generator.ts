// Seeded signed-core generator — the input side of SEC-OPLOG-06's random-envelope
// property test (05-operation-log §2.1).
//
// Purpose: prove that Node and Hermes produce IDENTICAL JCS bytes for envelopes nobody
// hand-picked. Fixed vectors only cover cases an author thought of; these envelopes
// deliberately reach for the parts of the shape that make serializers disagree —
// non-ASCII text, surrogate pairs, control characters, integer money, large ms-epoch
// timestamps, deep nesting, explicit nulls, and keys that need real sorting.
//
// Everything derives from a uint32 seed (T-6): the same seed yields byte-identical
// envelopes on both runtimes, which is what makes cross-runtime comparison meaningful.
import { mulberry32, pick, randomInt, type Prng } from '../determinism/prng.js';

/** A §2.1 signed core, structurally. Typed loosely so this file stays dependency-light. */
export interface GeneratedSignedCore {
  id: string;
  tenantId: string;
  storeId: string | null;
  userId: string;
  deviceId: string;
  seq: number;
  type: string;
  entityType: string;
  entityId: string;
  schemaVersion: number;
  payload: Record<string, unknown>;
  timestamp: number;
  location: { lat: number; lng: number; accuracyMeters: number } | null;
  source: 'ui' | 'agent' | 'api' | 'system';
  agentInitiated: boolean;
  agentConversationId: string | null;
  previousHash: string;
}

const HEX = '0123456789abcdef';

function hex(prng: Prng, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += HEX[randomInt(prng, 0, 15)];
  return out;
}

/** A syntactically valid UUIDv7 (version + variant bits set) — `zUuidV7` accepts it. */
function uuidV7(prng: Prng, timestampMs: number): string {
  const timeHex = Math.floor(timestampMs).toString(16).padStart(12, '0').slice(-12);
  const randA = hex(prng, 3);
  const variantChar = pick(prng, ['8', '9', 'a', 'b']);
  const randB = variantChar + hex(prng, 3);
  const randC = hex(prng, 12);
  return `${timeHex.slice(0, 8)}-${timeHex.slice(8, 12)}-7${randA}-${randB}-${randC}`;
}

/** A syntactically valid RFC 9562 v4 UUID — tenant/store/user/device ids. */
function uuidV4(prng: Prng): string {
  const variantChar = pick(prng, ['8', '9', 'a', 'b']);
  return `${hex(prng, 8)}-${hex(prng, 4)}-4${hex(prng, 3)}-${variantChar}${hex(prng, 3)}-${hex(prng, 12)}`;
}

/**
 * Strings chosen to break naive serializers, not to look realistic.
 *
 * Each entry targets a specific divergence risk: UTF-16 surrogate pairs (emoji), the
 * `\u00XX` escape range (control characters), non-BMP and RTL text, JSON metacharacters,
 * and the Indonesian/Latin-1 range this product actually types in.
 */
const TRICKY_STRINGS = [
  'catatan',
  'Ubah harga — Rp 12.500',
  'emoji: \u{1f600}\u{1f469}‍\u{1f4bb}',
  'control: \u0000\u0001\u000f\u001f',
  'quote " backslash \\ slash /',
  'newline \n tab \t return \r',
  'rtl: אבג דּ',
  'euro € dollar $ yen ¥',
  'combining: é å',
  '',
  'a'.repeat(64),
] as const;

const OP_TYPES = [
  'notes.note_created',
  'notes.note_body_edited',
  'notes.note_archived',
  'auth.user_switched',
  'platform.user_locale_changed',
] as const;

// BOUNDARY-FORCED MIRROR of the canonical `OP_SOURCES` (packages/schemas/src/envelope.ts).
// This module is bundled INTO the Hermes JCS-vector runner (scripts/hermes-vectors/runner.ts),
// whose bundle forbids zod (08 §5.6) — and `OP_SOURCES` lives in `envelope.ts`, whose top-level
// `z.*` calls make ANY import of it pull zod into that bundle. So this cannot be import-deduped
// and re-declares the set locally; kept EQUAL to the canonical by the parity gate that reddens on
// divergence (./enum-mirror-parity.test.ts, task 53 — a gated forced mirror is legitimate, §2.11).
const SOURCES = ['ui', 'agent', 'api', 'system'] as const;

/** A payload whose shape (nesting, key order, value types) varies with the seed. */
function generatePayload(prng: Prng): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    // Keys are emitted unsorted on purpose — JCS must sort them.
    zebra: pick(prng, TRICKY_STRINGS),
    alpha: randomInt(prng, -1_000_000, 1_000_000),
    // Money is ALWAYS integer IDR (05 §3) — never a float.
    priceIdr: randomInt(prng, 0, 500_000_000),
    'key with spaces': pick(prng, TRICKY_STRINGS),
    '': 'empty key',
    '1': 'numeric-looking key',
    nested: {
      deep: {
        deeper: pick(prng, TRICKY_STRINGS),
        count: randomInt(prng, 0, 1000),
        flag: prng() < 0.5,
        nothing: null,
      },
      list: [
        randomInt(prng, 0, 100),
        pick(prng, TRICKY_STRINGS),
        null,
        prng() < 0.5,
        { inner: randomInt(prng, 0, 10), label: pick(prng, TRICKY_STRINGS) },
      ],
    },
    emptyObject: {},
    emptyList: [],
  };

  if (prng() < 0.5) payload['optionalPresent'] = pick(prng, TRICKY_STRINGS);
  // Decimal STRINGS are legal payload numbers; floats are not (05 §3).
  if (prng() < 0.5) payload['quantity'] = `${randomInt(prng, 0, 999)}.${randomInt(prng, 0, 99)}`;

  return payload;
}

/** Generate one deterministic signed core. */
export function generateSignedCore(prng: Prng, seq: number, deviceId: string): GeneratedSignedCore {
  // A realistic ms-epoch range (2020..2035) — large enough to exercise integer
  // serialization, and the exact range real `timestamp` values land in.
  const timestamp = randomInt(prng, 1_577_836_800_000, 2_051_222_400_000);

  return {
    id: uuidV7(prng, timestamp),
    tenantId: uuidV4(prng),
    storeId: prng() < 0.5 ? null : uuidV4(prng),
    userId: uuidV4(prng),
    deviceId,
    seq,
    type: pick(prng, OP_TYPES),
    entityType: 'note',
    entityId: uuidV7(prng, timestamp),
    schemaVersion: randomInt(prng, 1, 3),
    payload: generatePayload(prng),
    timestamp,
    location:
      prng() < 0.5
        ? null
        : {
            // Real GPS doubles — the one place non-integer numbers are legal (05 §2.1),
            // and therefore the one place float serialization must be proven identical.
            lat: -6.2 + prng() * 0.5,
            lng: 106.8 + prng() * 0.5,
            accuracyMeters: prng() * 100,
          },
    source: pick(prng, SOURCES),
    agentInitiated: prng() < 0.5,
    agentConversationId: prng() < 0.5 ? null : uuidV4(prng),
    previousHash: seq === 1 ? '0'.repeat(64) : hex(prng, 64),
  };
}

/**
 * Generate `count` signed cores from `seed`.
 *
 * Deterministic: same seed, same envelopes, on every runtime.
 */
export function generateSignedCores(seed: number, count: number): GeneratedSignedCore[] {
  const prng = mulberry32(seed);
  const deviceId = uuidV4(prng);
  return Array.from({ length: count }, (_, index) => generateSignedCore(prng, index + 1, deviceId));
}
