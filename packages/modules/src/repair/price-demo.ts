// The price list over the demo's memory, for the browser previews and the PC demo: the same rows,
// fuzzy search, exact phone match and store prices the device's queries give, over seeded rows of
// a real store's volume. Dev tooling only: no shipping screen imports it. Names here are seeded
// data, not interface copy.
import { FuzzyIndex } from '@bolusi/core';

import { catalogKeys } from './device-models.js';
import { priceDocument, type PriceModel, type PriceRow } from './prices.queries.js';
import { REPAIR_REFUSALS } from './rules.js';

type Input = Record<string, unknown>;
type Page<T> = Promise<{ rows: readonly T[]; nextCursor: string | null }>;

interface StoredPrice {
  readonly id: string;
  readonly repairType: string;
  readonly quality: string;
  readonly models: readonly PriceModel[];
  readonly amount: number;
  readonly updatedAt: number;
}

const m = (brand: string, ...models: string[]): PriceModel[] =>
  models.map((model) => ({ brand, model }));

/** A franchise's list: the phones that come in most, in each repair, at each part quality. */
function seedPrices(now: number): StoredPrice[] {
  const rows: [string, PriceModel[], string, number][] = [
    ['screen', m('Samsung', 'Galaxy A12', 'Galaxy A12s', 'Galaxy M12'), 'Ori', 450_000],
    ['screen', m('Samsung', 'Galaxy A12', 'Galaxy A12s', 'Galaxy M12'), 'KW', 275_000],
    ['screen', m('Samsung', 'Galaxy A14', 'Galaxy A14 5G'), 'Ori', 520_000],
    ['screen', m('Samsung', 'Galaxy A04', 'Galaxy A04s', 'Galaxy A04e'), 'Ori', 380_000],
    ['screen', m('Xiaomi', 'Redmi Note 10', 'Redmi Note 10S'), 'Ori', 650_000],
    ['screen', m('Xiaomi', 'Redmi Note 10', 'Redmi Note 10S'), 'KW', 350_000],
    ['screen', m('Xiaomi', 'Redmi 9A', 'Redmi 9C', 'Redmi 10A'), '', 250_000],
    ['screen', m('Oppo', 'A16', 'A16s', 'A16k', 'A54s'), 'Ori', 400_000],
    ['screen', m('Vivo', 'Y12', 'Y15', 'Y17', 'Y11'), '', 300_000],
    ['screen', m('Apple', 'iPhone 11'), 'Ori', 1_250_000],
    ['screen', m('Apple', 'iPhone 11'), 'OLED KW', 650_000],
    ['screen', m('Apple', 'iPhone XR'), '', 750_000],
    ['screen', m('Realme', 'C11', 'C12', 'C15', 'C25'), '', 320_000],
    ['battery', m('Samsung', 'Galaxy A12', 'Galaxy A02s', 'Galaxy A03s'), 'Ori', 225_000],
    ['battery', m('Xiaomi', 'Redmi Note 10', 'Redmi Note 10 Pro'), '', 175_000],
    ['battery', m('Xiaomi', 'Redmi 9A', 'Redmi 9C'), '', 150_000],
    ['battery', m('Oppo', 'A5s', 'A7', 'A12'), '', 160_000],
    ['battery', m('Apple', 'iPhone 11', 'iPhone XR'), 'Ori', 450_000],
    ['battery', m('Apple', 'iPhone 11', 'iPhone XR'), 'Kapasitas tinggi', 375_000],
    ['chargingPort', m('Samsung', 'Galaxy A12', 'Galaxy A13', 'Galaxy A14'), '', 125_000],
    ['chargingPort', m('Xiaomi', 'Redmi 9A', 'Redmi 9C', 'Redmi 10A', 'Redmi 10C'), '', 100_000],
    ['chargingPort', m('Vivo', 'Y12', 'Y15', 'Y17'), '', 100_000],
    ['camera', m('Samsung', 'Galaxy A12'), '', 200_000],
    ['camera', m('Apple', 'iPhone 11'), 'Belakang', 850_000],
    ['audio', m('Xiaomi', 'Redmi Note 10', 'Redmi 9A'), '', 90_000],
    ['buttons', m('Oppo', 'A16', 'A54s'), '', 85_000],
    ['software', m('Samsung', 'Galaxy A12', 'Galaxy A14', 'Galaxy A04'), '', 75_000],
    ['software', m('Xiaomi', 'Redmi Note 10', 'Redmi 9A', 'Redmi 10A'), '', 75_000],
    ['unlock', m('Apple', 'iPhone 11', 'iPhone XR', 'iPhone 12'), '', 350_000],
  ];
  return rows.map(([repairType, models, quality, amount], i) => ({
    id: `p-${String(i + 1)}`,
    repairType,
    quality,
    models,
    amount,
    updatedAt: now - (rows.length - i) * 3_600_000,
  }));
}

/** The demo's price list: its queries and commands, merged into the repair demo's. */
export function demoPrices({
  now,
  notify,
  typeOrder,
}: {
  readonly now: number;
  readonly notify: () => void;
  /** The business's repair types in its list's order, which the device's query sorts by. */
  readonly typeOrder: () => readonly string[];
}): {
  readonly queries: Record<string, (input: Input) => Page<unknown>>;
  readonly commands: Record<string, (input: Input) => unknown>;
} {
  let prices = seedPrices(now);
  // This store charges more for the iPhone screen than the list.
  const store = new Map<string, number>([['p-10', 1_350_000]]);
  let minted = 0;
  let index: { readonly of: readonly StoredPrice[]; readonly index: FuzzyIndex } | null = null;
  const search = (): FuzzyIndex => {
    if (index?.of !== prices)
      index = { of: prices, index: new FuzzyIndex(prices.map(priceDocument)) };
    return index.index;
  };
  const row = (p: StoredPrice): PriceRow => {
    const storeAmount = store.get(p.id) ?? null;
    return {
      id: p.id,
      repairType: p.repairType,
      quality: p.quality,
      models: p.models,
      listAmount: p.amount,
      storeAmount,
      amount: storeAmount ?? p.amount,
      updatedAt: p.updatedAt,
    };
  };
  const exists = (id: string): StoredPrice => {
    const found = prices.find((p) => p.id === id);
    if (found === undefined) throw REPAIR_REFUSALS.refuse('priceNotFound');
    return found;
  };
  const sorted = (rows: readonly StoredPrice[]): StoredPrice[] => {
    const order = typeOrder();
    const at = (type: string): number => {
      const i = order.indexOf(type);
      return i === -1 ? order.length : i;
    };
    return [...rows].sort(
      (a, b) =>
        at(a.repairType) - at(b.repairType) ||
        a.repairType.localeCompare(b.repairType) ||
        JSON.stringify(a.models)
          .toLowerCase()
          .localeCompare(JSON.stringify(b.models).toLowerCase()) ||
        a.quality.localeCompare(b.quality),
    );
  };

  return {
    queries: {
      priceList: (input) => {
        const text = String(input['text'] ?? '').trim();
        const type = (input['repairType'] as string | null | undefined) ?? null;
        const offset = Number(input['offset'] ?? 0);
        const limit = Number(input['limit'] ?? 50);
        const byId = new Map(prices.map((p) => [p.id, p]));
        const ordered =
          text === ''
            ? sorted(prices)
            : search()
                .search(text, prices.length)
                .map((hit) => byId.get(hit.id))
                .filter((p) => p !== undefined);
        const rows = ordered.filter((p) => type === null || p.repairType === type);
        return Promise.resolve({
          rows: rows.slice(offset, offset + limit).map(row),
          nextCursor: offset + limit < rows.length ? String(offset + limit) : null,
        });
      },
      priceQualities: () => {
        const counts = new Map<string, number>();
        for (const p of prices) {
          if (p.quality !== '') counts.set(p.quality, (counts.get(p.quality) ?? 0) + 1);
        }
        return Promise.resolve({
          rows: [...counts]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([quality, rows]) => ({ quality, rows })),
          nextCursor: null,
        });
      },
      pricesForModels: (input) => {
        const keysOf = (model: PriceModel) =>
          catalogKeys(model.brand, model.model).filter((k) => k !== '');
        const wanted = new Set((input['models'] as PriceModel[]).flatMap(keysOf));
        const type = (input['repairType'] as string | null | undefined) ?? null;
        return Promise.resolve({
          rows: prices
            .filter(
              (p) =>
                (type === null || p.repairType === type) &&
                p.models.some((model) => keysOf(model).some((k) => wanted.has(k))),
            )
            .map(row),
          nextCursor: null,
        });
      },
    },
    commands: {
      savePrices: (input) => {
        const saved = (
          input['rows'] as (Omit<StoredPrice, 'id' | 'updatedAt'> & {
            priceId?: string;
          })[]
        ).map((r) => {
          if (r.priceId !== undefined) exists(r.priceId);
          minted += 1;
          const id = r.priceId ?? `p-new-${String(minted)}`;
          return {
            id,
            repairType: r.repairType,
            quality: r.quality,
            models: r.models,
            amount: r.amount,
            updatedAt: now + minted,
          };
        });
        const ids = new Set(saved.map((p) => p.id));
        prices = [...prices.filter((p) => !ids.has(p.id)), ...saved];
        notify();
        return { priceIds: saved.map((p) => p.id) };
      },
      removePrices: (input) => {
        const ids = new Set(input['priceIds'] as string[]);
        for (const id of ids) exists(id);
        prices = prices.filter((p) => !ids.has(p.id));
        notify();
        return { priceIds: [...ids] };
      },
      setStorePrices: (input) => {
        for (const { priceId, amount } of input['prices'] as {
          priceId: string;
          amount: number | null;
        }[]) {
          exists(priceId);
          if (amount === null) store.delete(priceId);
          else store.set(priceId, amount);
        }
        notify();
        return {};
      },
    },
  };
}
