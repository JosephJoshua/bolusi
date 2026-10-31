// What the items list is narrowed to, on the phone and the PC: a stock view, a category, field
// values and tags. Each app keeps one, so it outlives a trip into an item.
import type { CategoryField } from './categories.js';
import { INVENTORY_PERMISSION, TAG_FACET } from './constants.js';
import type { InventoryKey } from './i18n.js';
import { NO_CATEGORY, type ListPartsInput, type PartFilter } from './queries.js';
import { useInventoryQuery } from './runtime.js';

export interface ListFilter {
  readonly stock: PartFilter;
  /** A category's id, `NO_CATEGORY`, or null for all. */
  readonly categoryId: string | null;
  readonly tags: readonly string[];
  /** By field id of the chosen category. */
  readonly values: Readonly<Record<string, readonly string[]>>;
}

export const NO_FILTER: ListFilter = { stock: 'active', categoryId: null, tags: [], values: {} };

/** How many filters are in force beyond the category, which shows on its own. */
export function filterCount(filter: ListFilter): number {
  return (
    (filter.stock === 'active' ? 0 : 1) +
    filter.tags.length +
    Object.values(filter.values).reduce((sum, values) => sum + values.length, 0)
  );
}

/** The `listItems` input for a filter and search text. */
export function listInput(
  filter: ListFilter,
  text: string,
  page: { readonly offset: number; readonly limit: number },
): ListPartsInput {
  return {
    text,
    filter: filter.stock,
    categoryId: filter.categoryId,
    tags: [...filter.tags],
    values: Object.fromEntries(
      Object.entries(filter.values).map(([id, values]) => [id, [...values]]),
    ),
    ...page,
  };
}

/**
 * The stock views this person may pick. Stock below zero and archived items are the owners' to sort
 * out, so only someone who manages the list sees them.
 */
export function stockViews(hasPermission: (id: string) => boolean): readonly PartFilter[] {
  return hasPermission(INVENTORY_PERMISSION.manageItems)
    ? ['active', 'outOfStock', 'belowZero', 'archived']
    : ['active', 'outOfStock'];
}

export const STOCK_VIEW_KEY: Readonly<Record<PartFilter, InventoryKey>> = {
  active: 'inventory.filter.active',
  outOfStock: 'inventory.filter.outOfStock',
  belowZero: 'inventory.filter.belowZero',
  archived: 'inventory.filter.archived',
};

/** What an empty stock view lacks, said when nothing else narrows the list. */
export const EMPTY_VIEW_KEY: Readonly<Record<PartFilter, InventoryKey>> = {
  active: 'inventory.list.emptyHint',
  belowZero: 'inventory.list.noBelowZero',
  outOfStock: 'inventory.list.noOutOfStock',
  archived: 'inventory.list.noArchived',
};

export interface FilterChoices {
  /** The chosen category's fields that items fill in, each with its values in use. */
  readonly fields: readonly { readonly field: CategoryField; readonly values: readonly string[] }[];
  readonly tags: readonly string[];
}

/**
 * What a filter can offer: the values items actually carry, most used first, so a choice never
 * finds nothing. Fields with nothing in use are left out, and so are phones, which search matches.
 */
export function useFilterChoices(filterCategoryId: string | null): FilterChoices {
  const categoryId =
    filterCategoryId === null || filterCategoryId === NO_CATEGORY ? null : filterCategoryId;
  const choices = useInventoryQuery(
    async (rt) => ({
      category:
        categoryId === null
          ? null
          : ((await rt.query('listCategories', { includeArchived: true })).rows.find(
              (row) => row.id === categoryId,
            ) ?? null),
      facets: (await rt.query('facetValues', { categoryId })).rows,
    }),
    `itemFilter:${categoryId ?? ''}`,
  );
  const loaded = choices.status === 'ready' ? choices.data : { category: null, facets: [] };
  const inUse = (facet: string): string[] =>
    loaded.facets.filter((row) => row.facet === facet).map((row) => row.value);
  return {
    fields: (loaded.category?.fields ?? [])
      .filter((field) => field.kind !== 'phones')
      .map((field) => ({ field, values: inUse(field.id) }))
      .filter(({ values }) => values.length > 0),
    tags: inUse(TAG_FACET),
  };
}
