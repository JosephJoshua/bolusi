/**
 * The `userPinVerifiers` row builder's MAPPING (task 208; gap found by a QA sweep).
 *
 * `export-surface.test.ts` proves the symbol is exported and not queryish. The generated `DB` type
 * catches a field-NAME error at compile time. Neither catches a field-VALUE swap: `asOf.timestamp`
 * and `asOf.seq` are both plain `number`, so transposing them compiles clean — and silently corrupts
 * the api/02-auth §5.3 merge rule, which decides WHICH PIN verifier wins by canonical order. A device
 * would accept a stale verifier, or reject a current one, with every test still green.
 *
 * So this asserts the mapping itself: fixed input in, exact object out, no database involved.
 */
import { expect, test } from 'vitest';

import { buildPinVerifierRow } from '../src/pin-verifier-row.js';

const VERIFIER = {
  saltB64: 'c2FsdC1zaXh0ZWVuLWJ5dGU=',
  mKiB: 32768,
  t: 3,
  p: 1,
  hashB64: 'aGFzaC10aGlydHktdHdvLWJ5dGVzLWxvbmc=',
  asOf: { timestamp: 1_726_000_111_222, deviceId: 'device-a', seq: 7 },
} as const;

const OWNER = { userId: 'user-a', tenantId: 'tenant-a' } as const;

test('the row maps every field to its own column', () => {
  expect(buildPinVerifierRow(VERIFIER, OWNER)).toEqual({
    userId: 'user-a',
    tenantId: 'tenant-a',
    algo: 'argon2id',
    salt: VERIFIER.saltB64,
    params: { m: 32768, t: 3, p: 1 },
    hash: VERIFIER.hashB64,
    asOfTimestamp: 1_726_000_111_222n,
    asOfDeviceId: 'device-a',
    asOfSeq: 7n,
  });
});

test('timestamp and seq do not cross over', () => {
  // The specific transpose the type system cannot see. Distinct magnitudes, so a swap cannot coincide.
  const row = buildPinVerifierRow(VERIFIER, OWNER);
  expect(row.asOfTimestamp).toBe(BigInt(VERIFIER.asOf.timestamp));
  expect(row.asOfSeq).toBe(BigInt(VERIFIER.asOf.seq));
  expect(row.asOfTimestamp).not.toBe(row.asOfSeq);
});

test('the int8 columns are BigInt, not number', () => {
  // `asOfTimestamp`/`asOfSeq` are int8. Handing the driver a JS number silently loses precision past
  // 2^53 and, on some drivers, round-trips as a different value — so the coercion is load-bearing.
  const row = buildPinVerifierRow(VERIFIER, OWNER);
  expect(typeof row.asOfTimestamp).toBe('bigint');
  expect(typeof row.asOfSeq).toBe('bigint');
});

test('the salt and hash are not interchanged', () => {
  // Both are base64 strings of similar shape — another swap the compiler cannot catch, and one that
  // would make every PIN verification fail closed in a way that looks like a wrong PIN.
  const row = buildPinVerifierRow(VERIFIER, OWNER);
  expect(row.salt).toBe(VERIFIER.saltB64);
  expect(row.hash).toBe(VERIFIER.hashB64);
});

test('the algorithm is pinned, not taken from the caller', () => {
  // `algo` is the one field the input does not supply. If it ever became caller-controlled, a row
  // could claim an algorithm the verifier was not built with.
  expect(buildPinVerifierRow(VERIFIER, OWNER).algo).toBe('argon2id');
});
