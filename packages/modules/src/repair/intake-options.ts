// The lists the counter picks from at intake, which the owner edits (product-scope.md, "Configurable
// intake lists"): condition checks, accessories left with the phone, intake photo angles, one-tap
// brands, ready-by choices and repair types ("Jenis servis", each with its warranty). The owner keeps one list of each for the whole franchise; a store
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
  'repairTypes',
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
  /** A repair type's warranty in days from pickup (0: none). Repair types only. */
  readonly warrantyDays?: number | undefined;
  /** A repair type the counter films the customer's ownership statement for. Repair types only. */
  readonly needsVideo?: boolean | undefined;
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

/**
 * Repair types offered by default, with their usual warranty: parts replaced get a month, a fix
 * without new parts two weeks, software a week; water damage and unlocking carry none. Unlocking
 * is where a stolen phone turns up, so the customer says on video that it is theirs.
 */
export const REPAIR_TYPES = [
  { id: 'screen', warrantyDays: 30, needsVideo: false },
  { id: 'battery', warrantyDays: 30, needsVideo: false },
  { id: 'chargingPort', warrantyDays: 30, needsVideo: false },
  { id: 'camera', warrantyDays: 30, needsVideo: false },
  { id: 'audio', warrantyDays: 30, needsVideo: false },
  { id: 'buttons', warrantyDays: 30, needsVideo: false },
  { id: 'noPower', warrantyDays: 14, needsVideo: false },
  { id: 'software', warrantyDays: 7, needsVideo: false },
  { id: 'waterDamage', warrantyDays: 0, needsVideo: false },
  { id: 'unlock', warrantyDays: 0, needsVideo: true },
] as const;
export type RepairTypeId = (typeof REPAIR_TYPES)[number]['id'];
export const MAX_WARRANTY_DAYS = 365;

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
  repairTypes: REPAIR_TYPES.map((type) => type.id),
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
  repairTypes: REPAIR_TYPES.map((type) => ({ ...type, label: null })),
};

export const NOTHING_HIDDEN: IntakeOptionSettings['hidden'] = {
  checks: [],
  accessories: [],
  photoAngles: [],
  brands: [],
  readyBy: [],
  repairTypes: [],
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
    repairTypes: pick('repairTypes'),
  };
}

/** What would be wrong with saving `items` as `list`. Empty means it can be saved. */
export type IntakeOptionProblem =
  | 'emptyLabel'
  | 'labelTooLong'
  | 'duplicate'
  | 'tooMany'
  | 'empty'
  | 'notBuiltIn'
  | 'badReadyBy'
  | 'badWarranty';

/** Whether `item` carries a repair type's terms exactly when `list` is the repair types. */
function termsFit(list: IntakeOptionList, item: IntakeOption): boolean {
  if (list !== 'repairTypes')
    return item.warrantyDays === undefined && item.needsVideo === undefined;
  const days = item.warrantyDays;
  return (
    days !== undefined &&
    Number.isInteger(days) &&
    days >= 0 &&
    days <= MAX_WARRANTY_DAYS &&
    typeof item.needsVideo === 'boolean'
  );
}

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
    if (!termsFit(list, item)) problems.add('badWarranty');
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

/** Two lists are the same when they hold the same items, named and set the same, in one order. */
export function sameOptions(a: readonly IntakeOption[], b: readonly IntakeOption[]): boolean {
  return (
    a.length === b.length &&
    a.every((item, i) => {
      const other = b[i]!;
      return (
        item.id === other.id &&
        item.label === other.label &&
        item.warrantyDays === other.warrantyDays &&
        item.needsVideo === other.needsVideo
      );
    })
  );
}

/** A repair type as a servisan recorded it: the name it showed and its terms then. */
export interface RecordedRepairType {
  readonly item: string;
  readonly label: string | null;
  readonly warrantyDays: number;
  readonly needsVideo: boolean;
}

/**
 * The repair types picked by id, as a servisan records them. A type the servisan already has keeps
 * the terms it was given, so the owner changing a warranty later never changes one already promised;
 * a new one takes its terms from `offered` (the owner's list now). Returns the first id that is
 * neither, so the caller can refuse it.
 */
export function recordRepairTypes(
  ids: readonly string[],
  offered: readonly IntakeOption[],
  kept: readonly RecordedRepairType[] = [],
): { readonly types: RecordedRepairType[] } | { readonly unknown: string } {
  const types: RecordedRepairType[] = [];
  for (const id of ids) {
    const recorded = kept.find((type) => type.item === id);
    if (recorded !== undefined) {
      types.push(recorded);
      continue;
    }
    const option = offered.find((item) => item.id === id);
    if (option === undefined) return { unknown: id };
    types.push({
      item: option.id,
      label: option.label,
      warrantyDays: option.warrantyDays ?? 0,
      needsVideo: option.needsVideo ?? false,
    });
  }
  return { types };
}

const DAY_MS = 86_400_000;

/**
 * When a repair type's warranty ends: its days after the phone went home (owner decision: warranty
 * counts from pickup). Null without a warranty, or while the phone is still in the store.
 */
export function warrantyEnds(
  type: Pick<RecordedRepairType, 'warrantyDays'>,
  returnedAt: number | null,
): number | null {
  return type.warrantyDays === 0 || returnedAt === null
    ? null
    : returnedAt + type.warrantyDays * DAY_MS;
}

/** Whether two recorded lists are the same types in the same order. */
export function sameRepairTypes(
  a: readonly RecordedRepairType[],
  b: readonly RecordedRepairType[],
): boolean {
  return a.length === b.length && a.every((type, i) => type.item === b[i]!.item);
}

/**
 * The repair types a servisan can be changed to: the store's list, then any it already has that the
 * list no longer offers (renamed, hidden or removed since), so they can be kept or taken off.
 */
export function repairTypeChoices(
  offered: readonly IntakeOption[],
  recorded: readonly RecordedRepairType[],
): IntakeOption[] {
  const ids = new Set(offered.map((option) => option.id));
  const kept = recorded
    .filter((type) => !ids.has(type.item))
    .map((type) => ({
      id: type.item,
      label: type.label,
      warrantyDays: type.warrantyDays,
      needsVideo: type.needsVideo,
    }));
  return [...offered, ...kept];
}
