// The lists the counter picks from at intake, which the owner edits (product-scope.md, "Configurable
// intake lists"): condition checks, accessories left with the phone, intake photo angles, one-tap
// brands and ready-by choices. The owner keeps one list of each for the whole franchise; a store
// hides the items it does not use. A ticket records the label it showed, so a later rename or
// removal never rewrites an old servisan.
//
// Platform-free and pure, so the command, the intake screens and the owner's editor share every rule.
import { INTAKE_PHOTO_SLOTS } from './constants.js';

export const INTAKE_OPTION_LISTS = [
  'checks',
  'accessories',
  'photoAngles',
  'brands',
  'readyBy',
] as const;
export type IntakeOptionList = (typeof INTAKE_OPTION_LISTS)[number];

/**
 * One item on a list. `id` is stable across renames (a store's hiding and a half-done intake follow
 * it); `label` is what the owner typed, or null for a built-in item that still has its app name,
 * which then reads in either language. Ready-by items are always null: their name is their days.
 */
export interface IntakeOption {
  readonly id: string;
  readonly label: string | null;
}

export type IntakeOptionLists = Readonly<Record<IntakeOptionList, readonly IntakeOption[]>>;

/** The franchise lists plus what this store hides, as the `intakeOptionSettings` query reads them. */
export interface IntakeOptionSettings {
  readonly lists: IntakeOptionLists;
  readonly hidden: Readonly<Record<IntakeOptionList, readonly string[]>>;
}

/** Condition checks offered by default, in the order a counter person tests them. */
export const INTAKE_CHECKS = [
  'screen',
  'touch',
  'camera',
  'speaker',
  'microphone',
  'charging',
  'buttons',
  'signal',
  'biometrics',
] as const;
export type IntakeCheck = (typeof INTAKE_CHECKS)[number];

/** Things customers commonly leave with the phone. */
export const PERIPHERALS = ['charger', 'cable', 'case', 'simCard', 'memoryCard', 'box'] as const;
export type Peripheral = (typeof PERIPHERALS)[number];

/** Brands the stores see most, offered as one-tap answers; any other brand is typed. */
export const COMMON_BRANDS = [
  'Samsung',
  'Oppo',
  'Vivo',
  'Xiaomi',
  'Realme',
  'Infinix',
  'iPhone',
] as const;

/** A ready-by choice's id is its number of days, or this for "not known yet". */
export const READY_UNKNOWN = 'unknown';
export const MAX_READY_DAYS = 60;
const READY_ID = /^(0|[1-9][0-9]?)$/;

/** Ids whose name the app's catalogs supply until the owner renames them. Brands are proper nouns. */
export const BUILT_IN_OPTION_IDS: Readonly<Record<IntakeOptionList, readonly string[]>> = {
  checks: INTAKE_CHECKS,
  accessories: PERIPHERALS,
  photoAngles: INTAKE_PHOTO_SLOTS,
  brands: [],
  readyBy: [],
};

/** The most an owner can put on one list: past this, the intake screen stops being quick. */
export const MAX_OPTIONS = 40;
export const MAX_LABEL = 60;

/** Lists the intake cannot do without: a ticket always has evidence photos and a ready-by answer. */
export const NON_EMPTY_LISTS: ReadonlySet<IntakeOptionList> = new Set(['photoAngles', 'readyBy']);

const builtIn = (id: string): IntakeOption => ({ id, label: null });

/** The lists before the owner first changes them: what intake offered when it was fixed in code. */
export const DEFAULT_INTAKE_OPTIONS: IntakeOptionLists = {
  checks: INTAKE_CHECKS.map(builtIn),
  accessories: PERIPHERALS.map(builtIn),
  photoAngles: INTAKE_PHOTO_SLOTS.map(builtIn),
  brands: COMMON_BRANDS.map((name) => ({ id: name.toLowerCase(), label: name })),
  readyBy: ['0', '1', '3', READY_UNKNOWN].map(builtIn),
};

export const NOTHING_HIDDEN: IntakeOptionSettings['hidden'] = {
  checks: [],
  accessories: [],
  photoAngles: [],
  brands: [],
  readyBy: [],
};

/** Days until a ready-by choice, or null for "not known yet" (and for anything unreadable). */
export function readyDays(id: string): number | null {
  return READY_ID.test(id) && Number(id) <= MAX_READY_DAYS ? Number(id) : null;
}

export function readyId(days: number | null): string {
  return days === null ? READY_UNKNOWN : String(days);
}

export function isReadyId(id: string): boolean {
  return id === READY_UNKNOWN || readyDays(id) !== null;
}

/** Ready-by choices read soonest first, with "not known yet" last. */
export function sortReadyOptions(items: readonly IntakeOption[]): IntakeOption[] {
  const rank = (item: IntakeOption): number => readyDays(item.id) ?? Number.MAX_SAFE_INTEGER;
  return [...items].sort((a, b) => rank(a) - rank(b));
}

/**
 * What the counter at this store is offered: the franchise list without the store's hidden items.
 * A store cannot hide its way to no photo angles or no ready-by choice; if hiding would leave one
 * of those empty (the owner removed the last visible item later), the whole list shows instead.
 */
export function storeIntakeOptions(settings: IntakeOptionSettings): IntakeOptionLists {
  const pick = (list: IntakeOptionList): readonly IntakeOption[] => {
    const hidden = new Set(settings.hidden[list]);
    const shown = settings.lists[list].filter((item) => !hidden.has(item.id));
    return shown.length === 0 && NON_EMPTY_LISTS.has(list) ? settings.lists[list] : shown;
  };
  return {
    checks: pick('checks'),
    accessories: pick('accessories'),
    photoAngles: pick('photoAngles'),
    brands: pick('brands'),
    readyBy: pick('readyBy'),
  };
}

/** What would be wrong with saving `items` as `list`. Empty means it can be saved. */
export type IntakeOptionProblem =
  'emptyLabel' | 'labelTooLong' | 'duplicate' | 'tooMany' | 'empty' | 'notBuiltIn' | 'badReadyBy';

/**
 * The rules a franchise list must meet, checked by the command and shown by the editor. `nameOf`
 * gives an item's visible name so duplicates are found as the owner reads them; the command passes
 * the stored label or id, the editor the translated name.
 */
export function intakeListProblems(
  list: IntakeOptionList,
  items: readonly IntakeOption[],
  nameOf: (item: IntakeOption) => string = (item) => item.label ?? item.id,
): IntakeOptionProblem[] {
  const problems = new Set<IntakeOptionProblem>();
  if (items.length > MAX_OPTIONS) problems.add('tooMany');
  if (items.length === 0 && NON_EMPTY_LISTS.has(list)) problems.add('empty');
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  for (const item of items) {
    if (list === 'readyBy') {
      if (item.label !== null || !isReadyId(item.id)) problems.add('badReadyBy');
    } else if (item.label === null) {
      if (!BUILT_IN_OPTION_IDS[list].includes(item.id)) problems.add('notBuiltIn');
    } else if (item.label.trim() === '') {
      problems.add('emptyLabel');
    } else if (item.label.trim().length > MAX_LABEL) {
      problems.add('labelTooLong');
    }
    const name = nameOf(item).trim().toLocaleLowerCase('id');
    if (seenIds.has(item.id) || (name !== '' && seenNames.has(name))) problems.add('duplicate');
    seenIds.add(item.id);
    seenNames.add(name);
  }
  return [...problems];
}

/** Two lists are the same when they hold the same items, named the same, in the same order. */
export function sameOptions(a: readonly IntakeOption[], b: readonly IntakeOption[]): boolean {
  return (
    a.length === b.length &&
    a.every((item, i) => item.id === b[i]!.id && item.label === b[i]!.label)
  );
}
