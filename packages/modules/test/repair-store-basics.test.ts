import { describe, expect, test } from 'vitest';

import type { PaymentAccountRow } from '../src/money/queries.js';
import { DEFAULT_PRINT_SETTINGS } from '../src/repair/queries.js';
import { missingStoreBasics } from '../src/repair/store-basics.js';

const QRIS: PaymentAccountRow = {
  id: 'a1',
  kind: 'qris',
  name: 'QRIS Toko',
  active: true,
  central: false,
  storeIds: [],
};

describe('the store basics a new store still lacks', () => {
  test('a store that set nothing lacks all of them', () => {
    expect(missingStoreBasics(DEFAULT_PRINT_SETTINGS, [])).toEqual([
      'slipHeader',
      'logo',
      'terms',
      'paymentMethods',
    ]);
  });

  test('each is done once filled in: a phone alone is a header, one term set is its own terms', () => {
    expect(
      missingStoreBasics(
        {
          ...DEFAULT_PRINT_SETTINGS,
          phone: '0812 3456 7890',
          logo: { mediaId: 'm1', sha256: 'x', mime: 'image/png' },
          handoverTerms: 'Garansi 7 hari',
        },
        [QRIS],
      ),
    ).toEqual([]);
  });

  test('a switched-off method is no method, and a header of spaces is no header', () => {
    expect(
      missingStoreBasics({ ...DEFAULT_PRINT_SETTINGS, address: '   ' }, [
        { ...QRIS, active: false },
      ]),
    ).toEqual(['slipHeader', 'logo', 'terms', 'paymentMethods']);
  });

  test('what was not read (the person may not change it) is not listed', () => {
    expect(missingStoreBasics(null, [])).toEqual(['paymentMethods']);
    expect(missingStoreBasics(DEFAULT_PRINT_SETTINGS, null)).toEqual([
      'slipHeader',
      'logo',
      'terms',
    ]);
  });
});
