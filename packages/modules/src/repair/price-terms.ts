// The repair price list's plain rules, platform-free so the PC's sheet and the server's tests read
// them too: who may change what, how a row reads, and when two rows price one phone twice.
import { REPAIR_PERMISSION } from './constants.js';
import { priceModelLabel, type PriceModel, type PriceRow } from './prices.queries.js';
import { sameModelAnySpelling } from './device-models.js';

export interface PriceAbilities {
  /** Change the business's list (the main owner). */
  readonly edit: boolean;
  /** Set this store's own prices (store owners). */
  readonly store: boolean;
}

export function priceAbilities(hasPermission: (id: string) => boolean): PriceAbilities {
  return {
    edit: hasPermission(REPAIR_PERMISSION.managePrices),
    store: hasPermission(REPAIR_PERMISSION.setStorePrices),
  };
}

export interface PriceType {
  readonly id: string;
  readonly label: string;
}

/** A row's repair type by name, the id itself for a type taken off the list. */
export function priceTypeLabel(types: readonly PriceType[] | null, id: string): string {
  return types?.find((type) => type.id === id)?.label ?? id;
}

/** "Ganti LCD · Ori", or the type alone for a row with no quality. */
export function priceTitle(typeLabel: string, quality: string): string {
  return quality === '' ? typeLabel : `${typeLabel} · ${quality}`;
}

/** "Samsung Galaxy A12, Galaxy M12, Oppo A16": every phone, its brand once per run. */
export function priceModelsText(models: readonly PriceModel[]): string {
  // A brand is said once for its run of phones: "Samsung Galaxy A12, Galaxy A02s, Oppo A16".
  return models
    .map((model, i) =>
      i > 0 && model.brand !== '' && models[i - 1]!.brand === model.brand
        ? model.model
        : priceModelLabel(model),
    )
    .join(', ');
}

/** Two qualities are one when they differ only in case or spacing ("ori" and "Ori"). */
export function sameQuality(a: string, b: string): boolean {
  return (
    a.trim().replace(/\s+/g, ' ').toLowerCase() === b.trim().replace(/\s+/g, ' ').toLowerCase()
  );
}

/**
 * The phones of `models` another row already prices for the same type and quality: a phone with two
 * prices for one repair would leave the counter guessing which to quote.
 */
export function repeatedModels(
  draft: {
    readonly repairType: string;
    readonly quality: string;
    readonly models: readonly PriceModel[];
  },
  others: readonly PriceRow[],
  exceptId: string | null,
): PriceModel[] {
  // Any spelling of one phone ("Samsung A12", "Samsung Galaxy A12"), as the intake finds a row by.
  const taken = others
    .filter(
      (row) =>
        row.id !== exceptId &&
        row.repairType === draft.repairType &&
        sameQuality(row.quality, draft.quality),
    )
    .flatMap((row) => row.models);
  return draft.models.filter((m) => taken.some((t) => sameModelAnySpelling(m, t)));
}
