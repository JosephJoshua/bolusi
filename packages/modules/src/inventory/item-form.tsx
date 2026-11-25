// Adding an item to the business's list, or editing one, on the phone and the PC: pick its
// category and fill in the category's fields; the name builds itself from them by the category's
// format, so a long list entered by many people reads one way (owner decision, 2026-10-28). A name
// can still be typed for an odd item, and an item can go without a category. Adding asks how many
// are on the shelf now, and "Tambah lagi" keeps the category, fields and phones for the next item.
import { useRef, useState } from 'react';

import { useActionRunner, type ActionRunner } from '../screen-kit/index.js';

import { formatItemName, type CategoryField, type FieldValues } from './categories.js';
import { INVENTORY_PERMISSION, TAG_FACET } from './constants.js';
import type { CategoryRow, FacetValueRow, ItemDetailRow, ItemFitRow } from './queries.js';
import { useInventoryQuery, useInventoryRuntime } from './runtime.js';

export interface ItemDraft {
  readonly categoryId: string | null;
  readonly values: FieldValues;
  readonly fits: readonly ItemFitRow[];
  /** True while the name is the category's format filled in. */
  readonly nameAuto: boolean;
  /** The typed name; unused while `nameAuto`. */
  readonly name: string;
  readonly code: string;
  readonly barcode: string;
  readonly tags: readonly string[];
}

function draftOf(part: ItemDetailRow | undefined, categoryId: string | null): ItemDraft {
  return {
    categoryId: part?.categoryId ?? categoryId,
    values: part?.values ?? {},
    fits: part?.models ?? [],
    nameAuto: part?.nameAuto ?? true,
    name: part?.name ?? '',
    code: part?.code ?? '',
    barcode: part?.barcode ?? '',
    tags: part?.tags ?? [],
  };
}

export interface ItemForm {
  readonly adding: boolean;
  readonly draft: ItemDraft;
  readonly set: (patch: Partial<ItemDraft>) => void;
  /** How many are on the shelf, for a new item (counting needs `inventory.count`). */
  readonly stock: number;
  readonly setStock: (stock: number) => void;
  readonly canCount: boolean;
  /** Something changed since the form (re)started. */
  readonly dirty: boolean;
  /** Saving was tried, so a missing name says so. */
  readonly tried: boolean;
  /** The categories to choose from: active ones, and the item's own even when archived. */
  readonly categories: readonly CategoryRow[];
  readonly category: CategoryRow | null;
  readonly fields: readonly CategoryField[];
  /** The item can list the phones it fits: it has no category, or its category has a phones field. */
  readonly hasPhones: boolean;
  /** The name is built from the fields. */
  readonly autoName: boolean;
  readonly builtName: string;
  readonly name: string;
  readonly nameMissing: boolean;
  /** Values in use for a field (or the tags), most used first. */
  readonly usedValues: (facet: string) => string[];
  readonly pickCategory: (categoryId: string | null) => void;
  /** Start typing the name, from what the format built. */
  readonly editName: () => void;
  readonly runner: ActionRunner;
  /**
   * Save; with `another`, stay on a fresh form that keeps the category, fields and phones, and
   * resolve the saved name for the notice. Resolves undefined when it was refused or incomplete.
   */
  readonly save: (
    another: boolean,
  ) => Promise<{ readonly itemId: string; readonly name: string } | undefined>;
}

export function useItemForm({
  part,
  categoryId: startCategory = null,
}: {
  /** The item being edited; absent to add one. */
  readonly part?: ItemDetailRow | undefined;
  /** For a new item: the category the list was showing, so it starts there. */
  readonly categoryId?: string | null | undefined;
}): ItemForm {
  const runtime = useInventoryRuntime();
  const runner = useActionRunner();
  const adding = part === undefined;
  const canCount = adding && runtime.hasPermission(INVENTORY_PERMISSION.count);
  const [draft, setDraft] = useState<ItemDraft>(() => draftOf(part, startCategory));
  // What the form was when it (re)started, so what "Tambah lagi" keeps is nothing to discard.
  const [base, setBase] = useState<ItemDraft>(draft);
  const [stock, setStock] = useState(0);
  const [tried, setTried] = useState(false);
  const addedRef = useRef<{ readonly itemId: string; readonly saved: string } | null>(null);
  const set = (patch: Partial<ItemDraft>): void =>
    setDraft((current) => ({ ...current, ...patch }));

  // An archived category stays listed only for an item already in it.
  const categoryList = useInventoryQuery<readonly CategoryRow[]>(
    async (rt) => (await rt.query('listCategories', { includeArchived: true })).rows,
    'itemFormCategories',
  );
  // Field ids belong to their category, so its fields offer what its own items hold; tags are the
  // whole list's. Read apart from the categories so picking one never blanks the form.
  const facetList = useInventoryQuery<readonly FacetValueRow[]>(
    async (rt) => [
      ...(draft.categoryId === null
        ? []
        : (await rt.query('facetValues', { categoryId: draft.categoryId })).rows.filter(
            (row) => row.facet !== TAG_FACET,
          )),
      ...(await rt.query('facetValues', {})).rows.filter((row) => row.facet === TAG_FACET),
    ],
    `itemFormFacets:${draft.categoryId ?? ''}`,
  );
  const loadedCategories = categoryList.status === 'ready' ? categoryList.data : [];
  const facets = facetList.status === 'ready' ? facetList.data : [];
  const categories = loadedCategories.filter(
    (category) => !category.archived || category.id === draft.categoryId,
  );
  const category = categories.find((c) => c.id === draft.categoryId) ?? null;
  const fields = category?.fields ?? [];
  const hasPhones = category === null || fields.some((field) => field.kind === 'phones');
  const autoName = category !== null && draft.nameAuto;
  const builtName = category === null ? '' : formatItemName(category, draft.values, draft.fits);
  const name = autoName ? builtName : draft.name.trim();
  const nameMissing = name === '';

  const save: ItemForm['save'] = async (another) => {
    setTried(true);
    if (nameMissing) return undefined;
    const details = {
      name: autoName ? '' : draft.name,
      nameAuto: autoName,
      code: draft.code === '' ? null : draft.code,
      barcode: draft.barcode === '' ? null : draft.barcode,
      categoryId: draft.categoryId,
      values: Object.fromEntries(Object.entries(draft.values).map(([id, v]) => [id, [...v]])),
      tags: [...draft.tags],
      fits: hasPhones ? [...draft.fits] : [],
    };
    const result = await runner.run(async () => {
      if (part !== undefined) {
        await runtime.run('editItem', { itemId: part.id, archived: part.archived, ...details });
        return { itemId: part.id };
      }
      // Kept, so a retry after the count failed saves the count, not a second copy of the item;
      // details changed before the retry go on as an edit.
      const saved = JSON.stringify(details);
      if (addedRef.current === null) {
        const { itemId } = await runtime.run('addItem', details);
        addedRef.current = { itemId, saved };
      } else if (addedRef.current.saved !== saved) {
        await runtime.run('editItem', {
          itemId: addedRef.current.itemId,
          archived: false,
          ...details,
        });
        addedRef.current = { itemId: addedRef.current.itemId, saved };
      }
      const { itemId } = addedRef.current;
      if (stock > 0) await runtime.run('countStock', { counts: [{ itemId, counted: stock }] });
      return { itemId };
    });
    if (result === undefined) return undefined;
    if (another) {
      // Items often come in a run (one phone's LCD, battery, connector; one LCD in three
      // qualities): the category, fields and phones stay, and the next one changes what differs.
      addedRef.current = null;
      const next: ItemDraft = { ...draft, name: '', code: '', barcode: '' };
      setDraft(next);
      setBase(next);
      setStock(0);
      setTried(false);
    }
    return { itemId: result.itemId, name };
  };

  return {
    adding,
    draft,
    set,
    stock,
    setStock,
    canCount,
    dirty: JSON.stringify(draft) !== JSON.stringify(base) || stock !== 0,
    tried,
    categories,
    category,
    fields,
    hasPhones,
    autoName,
    builtName,
    name,
    nameMissing,
    usedValues: (facet) => facets.filter((row) => row.facet === facet).map((row) => row.value),
    // Values of the old category's fields go; a typed name stays typed.
    pickCategory: (id) =>
      set({ categoryId: id, values: {}, nameAuto: draft.nameAuto || draft.name.trim() === '' }),
    editName: () => set({ nameAuto: false, name: builtName }),
    runner,
    save,
  };
}
