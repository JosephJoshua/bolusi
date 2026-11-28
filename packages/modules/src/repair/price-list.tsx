// The repair price list's rules for the screens, the same on the phone and the PC: who may change
// what, the repair types a row can be for, how a row reads, and the form that adds or changes one
// (its checks, the rows it would repeat, and saving the list's price and this store's together).
// Each app only draws them.
import { useMemo, useState } from 'react';

import { useActionRunner, useSettledValue, type ActionRunner } from '../screen-kit/index.js';

import { tn } from './i18n.js';
import { storeIntakeOptions } from './intake-options.js';
import { optionLabel } from './labels.js';
import { MAX_PRICE_QUALITY } from './operations.js';
import { catalogModelSearch } from './model-search.js';
import {
  priceAbilities,
  priceModelsText,
  priceTitle,
  priceTypeLabel,
  repeatedModels,
  type PriceAbilities,
  type PriceType,
} from './price-terms.js';
import { priceModelLabel, type PriceModel, type PriceRow } from './prices.queries.js';

export {
  priceAbilities,
  priceModelsText,
  priceTitle,
  priceTypeLabel,
  repeatedModels,
  sameQuality,
  type PriceAbilities,
  type PriceType,
} from './price-terms.js';
import { useIntakeOptionSettings, useRepairQuery, useRepairRuntime } from './runtime.js';
import type { ModelCatalog } from '../inventory/model-options.js';

/**
 * The repair types a price can be for: the owner's whole list when editing it (a type one store
 * hides is still quoted at the others), only this store's when reading it. A row for a type no
 * longer on the list keeps its id as its name, so it can still be found and removed.
 */
export function usePriceTypes(scope: 'business' | 'store'): readonly PriceType[] | null {
  const settings = useIntakeOptionSettings();
  return useMemo(() => {
    if (settings.status !== 'ready') return null;
    const types =
      scope === 'business'
        ? settings.data.lists.repairTypes
        : storeIntakeOptions(settings.data).repairTypes;
    return types.map((type) => ({ id: type.id, label: optionLabel('repairTypes', type) }));
  }, [settings, scope]);
}

/** The phone catalog a price row's phones are picked from: the intake's. */
export function useRepairCatalog(): ModelCatalog {
  const runtime = useRepairRuntime();
  return useMemo(() => ({ source: runtime, search: catalogModelSearch(runtime) }), [runtime]);
}

/** The qualities already on the list, most used first, then whatever the field holds. */
export function usePriceQualities(): readonly string[] {
  const found = useRepairQuery(
    async (rt) => (await rt.query('priceQualities', {})).rows.map((row) => row.quality),
    'priceQualities',
  );
  return found.status === 'ready' ? found.data : [];
}

// ── the form ───────────────────────────────────────────────────────────────────────────────────

export interface PriceDraft {
  readonly repairType: string;
  readonly models: readonly PriceModel[];
  readonly quality: string;
  /** 0 while nothing is typed. */
  readonly amount: number;
  /** This store's own price; null charges the list's. */
  readonly storeAmount: number | null;
}

export type PriceProblem = 'repairType' | 'models' | 'amount' | 'storeAmount' | 'repeated';

/** Where a new row starts: empty, or a copy of another for more phones ("Salin ke HP lain"). */
export type PriceStart =
  | { readonly kind: 'new' }
  | { readonly kind: 'edit'; readonly row: PriceRow }
  | { readonly kind: 'copy'; readonly row: PriceRow };

function draftFrom(start: PriceStart): PriceDraft {
  if (start.kind === 'new') {
    return { repairType: '', models: [], quality: '', amount: 0, storeAmount: null };
  }
  const { row } = start;
  return {
    repairType: row.repairType,
    models: start.kind === 'copy' ? [] : row.models,
    quality: row.quality,
    amount: row.listAmount,
    storeAmount: start.kind === 'copy' ? null : row.storeAmount,
  };
}

export interface PriceForm {
  readonly draft: PriceDraft;
  readonly set: (patch: Partial<PriceDraft>) => void;
  /** The row being changed; null while adding. */
  readonly row: PriceRow | null;
  readonly abilities: PriceAbilities;
  /** What blocks saving, once saving was tried (or a repeat, at once). */
  readonly problems: ReadonlySet<PriceProblem>;
  /** The phones another row already prices like this. */
  readonly repeated: readonly PriceModel[];
  readonly dirty: boolean;
  readonly runner: ActionRunner;
  /** Resolves the saved row's title once saved, undefined when it was not. */
  readonly save: (another?: boolean) => Promise<string | undefined>;
  readonly remove: () => Promise<boolean>;
}

export function usePriceForm(start: PriceStart, types: readonly PriceType[] | null): PriceForm {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const abilities = useMemo(() => priceAbilities(runtime.hasPermission), [runtime]);
  const row = start.kind === 'edit' ? start.row : null;
  const [initial, setInitial] = useState(() => draftFrom(start));
  const [draft, setDraft] = useState(initial);
  const [tried, setTried] = useState(false);

  // The rows already pricing these phones, to warn before a second price for the same repair.
  const settledModels = useSettledValue(draft.models);
  const others = useRepairQuery(
    async (rt) =>
      settledModels.length === 0 || draft.repairType === ''
        ? []
        : (
            await rt.query('pricesForModels', {
              models: settledModels.map(({ brand, model }) => ({ brand, model })),
              repairType: draft.repairType,
            })
          ).rows,
    `pricesForModels:${draft.repairType}:${settledModels.map(priceModelLabel).join('\u0000')}`,
  );
  const repeated = repeatedModels(
    draft,
    others.status === 'ready' ? others.data : [],
    row?.id ?? null,
  );

  const problems = new Set<PriceProblem>();
  if (repeated.length > 0) problems.add('repeated');
  if (tried) {
    if (draft.repairType === '') problems.add('repairType');
    if (draft.models.length === 0) problems.add('models');
    if (draft.amount <= 0) problems.add('amount');
    if (draft.storeAmount !== null && draft.storeAmount <= 0) problems.add('storeAmount');
  }
  const listChanged =
    draft.repairType !== initial.repairType ||
    draft.quality.trim() !== initial.quality.trim() ||
    draft.amount !== initial.amount ||
    priceModelsText(draft.models) !== priceModelsText(initial.models);
  const storeChanged = draft.storeAmount !== initial.storeAmount;
  const dirty = listChanged || storeChanged;

  const save = async (another = false): Promise<string | undefined> => {
    setTried(true);
    const blocked =
      repeated.length > 0 ||
      draft.repairType === '' ||
      draft.models.length === 0 ||
      draft.amount <= 0 ||
      (draft.storeAmount !== null && draft.storeAmount <= 0);
    if (blocked) return undefined;
    const title = priceTitle(priceTypeLabel(types, draft.repairType), draft.quality.trim());
    const saved = await runner.run(async () => {
      let priceId = row?.id;
      if (abilities.edit && (listChanged || row === null)) {
        const result = await runtime.run('savePrices', {
          rows: [
            {
              ...(priceId === undefined ? {} : { priceId }),
              repairType: draft.repairType,
              models: draft.models.map(({ brand, model }) => ({ brand, model })),
              quality: draft.quality.trim().slice(0, MAX_PRICE_QUALITY),
              amount: draft.amount,
            },
          ],
        });
        priceId = result.priceIds[0];
      }
      if (abilities.store && storeChanged && priceId !== undefined) {
        await runtime.run('setStorePrices', {
          prices: [{ priceId, amount: draft.storeAmount }],
        });
      }
      return true;
    });
    if (saved === undefined) return undefined;
    if (another) {
      // The next row of a run is usually the same repair on the same phones in another quality.
      const next: PriceDraft = { ...draft, quality: '', amount: 0, storeAmount: null };
      setInitial(next);
      setDraft(next);
      setTried(false);
    } else {
      setInitial(draft);
    }
    return title;
  };

  const remove = async (): Promise<boolean> => {
    if (row === null) return false;
    const done = await runner.run(() => runtime.run('removePrices', { priceIds: [row.id] }));
    if (done === undefined) return false;
    setInitial(draft);
    return true;
  };

  return {
    draft,
    set: (patch) => setDraft((current) => ({ ...current, ...patch })),
    row,
    abilities,
    problems,
    repeated,
    dirty,
    runner,
    save,
    remove,
  };
}

/** What a price problem says, under its field. */
export function priceProblemText(
  problem: PriceProblem,
  repeated: readonly PriceModel[] = [],
): string {
  switch (problem) {
    case 'repairType':
      return tn('repair.prices.problem.repairType');
    case 'models':
      return tn('repair.prices.problem.models');
    case 'amount':
    case 'storeAmount':
      return tn('repair.prices.problem.amount');
    case 'repeated':
      return tn('repair.prices.problem.repeated', { models: priceModelsText(repeated) });
  }
}
