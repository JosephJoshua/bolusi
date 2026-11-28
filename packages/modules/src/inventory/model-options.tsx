// The phones a part fits, picked from the phone catalog the intake uses, on the phone and the PC:
// type a few letters, pick the model. A phone the catalog does not know can still be added as typed.
import { useLiveQuery, useSettledValue, type LiveSource } from '../screen-kit/index.js';
import { compactModel } from '../shared/model-key.js';

import { MAX_PART_FITS } from './constants.js';
import type { PhoneModelOption } from './model-option.js';
import type { ItemFitRow } from './queries.js';
import { useInventoryRuntime } from './runtime.js';

const SUGGESTIONS = 5;

export const fitKey = (fit: ItemFitRow): string => compactModel(fit.brand, fit.model);

/** "Samsung Galaxy A14", or the model alone when it was typed without a brand. */
export function fitLabel(fit: ItemFitRow): string {
  return `${fit.brand} ${fit.model}`.trim();
}

export interface ModelOptions {
  /** Catalog models matching the text, not yet picked. */
  readonly suggestions: readonly PhoneModelOption[];
  /** The text can be added as typed: the catalog has no such spelling and it is not picked yet. */
  readonly offerTyped: boolean;
  /** The catalog is reachable here (else only typed models can be added). */
  readonly hasCatalog: boolean;
  /** As many phones as one item may list. */
  readonly full: boolean;
  /** The suggestions answer the text as typed now, not text from a moment ago. */
  readonly current: boolean;
}

/** The phone catalog a picker searches, and the runtime whose changes re-run the search. */
export interface ModelCatalog {
  readonly source: LiveSource;
  /** Absent where the catalog cannot be reached: only typed models can be added then. */
  readonly search:
    ((text: string, limit: number) => Promise<readonly PhoneModelOption[]>) | undefined;
}

/** The parts list's catalog: the one its runtime was given. */
export function useInventoryCatalog(): ModelCatalog {
  const runtime = useInventoryRuntime();
  return { source: runtime, search: runtime.searchModels };
}

export function useModelOptions(
  catalog: ModelCatalog,
  text: string,
  value: readonly ItemFitRow[],
): ModelOptions {
  const { search } = catalog;
  const typed = text.trim();
  const settled = useSettledValue(typed);
  const searchText = typed === '' ? '' : settled;
  const found = useLiveQuery(
    catalog.source,
    async () =>
      searchText === '' || search === undefined
        ? []
        : search(searchText, SUGGESTIONS + value.length),
    `fitModels:${searchText}`,
  );
  const picked = new Set(value.map(fitKey));
  const suggestions = (found.status === 'ready' ? found.data : [])
    .filter((option) => !picked.has(fitKey(option)))
    .slice(0, SUGGESTIONS);
  const typedKey = compactModel(typed);
  return {
    suggestions,
    offerTyped:
      typed !== '' &&
      !picked.has(typedKey) &&
      !suggestions.some((option) =>
        [fitKey(option), compactModel(option.model)].includes(typedKey),
      ),
    hasCatalog: search !== undefined,
    full: value.length >= MAX_PART_FITS,
    current: settled === typed && found.status !== 'loading',
  };
}
