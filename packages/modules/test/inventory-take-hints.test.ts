// The take step's two hints: the rest of a long list is a search away, and a quantity past the
// stock records is said (still allowed: the count can be wrong).
import { initI18n } from '@bolusi/i18n';
import { beforeAll, describe, expect, test } from 'vitest';

import enCatalog from '../inventory/i18n/en.json' with { type: 'json' };
import idCatalog from '../inventory/i18n/id.json' with { type: 'json' };
import { registerInventoryCatalog } from '../src/inventory/i18n.js';
import type { ItemRow } from '../src/inventory/queries.js';
import { moreHint, overStockHint, PICK_LIMIT } from '../src/inventory/take-part.js';

beforeAll(() => {
  initI18n({ locale: 'id' });
  registerInventoryCatalog({ id: idCatalog, en: enCatalog });
});

const rows = (count: number) => Array.from({ length: count }, () => ({}) as ItemRow);

describe('the take step', () => {
  test('says the rest are a search away only once the list is full', () => {
    expect(moreHint({ fitting: [], rest: rows(PICK_LIMIT - 1) })).toBeNull();
    expect(moreHint({ fitting: rows(3), rest: rows(PICK_LIMIT) })).toBe(
      'Cari untuk lihat sparepart lain.',
    );
  });

  test('says how far a quantity goes past the stock, counting stock below zero as none', () => {
    expect(overStockHint({ onHand: 5 }, 5)).toBeNull();
    expect(overStockHint({ onHand: 5 }, 7)).toBe('Lebih 2 dari stok.');
    expect(overStockHint({ onHand: -2 }, 1)).toBe('Lebih 1 dari stok.');
  });
});
