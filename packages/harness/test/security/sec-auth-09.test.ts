import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { timingSafeEqualBytes } from '@bolusi/core';
import {
  leakedVerifierEncodings,
  verifierEncodings,
  type VerifierSecrets,
} from '../../src/security/verifier-scan.js';

/** Isolate the `timingSafeEqualBytes` function body from its source (fail loudly if not found — T-14). */
function timingSafeEqualBytesSource(root: string): string {
  const src = readFileSync(join(root, 'packages/core/src/auth/verifier.ts'), 'utf8');
  const start = src.indexOf('export function timingSafeEqualBytes');
  expect(
    start,
    'timingSafeEqualBytes not found in verifier.ts — leg 3 has no producer to check',
  ).toBeGreaterThan(-1);
  // Walk to the matching close brace of the function body.
  const braceOpen = src.indexOf('{', start);
  let depth = 0;
  let end = braceOpen;
  for (let i = braceOpen; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  return src.slice(braceOpen, end + 1);
}

describe('verifier confidentiality', () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));

  it('SEC-AUTH-09 payloads: the verifier-material scanner catches every planted encoding and ignores the params that legitimately travel (I-13)', () => {
    const secret: VerifierSecrets = {
      saltB64: Buffer.alloc(16, 7).toString('base64'),
      hashB64: Buffer.alloc(32, 9).toString('base64'),
    };
    const encodings = verifierEncodings(secret);
    expect(
      encodings.length,
      'the scanner enumerates fewer encodings than expected',
    ).toBeGreaterThanOrEqual(6);
    for (const encoding of encodings) {
      const planted = JSON.stringify({ targetUserId: 'u', leaked: encoding });
      expect(leakedVerifierEncodings(planted, [secret]), `the scan missed ${encoding}`).toContain(
        encoding,
      );
    }
    // The legitimate D11 payload (verifierRef + params) must NOT trip the scan.
    const legitimate = JSON.stringify({
      targetUserId: '0c111111-1111-7111-8111-111111111111',
      verifierRef: '0a888888-8888-7888-8888-888888888888',
      params: { algorithm: 'argon2id', mKiB: 32768, t: 3, p: 1 },
    });
    expect(leakedVerifierEncodings(legitimate, [secret])).toEqual([]);
  });

  it('SEC-AUTH-09 comparison: the PIN-verifier compare is constant-time (structure + behaviour)', () => {
    // Behaviour a short-circuit would break: pairing first-diff and last-diff rejects a first-byte
    // short-circuit; folding a length mismatch rejects an early length return.
    const a = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(timingSafeEqualBytes(a, Uint8Array.from(a))).toBe(true);
    const firstDiff = Uint8Array.from(a);
    firstDiff[0] = 99;
    const lastDiff = Uint8Array.from(a);
    lastDiff[lastDiff.length - 1] = 99;
    expect(timingSafeEqualBytes(a, firstDiff)).toBe(false);
    expect(timingSafeEqualBytes(a, lastDiff)).toBe(false);
    expect(timingSafeEqualBytes(Uint8Array.from([1, 2, 3]), Uint8Array.from([1, 2, 3, 4]))).toBe(
      false,
    );
    expect(timingSafeEqualBytes(Uint8Array.from([]), Uint8Array.from([]))).toBe(true);

    // Structure: a single terminal `return`, no early return / break inside the loop, length folded.
    const body = timingSafeEqualBytesSource(root);
    const returns = body.match(/\breturn\b/g) ?? [];
    expect(returns.length, 'a constant-time compare returns exactly once, at the end').toBe(1);
    expect(body, 'the terminal return must compare the single accumulator, not a byte').toMatch(
      /return\s+diff\s*===\s*0\s*;/,
    );
    expect(body, 'no break may short-circuit the compare loop').not.toMatch(/\bbreak\b/);
    expect(
      body,
      'the length difference must be folded into the accumulator, never early-returned',
    ).toMatch(/diff\s*=\s*a\.length\s*\^\s*b\.length/);
  });
});
