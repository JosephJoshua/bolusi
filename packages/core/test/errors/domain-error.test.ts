// The DomainError closed code registry (04-module-contract §5.3).
//
// WHY THIS PINS AGAINST THE DOC AND NOT AGAINST A LIST IN THIS FILE. A test that re-types the
// twelve codes proves only that someone typed them twice. §5.3 is the source of truth ("closed
// set; extend here first"), so the assertion reads the spec — adding a code to the registry
// without changing 04 §5.3, or changing §5.3 without the registry, fails here.
//
// THE SECOND COPY, AND WHY IT IS STILL A SECOND COPY. `packages/i18n/scripts/error-code-registry.mjs`
// carries a transcribed DOMAIN_ERROR_CODES for the 07-i18n §7.3 coverage gate, with a
// `TODO(task-10)` asking task 10 to replace it with an import of THIS registry. That import cannot
// be written: 08 §3.3 gives `i18n` no internal dependencies, so an `i18n → core` edge is a change
// to the boundary matrix — a spec edit, and therefore its own task (CLAUDE.md §4). Until then both
// lists are anchored to the SAME doc section (i18n's gates.test.ts pins its copy to 04 §5.3 too),
// so they cannot drift from each other without the spec moving under both. Reported for task 33.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DOMAIN_ERROR_CODES, DomainError, isDomainErrorCode } from '../../src/index.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/** Slice a spec section, failing loudly if the doc's headings ever move. */
function sectionBetween(doc: string, start: string, end: string): string {
  const [, afterStart] = doc.split(start);
  if (afterStart === undefined) throw new Error(`spec section '${start}' not found`);
  const [section] = afterStart.split(end);
  if (section === undefined) throw new Error(`spec section end '${end}' not found`);
  return section;
}

function codesFromSpec(): string[] {
  const doc = readFileSync(`${REPO_ROOT}ai-docs/04-module-contract.md`, 'utf8');
  const section = sectionBetween(doc, '### 5.3', '## 6.');
  return [...section.matchAll(/`([A-Z][A-Z0-9_]+)`/g)].map((match) => match[1] as string);
}

describe('the closed DomainError registry (04 §5.3)', () => {
  it('is exactly the twelve codes 04 §5.3 declares, in order', () => {
    const fromSpec = codesFromSpec();

    // The parse's own denominator (T-14): a heading rename or a reformat that made the extraction
    // return 0 or 2 codes would otherwise let `toEqual` pass against a starved list.
    expect(fromSpec, 'the §5.3 parse found the wrong number of codes').toHaveLength(12);
    expect(DOMAIN_ERROR_CODES).toHaveLength(12);
    expect([...DOMAIN_ERROR_CODES]).toEqual(fromSpec);
  });

  it('contains PERMISSION_DENIED and VALIDATION_FAILED — the two the command runtime throws', () => {
    expect(DOMAIN_ERROR_CODES).toContain('PERMISSION_DENIED');
    expect(DOMAIN_ERROR_CODES).toContain('VALIDATION_FAILED');
  });

  it('has no duplicates', () => {
    expect(new Set(DOMAIN_ERROR_CODES).size).toBe(DOMAIN_ERROR_CODES.length);
  });

  it('every code has a core.errors.<CODE> row in the label seed (07-i18n §7.3)', () => {
    // The 07-i18n §7.3 coverage gate runs in @bolusi/i18n against its catalogs. This is the
    // registry side of the same contract: a code shipped here with no UI copy renders
    // `core.errors.UNEXPECTED` (§4.2) — a real error degraded into a shrug.
    const labels = readFileSync(`${REPO_ROOT}ai-docs/ui-labels.md`, 'utf8');
    const missing = DOMAIN_ERROR_CODES.filter((code) => !labels.includes(`core.errors.${code}`));
    expect(missing, 'codes with no core.errors row').toEqual([]);
  });
});

describe('DomainError construction', () => {
  it('carries the code and a developer message, never UI copy', () => {
    const error = new DomainError('ENTITY_NOT_FOUND', { entityId: 'note-1' });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('DomainError');
    expect(error.code).toBe('ENTITY_NOT_FOUND');
    expect(error.details).toEqual({ entityId: 'note-1' });
    // UI copy is resolved from `core.errors.<CODE>` (07-i18n §4.2) — the message is diagnostic
    // text, and must never be mistaken for something renderable.
    expect(error.message).toContain('ENTITY_NOT_FOUND');
  });

  it('an explicit message wins, and the code still rides structurally', () => {
    const error = new DomainError('ROLE_IN_USE', undefined, 'role still assigned to 3 users');
    expect(error.message).toBe('role still assigned to 3 users');
    expect(error.code).toBe('ROLE_IN_USE');
  });

  it('rejects an unknown code at runtime', () => {
    // The type stops the honest mistake; this stops a code arriving from a cast, a JS caller, or a
    // value crossing a package boundary — which would otherwise render as a plausible-looking
    // generic UI error that the 07-i18n coverage gate can never see.
    expect(() => new DomainError('NOT_A_REAL_CODE' as never)).toThrow(RangeError);
    expect(() => new DomainError('' as never)).toThrow(RangeError);
    expect(() => new DomainError(undefined as never)).toThrow(RangeError);
    expect(() => new DomainError('permission_denied' as never), 'codes are case-sensitive').toThrow(
      RangeError,
    );
  });

  it('rejects an unknown code at compile time', () => {
    // @ts-expect-error — 'NOT_A_REAL_CODE' is not a DomainErrorCode (04 §5.3).
    expect(() => new DomainError('NOT_A_REAL_CODE')).toThrow();
  });

  it('POSITIVE CONTROL — every registry code constructs (the rejection is not blanket)', () => {
    for (const code of DOMAIN_ERROR_CODES) {
      const error = new DomainError(code);
      expect(error.code).toBe(code);
    }
  });

  it('isDomainErrorCode agrees with the registry over the whole set and rejects near-misses', () => {
    for (const code of DOMAIN_ERROR_CODES) expect(isDomainErrorCode(code)).toBe(true);
    for (const near of ['NETWORK_', '_NETWORK', 'network', 'UNEXPECTED', 'BAD_SIGNATURE', '']) {
      // `UNEXPECTED` is a label-catalog fallback and `BAD_SIGNATURE` is a 05 §8 REJECTION code —
      // a separate namespace that must never be mixed with this one (03 §12).
      expect(isDomainErrorCode(near), `${near} must not be a DomainError code`).toBe(false);
    }
  });
});
