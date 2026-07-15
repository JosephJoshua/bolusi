// Node side of the §5.4 golden vectors (08 §5.6 stage 4). The Hermes side is hermes-entry.ts,
// executed by the stage-6 lane.
import { describe, expect, it } from 'vitest';

import { formatMoney, initI18n, setLocale } from '../src/index.js';
import { runI18nVectors } from './vectors.js';

describe('07-i18n §5.4 golden vectors (Node)', () => {
  const results = runI18nVectors();

  it('runs every vector in the §5.4 table', () => {
    expect(results).toHaveLength(12);
  });

  for (const result of results) {
    it(`${result.name} → ${JSON.stringify(result.expected)}`, () => {
      expect(result.actual).toBe(result.expected);
    });
  }
});

describe('money rendering (§5.1)', () => {
  it('normalizes the NBSP Intl inserts after Rp — printers and font fallbacks mangle it', () => {
    initI18n({ locale: 'id' });

    // Guard the intent, not just the output: Intl really does emit U+00A0 here, so this test
    // fails if the normalization is ever dropped.
    const raw = new Intl.NumberFormat('id-ID', {
      style: 'currency',
      currency: 'IDR',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(250000);
    expect(raw).toContain(' ');

    for (const amount of [250000, 0, 1500500, -50000]) {
      expect(formatMoney(amount)).not.toContain(' ');
    }
    expect(formatMoney(250000)).toBe('Rp 250.000');
  });

  it('never renders a minor unit, whatever CLDR says the IDR default is (FR-1160)', () => {
    initI18n({ locale: 'id' });
    expect(formatMoney(250000)).not.toContain(',00');
    expect(formatMoney(250050)).toBe('Rp 250.050');
  });

  it('is identical under the en toggle — no IDR 250,000 surprise', () => {
    initI18n({ locale: 'id' });
    const asId = formatMoney(1500500);
    setLocale('en');
    expect(formatMoney(1500500)).toBe(asId);
  });
});
