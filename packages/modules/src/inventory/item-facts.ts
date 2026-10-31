// What an item is, as filled in, for its detail on the phone and the PC: its category and that
// category's fields, codes, phones and tags. Empty ones are left out.
import { ti } from './i18n.js';
import type { ItemDetailRow } from './queries.js';

export interface ItemFact {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  /** Long enough to want a whole row. */
  readonly wide: boolean;
}

export function itemFacts(row: ItemDetailRow): ItemFact[] {
  const facts: ItemFact[] = [];
  const add = (key: string, label: string, value: string | null, wide = false): void => {
    if (value !== null && value !== '') facts.push({ key, label, value, wide });
  };
  add('category', ti('inventory.detail.category'), row.category?.name ?? null);
  for (const field of row.category?.fields ?? []) {
    if (field.kind !== 'phones') {
      add(`field.${field.id}`, field.label, (row.values[field.id] ?? []).join(', '));
    }
  }
  add('code', ti('inventory.detail.code'), row.code);
  add('barcode', ti('inventory.detail.barcode'), row.barcode);
  add('fits', ti('inventory.detail.fits'), row.fits, true);
  add('tags', ti('inventory.detail.tags'), row.tags.join(', '), true);
  return facts;
}
