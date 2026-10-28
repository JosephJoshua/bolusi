/**
 * An `InventoryRuntime` over in-memory demo parts for the browser preview, built by the repair demo
 * so a part taken on a demo servisan comes off the same shelf the parts list shows. Mirrors the
 * real rules (rules.ts and repair/part-use.ts) closely enough that a reviewer sees the same refusals.
 */
import { DomainError, FuzzyIndex } from '@bolusi/core';

import { INVENTORY_PERMISSION, type MovementKind } from './constants.js';
import { compactModel } from '../shared/model-key.js';
import { fitsLine } from './applier.js';
import type { MovementRow, ItemDetailRow, ItemFitRow, ItemRow, UsedPartRow } from './queries.js';
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

interface DemoPart {
  id: string;
  name: string;
  code: string | null;
  models: ItemFitRow[];
  archived: boolean;
}

/** "Samsung Galaxy A14; Samsung Galaxy A14 5G": brand, then model, models apart by ";". */
function models(spec: string | null): ItemFitRow[] {
  if (spec === null) return [];
  return spec.split(';').map((one) => {
    const [brand = '', ...model] = one.trim().split(' ');
    return { brand, model: model.join(' ') };
  });
}

/** A store's shelf: screens, batteries and small parts, with a couple below zero to sort out. */
const SEED: readonly (readonly [string, string | null, string | null, number])[] = [
  ['LCD Samsung A14 + frame', 'LCD-A14', 'Samsung Galaxy A14; Samsung Galaxy A14 5G', 3],
  ['LCD Redmi Note 10 + frame', 'LCD-RN10', 'Xiaomi Redmi Note 10; Xiaomi Redmi Note 10S', 2],
  ['LCD iPhone 11', 'LCD-IP11', 'Apple iPhone 11', 1],
  ['LCD Oppo A16', null, 'Oppo A16; Oppo A16s', 0],
  ['LCD Oppo A57 + frame', 'LCD-A57', 'Oppo A57; Oppo A57s', 2],
  ['Konektor cas Oppo A57', null, 'Oppo A57; Oppo A77', 5],
  ['LCD Vivo Y20', 'LCD-Y20', 'vivo Y20; vivo Y20s; vivo Y12s', 4],
  ['Baterai Samsung A10s', 'BAT-A10S', 'Samsung Galaxy A10s; Samsung Galaxy A20s', 6],
  ['Baterai iPhone 11', 'BAT-IP11', 'Apple iPhone 11', -1],
  ['Baterai Redmi 9', 'BN54', 'Xiaomi Redmi 9; Xiaomi Redmi Note 9', 5],
  ['Konektor cas Type-C', null, null, 24],
  ['Konektor cas micro USB', null, null, 15],
  ['Flexible on/off Oppo A5s', null, 'Oppo A5s; Oppo A7; Oppo A12', 2],
  ['Speaker buzzer Samsung A-series', null, 'Samsung Galaxy A10; Samsung Galaxy A20', 7],
  ['Kaca kamera belakang iPhone XR', null, 'Apple iPhone XR', 3],
  ['Tempered glass 9D (pak 10)', 'TG-9D', null, 12],
  ['Lem B7000 15 ml', null, null, -2],
  ['Backdoor Redmi Note 8', null, 'Xiaomi Redmi Note 8', 1],
];

export function demoInventoryRuntime(options: DemoInventoryOptions): InventoryRuntime {
  const { now, actor, checkUse } = options;
  let ids = 0;
  const newId = (prefix: string): string => `${prefix}-${String((ids += 1))}`;
  const parts: DemoPart[] = [];
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

  for (const [name, code, fits, stock] of SEED) {
    const id = newId('part');
    parts.push({ id, name, code, models: models(fits), archived: false });
    if (stock !== 0) record(id, 'counted', stock, { counted: stock, at: now - 86_400_000 });
  }
  parts.push({
    id: newId('part'),
    name: 'LCD Nokia 2.3',
    code: null,
    models: models('Nokia 2.3'),
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
  const row = ({ models: fits, ...part }: DemoPart): ItemRow => ({
    ...part,
    fits: fitsLine(fits),
    onHand: onHand(part.id),
  });
  const find = (itemId: string): DemoPart => {
    const part = parts.find((p) => p.id === itemId);
    if (part === undefined)
      throw INVENTORY_REFUSALS.refuse('itemNotFound', { code: 'ENTITY_NOT_FOUND' });
    return part;
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

  type Input = Record<string, unknown>;
  const page = <T>(rows: readonly T[], nextCursor: string | null = null) => ({ rows, nextCursor });

  const queries: Record<string, (input: Input) => unknown> = {
    listItems: (input) => {
      const text = String(input['text'] ?? '').trim();
      const filter = (input['filter'] as string | undefined) ?? 'active';
      const limit = Number(input['limit'] ?? 50);
      const offset = Number(input['offset'] ?? 0);
      const shown = parts
        .map(row)
        .filter((p) => (filter === 'archived' ? p.archived : !p.archived))
        .filter((p) => filter !== 'belowZero' || p.onHand < 0);
      // The same typo-tolerant search the app runs, best match first.
      const matching =
        text === ''
          ? shown.sort((a, b) => a.name.localeCompare(b.name))
          : new FuzzyIndex(shown.map(itemDocument))
              .search(text, shown.length)
              .map((hit) => shown.find((p) => p.id === hit.id)!);
      const more = matching.length > offset + limit;
      return page(matching.slice(offset, offset + limit), more ? String(offset + limit) : null);
    },
    countBelowZero: () =>
      page([{ count: parts.filter((p) => !p.archived && onHand(p.id) < 0).length }]),
    getItem: (input) => {
      const part = parts.find((p) => p.id === input['itemId']);
      if (part === undefined) return page([]);
      const detail: ItemDetailRow = {
        ...row(part),
        models: part.models,
        movements: newestFirst(movements.filter((m) => m.itemId === part.id)).slice(0, 100),
      };
      return page([detail]);
    },
    itemsFitting: (input) => {
      const key = compactModel(String(input['brand'] ?? ''), String(input['model']));
      const modelKey = compactModel(String(input['model']));
      const fitting = parts
        .filter((p) => !p.archived)
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
          const part = find(itemId);
          return {
            itemId,
            name: part.name,
            code: part.code,
            out: outOn(itemId, useId),
            onHand: onHand(itemId),
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      return page([{ parts: used, movements: onUse }]);
    },
  };

  const details = (input: Input) => ({
    name: String(input['name']).trim(),
    code: ((input['code'] as string | null | undefined) ?? '').trim() || null,
    models: [...((input['fits'] as ItemFitRow[] | undefined) ?? [])],
  });
  const use = (input: Input) => input['use'] as { kind: string; id: string; label: string };

  const commands: Record<string, (input: Input) => unknown> = {
    addItem: (input) => {
      require(I.manageItems);
      const id = newId('part');
      parts.push({ id, ...details(input), archived: false });
      return { itemId: id };
    },
    editItem: (input) => {
      require(I.manageItems);
      const part = find(String(input['itemId']));
      Object.assign(part, details(input), { archived: input['archived'] === true });
      return { itemId: part.id };
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
      const part = find(String(input['itemId']));
      if (part.archived) throw INVENTORY_REFUSALS.refuse('itemArchived');
      const target = use(input);
      checkUse(target.id, who);
      return {
        movementId: record(part.id, 'taken', -Number(input['qty']), {
          useKind: 'repair_ticket',
          useId: target.id,
          useLabel: target.label,
        }),
      };
    },
    putBackPart: (input) => {
      const who = require(I.useParts);
      const part = find(String(input['itemId']));
      const target = use(input);
      checkUse(target.id, who);
      if (Number(input['qty']) > outOn(part.id, target.id)) {
        throw INVENTORY_REFUSALS.refuse('moreThanTaken', { code: 'VALIDATION_FAILED' });
      }
      return {
        movementId: record(part.id, 'put_back', Number(input['qty']), {
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
    newId: () => newId('new'),
    subscribe: options.subscribe,
    searchModels: options.searchModels,
  };
  return runtime as unknown as InventoryRuntime;
}
