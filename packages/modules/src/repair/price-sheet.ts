// The PC's price sheet, row by row (platform-free, so each rule is tested on its own): what a row's
// cells say, read into a price row with what is wrong in which cell. A row is a repair type, the
// phones it covers (a comma-separated list, each matched to the phone catalog's spelling), a
// quality, the business's price, and this store's own price when it charges another.
import type { FitMatch } from '../inventory/bulk-entry.js';
import { splitList } from '../inventory/bulk-entry.js';
import { formatNumber } from '@bolusi/i18n';

import { compactModel } from '../shared/model-key.js';
import { parseRupiah } from '../shared/rupiah.js';

import { MAX_LINE_AMOUNT } from './constants.js';
import { tn } from './i18n.js';
import { MAX_PRICE_MODELS, MAX_PRICE_QUALITY } from './operations.js';
import type { PriceType } from './price-terms.js';
import { priceModelLabel, type PriceModel } from './prices.queries.js';

export const PRICE_COLUMNS = ['type', 'models', 'quality', 'amount', 'store'] as const;
export type PriceColumn = (typeof PRICE_COLUMNS)[number];

export interface SheetProblem {
  readonly tone: 'danger' | 'warning';
  readonly message: string;
}

/** A row of the sheet read into what it would save. */
export interface ReadPriceRow {
  /** Anything typed in the row. Empty rows are left out of a save. */
  readonly filled: boolean;
  readonly repairType: string | null;
  readonly models: readonly PriceModel[];
  readonly quality: string;
  /** 0 while nothing (or nothing readable) is typed. */
  readonly amount: number;
  /** This store's own price; null when it charges the list's. */
  readonly storeAmount: number | null;
  readonly problems: Readonly<Partial<Record<PriceColumn, SheetProblem>>>;
  readonly ready: boolean;
}

export interface PriceRowContext {
  readonly types: readonly PriceType[];
  /** The catalog's answer for one typed phone; undefined while it is still being looked up. */
  readonly fit: (typed: string) => FitMatch | undefined;
  /** The store column is on the sheet (the person sets this store's prices). */
  readonly storeColumn: boolean;
  /** Whether missing details are said: only once saving was tried, so a row being typed is calm. */
  readonly strict: boolean;
}

/** "450.000" for an amount in a cell, empty for none. */
export function amountCell(amount: number | null): string {
  return amount === null || amount === 0 ? '' : formatNumber(amount);
}

/** The repair type a cell names: by its name in any case, or by its id. */
export function typeFromCell(types: readonly PriceType[], text: string): PriceType | undefined {
  const key = text.trim().replace(/\s+/g, ' ').toLowerCase();
  if (key === '') return undefined;
  return types.find((type) => type.label.toLowerCase() === key || type.id.toLowerCase() === key);
}

const danger = (message: string): SheetProblem => ({ tone: 'danger', message });

/** An amount cell: digits with or without dots and "Rp", at most what a price line may carry. */
function readAmount(text: string): { readonly amount: number; readonly bad: boolean } {
  if (text.trim() === '') return { amount: 0, bad: false };
  const amount = parseRupiah(text, MAX_LINE_AMOUNT);
  return amount === null || amount <= 0 || /[^\d.,\sRrPp]/.test(text)
    ? { amount: 0, bad: true }
    : { amount, bad: false };
}

/** One row of the sheet read into a price row, with what is wrong in which cell. */
export function readPriceRow(
  cells: Readonly<Record<string, string>>,
  ctx: PriceRowContext,
): ReadPriceRow {
  const problems: Partial<Record<PriceColumn, SheetProblem>> = {};
  const text = (id: PriceColumn): string => (cells[id] ?? '').trim();
  const filled = PRICE_COLUMNS.some((id) => (id !== 'store' || ctx.storeColumn) && text(id) !== '');

  const typeText = text('type');
  const type = typeFromCell(ctx.types, typeText);
  if (typeText !== '' && type === undefined) {
    problems.type = danger(tn('repair.prices.sheet.unknownType', { type: typeText }));
  } else if (filled && type === undefined && ctx.strict) {
    problems.type = danger(tn('repair.prices.problem.repairType'));
  }

  // Phones: each matched to the catalog's spelling, else kept as typed and said so.
  const models: PriceModel[] = [];
  const unknown: string[] = [];
  let near: PriceModel | null = null;
  const seen = new Set<string>();
  for (const typed of splitList(text('models'))) {
    const match = ctx.fit(typed);
    const model = match?.exact ?? { brand: '', model: typed };
    const key = compactModel(model.brand, model.model);
    if (seen.has(key)) continue;
    seen.add(key);
    models.push(model);
    if (match !== undefined && match.exact === null) {
      unknown.push(typed);
      near ??= match.near;
    }
  }
  if (models.length > MAX_PRICE_MODELS) {
    problems.models = danger(tn('repair.prices.sheet.tooManyModels', { max: MAX_PRICE_MODELS }));
  } else if (models.some((m) => m.model.length > 200)) {
    problems.models = danger(tn('repair.prices.sheet.tooLong', { max: 200 }));
  } else if (filled && models.length === 0 && ctx.strict) {
    problems.models = danger(tn('repair.prices.problem.models'));
  } else if (unknown.length > 0) {
    problems.models = {
      tone: 'warning',
      message:
        near === null
          ? tn('repair.prices.sheet.phoneUnknown', { phones: unknown.join(', ') })
          : tn('repair.prices.sheet.phoneNear', {
              phones: unknown.join(', '),
              near: priceModelLabel(near),
            }),
    };
  }

  const quality = text('quality').replace(/\s+/g, ' ');
  if (quality.length > MAX_PRICE_QUALITY) {
    problems.quality = danger(tn('repair.prices.sheet.tooLong', { max: MAX_PRICE_QUALITY }));
  }

  const listed = readAmount(text('amount'));
  if (listed.bad) problems.amount = danger(tn('repair.prices.sheet.badAmount'));
  else if (filled && listed.amount === 0 && ctx.strict) {
    problems.amount = danger(tn('repair.prices.problem.amount'));
  }

  let storeAmount: number | null = null;
  if (ctx.storeColumn && text('store') !== '') {
    const own = readAmount(text('store'));
    if (own.bad) problems.store = danger(tn('repair.prices.sheet.badAmount'));
    else storeAmount = own.amount;
  }

  const ready =
    filled &&
    type !== undefined &&
    models.length > 0 &&
    listed.amount > 0 &&
    !Object.values(problems).some((p) => p.tone === 'danger');
  return {
    filled,
    repairType: type?.id ?? null,
    models,
    quality,
    amount: listed.amount,
    storeAmount,
    problems,
    ready,
  };
}

/** The cells a saved row shows on the sheet. */
export function priceCells(
  row: {
    readonly repairType: string;
    readonly models: readonly PriceModel[];
    readonly quality: string;
    readonly listAmount: number;
    readonly storeAmount: number | null;
  },
  types: readonly PriceType[],
): Record<PriceColumn, string> {
  return {
    type: types.find((type) => type.id === row.repairType)?.label ?? row.repairType,
    models: row.models.map(priceModelLabel).join(', '),
    quality: row.quality,
    amount: amountCell(row.listAmount),
    store: amountCell(row.storeAmount),
  };
}

/**
 * Rows of the sheet that price one phone twice for the same repair and quality: each such row's
 * id, with the phone and the other row's number (1-based) to point at.
 */
export function repeatedRows(
  rows: readonly {
    readonly id: string;
    readonly read: Pick<ReadPriceRow, 'repairType' | 'quality' | 'models'>;
  }[],
): Map<string, { readonly model: string; readonly row: number }> {
  const owner = new Map<string, number>();
  const found = new Map<string, { model: string; row: number }>();
  rows.forEach(({ id, read }, index) => {
    if (read.repairType === null) return;
    for (const model of read.models) {
      const key = `${read.repairType}\u0000${read.quality.toLowerCase()}\u0000${compactModel(
        model.brand,
        model.model,
      )}`;
      const first = owner.get(key);
      if (first === undefined) owner.set(key, index);
      else if (!found.has(id)) found.set(id, { model: priceModelLabel(model), row: first + 1 });
    }
  });
  return found;
}
