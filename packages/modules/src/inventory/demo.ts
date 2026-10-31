/**
 * An `InventoryRuntime` over in-memory demo items for the browser preview, built by the repair demo
 * so a part taken on a demo servisan comes off the same shelf the list shows. Mirrors the real
 * rules (rules.ts, commands.ts and repair/part-use.ts) closely enough that a reviewer sees the same
 * names, filters and refusals.
 */
import { DomainError, FuzzyIndex } from '@bolusi/core';

import {
  categoryProblem,
  cleanTags,
  cleanValues,
  formatItemName,
  valueKey,
  type CategoryField,
  type FieldValues,
} from './categories.js';
import { INVENTORY_PERMISSION, TAG_FACET, type MovementKind } from './constants.js';
import { compactModel } from '../shared/model-key.js';
import { fitsLine } from './applier.js';
import type {
  CategoryRow,
  FacetValueRow,
  ItemDetailRow,
  ItemFitRow,
  ItemRow,
  MovementRow,
  UsedPartRow,
} from './queries.js';
import type { InventoryRuntime } from './runtime.js';
import { INVENTORY_REFUSALS } from './rules.js';
import { itemDocument } from './search.js';

const I = INVENTORY_PERMISSION;

export interface DemoInventoryActor {
  readonly userId: string;
  readonly name: string;
  readonly permissions: readonly string[];
}

export interface DemoInventoryOptions {
  readonly now: number;
  /** Who is acting now (the preview can switch user). */
  readonly actor: () => DemoInventoryActor;
  /** The demo's say over a use, as repair's rule: throws when parts may not move; else its label. */
  readonly checkUse: (useId: string, actor: DemoInventoryActor) => string;
  readonly subscribe: (listener: () => void) => () => void;
  readonly notify: () => void;
  /** The demo phone catalog, as the intake searches it. */
  readonly searchModels?: InventoryRuntime['searchModels'];
}

const DEMO_SCANNED_CODE = '6941059648208';

interface DemoItem {
  id: string;
  name: string;
  nameAuto: boolean;
  code: string | null;
  barcode: string | null;
  categoryId: string | null;
  values: FieldValues;
  tags: string[];
  models: ItemFitRow[];
  archived: boolean;
}

/** "Samsung Galaxy A14; Samsung Galaxy A14 5G": brand, then model, models apart by ";". */
function phones(spec: string): ItemFitRow[] {
  if (spec === '') return [];
  return spec.split(';').map((one) => {
    const [brand = '', ...model] = one.trim().split(' ');
    return { brand, model: model.join(' ') };
  });
}

const field = (
  id: string,
  label: string,
  kind: CategoryField['kind'],
  options: string[] = [],
): CategoryField => ({ id, label, kind, options });

/** A franchise's categories: spareparts with the fields their names are built from, and goods. */
const CATEGORIES: readonly Omit<CategoryRow, 'archived'>[] = [
  {
    id: 'cat-lcd',
    name: 'LCD',
    isPart: true,
    fields: [
      field('hp', 'HP', 'phones'),
      field('q', 'Kualitas', 'one', ['Original', 'OEM', 'KW']),
      field('x', 'Tambahan', 'many', ['+ frame', '+ touchscreen', '+ backdoor']),
    ],
    nameFormat: 'LCD {HP} {Kualitas} {Tambahan}',
  },
  {
    id: 'cat-bat',
    name: 'Baterai',
    isPart: true,
    fields: [
      field('hp', 'HP', 'phones'),
      field('q', 'Kualitas', 'one', ['Original', 'Double power']),
    ],
    nameFormat: 'Baterai {HP} {Kualitas}',
  },
  {
    id: 'cat-con',
    name: 'Konektor cas',
    isPart: true,
    fields: [
      field('hp', 'HP', 'phones'),
      field('t', 'Jenis', 'one', ['Type-C', 'Micro USB', 'Lightning']),
    ],
    nameFormat: 'Konektor cas {Jenis} {HP}',
  },
  {
    id: 'cat-tg',
    name: 'Tempered glass',
    isPart: false,
    fields: [
      field('hp', 'HP', 'phones'),
      field('t', 'Jenis', 'one', ['9D', 'Privacy', 'Anti-glare']),
    ],
    nameFormat: 'Tempered glass {Jenis} {HP}',
  },
  {
    id: 'cat-chg',
    name: 'Charger',
    isPart: false,
    fields: [
      field('m', 'Merek', 'one', ['Samsung', 'Xiaomi', 'Oppo', 'Robot']),
      field('w', 'Watt', 'one', ['10W', '18W', '33W', '65W']),
      field('k', 'Kabel', 'one', ['Type-C', 'Micro USB', 'Lightning']),
    ],
    nameFormat: 'Charger {Merek} {Watt} {Kabel}',
  },
];

interface Seed {
  readonly category: string | null;
  readonly values?: Record<string, string[]>;
  readonly phones?: string;
  /** A typed name; without it the category's format names the item. */
  readonly name?: string;
  readonly code?: string;
  readonly barcode?: string;
  readonly tags?: string[];
  readonly stock: number;
}

/** A store's shelf: screens, batteries, small parts and goods, a couple below zero to sort out. */
const SEED: readonly Seed[] = [
  {
    category: 'cat-lcd',
    phones: 'Samsung Galaxy A14; Samsung Galaxy A14 5G',
    values: { q: ['Original'], x: ['+ frame'] },
    code: 'LCD-A14',
    tags: ['Laris'],
    stock: 3,
  },
  { category: 'cat-lcd', phones: 'Samsung Galaxy A14', values: { q: ['KW'] }, stock: 4 },
  {
    category: 'cat-lcd',
    phones: 'Xiaomi Redmi Note 10; Xiaomi Redmi Note 10S',
    values: { q: ['OEM'], x: ['+ frame'] },
    code: 'LCD-RN10',
    stock: 2,
  },
  { category: 'cat-lcd', phones: 'Apple iPhone 11', values: { q: ['OEM'] }, stock: 1 },
  { category: 'cat-lcd', phones: 'Oppo A16; Oppo A16s', values: { q: ['KW'] }, stock: 0 },
  {
    category: 'cat-lcd',
    phones: 'Oppo A57; Oppo A57s',
    values: { q: ['Original'], x: ['+ frame'] },
    tags: ['Laris'],
    stock: 2,
  },
  {
    category: 'cat-lcd',
    phones: 'vivo Y20; vivo Y20s; vivo Y12s',
    values: { q: ['OEM'], x: ['+ touchscreen'] },
    stock: 4,
  },
  {
    category: 'cat-bat',
    phones: 'Samsung Galaxy A10s; Samsung Galaxy A20s',
    values: { q: ['Original'] },
    code: 'BAT-A10S',
    stock: 6,
  },
  { category: 'cat-bat', phones: 'Apple iPhone 11', values: { q: ['Double power'] }, stock: -1 },
  {
    category: 'cat-bat',
    phones: 'Xiaomi Redmi 9; Xiaomi Redmi Note 9',
    values: { q: ['Original'] },
    code: 'BN54',
    barcode: '6941059648208',
    stock: 5,
  },
  { category: 'cat-con', phones: 'Oppo A57; Oppo A77', values: { t: ['Type-C'] }, stock: 5 },
  {
    category: 'cat-con',
    name: 'Konektor cas Type-C universal',
    values: { t: ['Type-C'] },
    tags: ['Laris'],
    stock: 24,
  },
  {
    category: 'cat-con',
    name: 'Konektor cas micro USB universal',
    values: { t: ['Micro USB'] },
    stock: 15,
  },
  {
    category: null,
    name: 'Flexible on/off Oppo A5s',
    phones: 'Oppo A5s; Oppo A7; Oppo A12',
    stock: 2,
  },
  {
    category: null,
    name: 'Speaker buzzer Samsung A-series',
    phones: 'Samsung Galaxy A10; Samsung Galaxy A20',
    stock: 7,
  },
  { category: null, name: 'Kaca kamera belakang iPhone XR', phones: 'Apple iPhone XR', stock: 3 },
  { category: null, name: 'Lem B7000 15 ml', stock: -2 },
  { category: null, name: 'Backdoor Redmi Note 8', phones: 'Xiaomi Redmi Note 8', stock: 1 },
  {
    category: 'cat-tg',
    phones: 'Samsung Galaxy A14',
    values: { t: ['9D'] },
    barcode: '8992222053242',
    tags: ['Laris'],
    stock: 12,
  },
  { category: 'cat-tg', phones: 'Apple iPhone 11', values: { t: ['Privacy'] }, stock: 5 },
  {
    category: 'cat-chg',
    values: { m: ['Xiaomi'], w: ['33W'], k: ['Type-C'] },
    barcode: '6934177757420',
    stock: 3,
  },
  { category: 'cat-chg', values: { m: ['Robot'], w: ['10W'], k: ['Micro USB'] }, stock: 8 },
];

export function demoInventoryRuntime(options: DemoInventoryOptions): InventoryRuntime {
  const { now, actor, checkUse } = options;
  let ids = 0;
  const newId = (prefix: string): string => `${prefix}-${String((ids += 1))}`;
  const categories: CategoryRow[] = CATEGORIES.map((category) => ({
    ...category,
    archived: false,
  }));
  const items: DemoItem[] = [];
  const movements: (MovementRow & { at: number })[] = [];

  const record = (
    itemId: string,
    kind: MovementKind,
    qty: number,
    extra: Partial<MovementRow> = {},
  ): string => {
    const who = actor();
    const id = newId('mv');
    movements.push({
      id,
      itemId,
      kind,
      qty,
      counted: null,
      useKind: null,
      useId: null,
      useLabel: null,
      note: null,
      userId: who.userId,
      userName: who.name,
      at: now + movements.length,
      ...extra,
    });
    return id;
  };

  const categoryOf = (categoryId: string | null): CategoryRow | null =>
    categories.find((c) => c.id === categoryId) ?? null;
  const isPart = (item: DemoItem): boolean =>
    item.categoryId === null || categoryOf(item.categoryId)?.isPart === true;

  for (const seed of SEED) {
    const id = newId('item');
    const category = categoryOf(seed.category);
    const values = category === null ? {} : cleanValues(category.fields, seed.values ?? {});
    const models = phones(seed.phones ?? '');
    items.push({
      id,
      name: seed.name ?? formatItemName(category!, values, models),
      nameAuto: seed.name === undefined,
      code: seed.code ?? null,
      barcode: seed.barcode ?? null,
      categoryId: seed.category,
      values,
      tags: seed.tags ?? [],
      models,
      archived: false,
    });
    if (seed.stock !== 0) {
      record(id, 'counted', seed.stock, { counted: seed.stock, at: now - 86_400_000 });
    }
  }
  items.push({
    id: newId('item'),
    name: 'LCD Nokia 2.3',
    nameAuto: false,
    code: null,
    barcode: null,
    categoryId: 'cat-lcd',
    values: {},
    tags: [],
    models: phones('Nokia 2.3'),
    archived: true,
  });

  // As queries.ts: the latest count, plus what moved after it.
  const onHand = (itemId: string): number => {
    const own = movements.filter((m) => m.itemId === itemId);
    const counts = own.filter((m) => m.kind === 'counted').sort((a, b) => b.at - a.at);
    const last = counts[0];
    const after = own.filter((m) => m.kind !== 'counted' && (last === undefined || m.at > last.at));
    return (last?.counted ?? 0) + after.reduce((sum, m) => sum + m.qty, 0);
  };
  const row = (item: DemoItem): ItemRow => ({
    id: item.id,
    name: item.name,
    code: item.code,
    categoryId: item.categoryId,
    fits: fitsLine(item.models),
    archived: item.archived,
    onHand: onHand(item.id),
  });
  const find = (itemId: string): DemoItem => {
    const item = items.find((p) => p.id === itemId);
    if (item === undefined) {
      throw INVENTORY_REFUSALS.refuse('itemNotFound', { code: 'ENTITY_NOT_FOUND' });
    }
    return item;
  };
  const require = (permission: string): DemoInventoryActor => {
    const who = actor();
    if (!who.permissions.includes(permission)) {
      throw new DomainError('PERMISSION_DENIED', { permissionId: permission });
    }
    return who;
  };
  const outOn = (itemId: string, useId: string): number =>
    -movements
      .filter((m) => m.itemId === itemId && m.useId === useId)
      .reduce((sum, m) => sum + m.qty, 0);
  const newestFirst = (list: readonly MovementRow[]): MovementRow[] =>
    [...list].sort((a, b) => b.at - a.at);
  const has = (item: DemoItem, facet: string, wanted: readonly string[]): boolean => {
    const keys = new Set(wanted.map(valueKey));
    const values = facet === TAG_FACET ? item.tags : (item.values[facet] ?? []);
    return values.some((value) => keys.has(valueKey(value)));
  };

  type Input = Record<string, unknown>;
  const page = <T>(rows: readonly T[], nextCursor: string | null = null) => ({ rows, nextCursor });

  const queries: Record<string, (input: Input) => unknown> = {
    listItems: (input) => {
      const text = String(input['text'] ?? '').trim();
      const filter = (input['filter'] as string | undefined) ?? 'active';
      const categoryId = (input['categoryId'] as string | null | undefined) ?? null;
      const tags = (input['tags'] as string[] | undefined) ?? [];
      const values = (input['values'] as Record<string, string[]> | undefined) ?? {};
      const limit = Number(input['limit'] ?? 50);
      const offset = Number(input['offset'] ?? 0);
      const inCategory = (item: DemoItem): boolean =>
        categoryId === null ||
        (categoryId === 'none' ? item.categoryId === null : item.categoryId === categoryId);
      const shown = items
        .filter((p) => (filter === 'archived' ? p.archived : !p.archived))
        .filter(inCategory)
        .filter((p) => input['partsOnly'] !== true || isPart(p))
        .filter((p) => tags.every((tag) => has(p, TAG_FACET, [tag])))
        .filter((p) =>
          Object.entries(values).every(
            ([facet, wanted]) => wanted.length === 0 || has(p, facet, wanted),
          ),
        )
        .map((p) => ({ item: p, row: row(p) }))
        .filter(({ row: r }) => filter !== 'belowZero' || r.onHand < 0)
        .filter(({ row: r }) => filter !== 'outOfStock' || r.onHand <= 0);
      // The same typo-tolerant search the app runs, best match first.
      const matching =
        text === ''
          ? shown.map(({ row: r }) => r).sort((a, b) => a.name.localeCompare(b.name))
          : new FuzzyIndex(
              shown.map(({ item, row: r }) =>
                itemDocument({ ...r, barcode: item.barcode, values: item.values, tags: item.tags }),
              ),
            )
              .search(text, shown.length)
              .map((hit) => shown.find(({ row: r }) => r.id === hit.id)!.row);
      const more = matching.length > offset + limit;
      return page(matching.slice(offset, offset + limit), more ? String(offset + limit) : null);
    },
    countBelowZero: () =>
      page([{ count: items.filter((p) => !p.archived && onHand(p.id) < 0).length }]),
    getItem: (input) => {
      const item = items.find((p) => p.id === input['itemId']);
      if (item === undefined) return page([]);
      const detail: ItemDetailRow = {
        ...row(item),
        nameAuto: item.nameAuto,
        barcode: item.barcode,
        category: categoryOf(item.categoryId),
        values: item.values,
        tags: item.tags,
        models: item.models,
        movements: newestFirst(movements.filter((m) => m.itemId === item.id)).slice(0, 100),
      };
      return page([detail]);
    },
    itemsFitting: (input) => {
      const key = compactModel(String(input['brand'] ?? ''), String(input['model']));
      const modelKey = compactModel(String(input['model']));
      const fitting = items
        .filter((p) => !p.archived && isPart(p))
        .filter((p) =>
          p.models.some((m) => [key, modelKey].includes(compactModel(m.brand, m.model))),
        )
        .map(row)
        .sort((a, b) => a.name.localeCompare(b.name));
      return page(fitting);
    },
    partsForUse: (input) => {
      const useId = String(input['useId']);
      const onUse = newestFirst(movements.filter((m) => m.useId === useId));
      const used: UsedPartRow[] = [...new Set(onUse.map((m) => m.itemId))]
        .map((itemId) => {
          const item = find(itemId);
          return {
            itemId,
            name: item.name,
            code: item.code,
            out: outOn(itemId, useId),
            onHand: onHand(itemId),
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      return page([{ parts: used, movements: onUse }]);
    },
    listCategories: (input) =>
      page(
        categories
          .filter((c) => input['includeArchived'] === true || !c.archived)
          .sort((a, b) => a.name.localeCompare(b.name)),
      ),
    facetValues: (input) => {
      const categoryId = (input['categoryId'] as string | null | undefined) ?? null;
      const counts = new Map<string, FacetValueRow>();
      for (const item of items) {
        if (item.archived || (categoryId !== null && item.categoryId !== categoryId)) continue;
        const facets = [
          ...item.tags.map((value) => [TAG_FACET, value] as const),
          ...Object.entries(item.values).flatMap(([facet, values]) =>
            values.map((value) => [facet, value] as const),
          ),
        ];
        for (const [facet, value] of facets) {
          const key = `${facet}\u0000${valueKey(value)}`;
          const seen = counts.get(key);
          counts.set(key, { facet, value: seen?.value ?? value, count: (seen?.count ?? 0) + 1 });
        }
      }
      return page(
        [...counts.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
      );
    },
    findByCode: (input) => {
      const code = String(input['code']).replace(/\s+/g, '').toLowerCase();
      const same = (value: string | null): boolean =>
        value !== null && value.replace(/\s+/g, '').toLowerCase() === code;
      return page(items.filter((p) => same(p.barcode) || same(p.code)).map(row));
    },
  };

  const details = (input: Input) => {
    const categoryId = (input['categoryId'] as string | null | undefined) ?? null;
    const category = categoryOf(categoryId);
    const models = [...((input['fits'] as ItemFitRow[] | undefined) ?? [])];
    const values =
      category === null
        ? {}
        : cleanValues(category.fields, (input['values'] as FieldValues | undefined) ?? {});
    const nameAuto = input['nameAuto'] === true && category !== null;
    const name = nameAuto
      ? formatItemName(category, values, models)
      : String(input['name'] ?? '').trim();
    if (name === '') throw new DomainError('VALIDATION_FAILED', { field: 'name', issue: 'empty' });
    return {
      name,
      nameAuto,
      code: ((input['code'] as string | null | undefined) ?? '').trim() || null,
      barcode: ((input['barcode'] as string | null | undefined) ?? '').trim() || null,
      categoryId,
      values,
      tags: cleanTags((input['tags'] as string[] | undefined) ?? []),
      models,
    };
  };
  const categoryDetails = (input: Input) => {
    const shape = {
      name: String(input['name']).trim(),
      isPart: input['isPart'] === true,
      fields: input['fields'] as CategoryField[],
      nameFormat: String(input['nameFormat']).trim(),
    };
    const problem = categoryProblem(shape);
    if (problem !== null) {
      throw INVENTORY_REFUSALS.refuse('categoryInvalid', {
        code: 'VALIDATION_FAILED',
        details: { field: 'fields', issue: problem },
      });
    }
    return shape;
  };
  const use = (input: Input) => input['use'] as { kind: string; id: string; label: string };

  const commands: Record<string, (input: Input) => unknown> = {
    addCategory: (input) => {
      require(I.manageCategories);
      const id = newId('cat');
      categories.push({ id, ...categoryDetails(input), archived: false });
      return { categoryId: id };
    },
    editCategory: (input) => {
      require(I.manageCategories);
      const category = categories.find((c) => c.id === input['categoryId']);
      if (category === undefined) {
        throw INVENTORY_REFUSALS.refuse('categoryNotFound', { code: 'ENTITY_NOT_FOUND' });
      }
      Object.assign(category, categoryDetails(input), { archived: input['archived'] === true });
      // As the command: its items named by the format follow the new one.
      let renamed = 0;
      for (const item of items.filter((p) => p.categoryId === category.id && p.nameAuto)) {
        const values = cleanValues(category.fields, item.values);
        const name = formatItemName(category, values, item.models);
        if (name !== '' && name !== item.name) renamed += 1;
        Object.assign(item, { values, name: name === '' ? item.name : name });
      }
      return { categoryId: category.id, renamed };
    },
    addItem: (input) => {
      require(I.manageItems);
      const id = newId('item');
      items.push({ id, ...details(input), archived: false });
      return { itemId: id };
    },
    editItem: (input) => {
      require(I.manageItems);
      const item = find(String(input['itemId']));
      Object.assign(item, details(input), { archived: input['archived'] === true });
      return { itemId: item.id };
    },
    countStock: (input) => {
      require(I.count);
      const counts = input['counts'] as readonly { itemId: string; counted: number }[];
      const movementIds = counts.map(({ itemId, counted }) =>
        record(find(itemId).id, 'counted', counted - onHand(itemId), {
          counted,
          note: (input['note'] as string | null | undefined) ?? null,
        }),
      );
      return { movementIds };
    },
    takePart: (input) => {
      const who = require(I.useParts);
      const item = find(String(input['itemId']));
      if (item.archived) throw INVENTORY_REFUSALS.refuse('itemArchived');
      const target = use(input);
      checkUse(target.id, who);
      return {
        movementId: record(item.id, 'taken', -Number(input['qty']), {
          useKind: 'repair_ticket',
          useId: target.id,
          useLabel: target.label,
        }),
      };
    },
    putBackPart: (input) => {
      const who = require(I.useParts);
      const item = find(String(input['itemId']));
      const target = use(input);
      checkUse(target.id, who);
      if (Number(input['qty']) > outOn(item.id, target.id)) {
        throw INVENTORY_REFUSALS.refuse('moreThanTaken', { code: 'VALIDATION_FAILED' });
      }
      return {
        movementId: record(item.id, 'put_back', Number(input['qty']), {
          useKind: 'repair_ticket',
          useId: target.id,
          useLabel: target.label,
        }),
      };
    },
  };

  const runtime = {
    get userId() {
      return actor().userId;
    },
    query: (name: string, input: Input) => {
      try {
        require(I.read);
        return Promise.resolve(queries[name]!(input));
      } catch (error) {
        return Promise.reject(error);
      }
    },
    run: (name: string, input: Input) => {
      try {
        const result = commands[name]!(input);
        options.notify();
        return Promise.resolve(result);
      } catch (error) {
        return Promise.reject(error);
      }
    },
    hasPermission: (id: string) => actor().permissions.includes(id),
    colleagueHasPermission: () => false,
    limitOf: (id: string) => (actor().permissions.includes(id) ? null : 0),
    newId: () => newId('new'),
    subscribe: options.subscribe,
    searchModels: options.searchModels,
    // The preview has no camera: a scan reads the Redmi 9 battery's barcode, so the flow can be tried.
    scanCode: () => Promise.resolve(DEMO_SCANNED_CODE),
  };
  return runtime as unknown as InventoryRuntime;
}
