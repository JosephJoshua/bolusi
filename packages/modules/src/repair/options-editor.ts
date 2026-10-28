// The owner's editor for one intake list (screens/IntakeOptionsScreen.tsx), as pure state: rows in
// order, each with the name being typed and whether this store hides it, and what saving them means.
// Platform-free so a desktop or web editor reuses it.
import {
  NON_EMPTY_LISTS,
  READY_UNKNOWN,
  intakeListProblems,
  readyId,
  sameOptions,
  sortReadyOptions,
  type IntakeOption,
  type IntakeOptionList,
  type IntakeOptionSettings,
} from './intake-options.js';

export interface EditorRow {
  /** Stable React key: the option id, or a local one for a row added here. */
  readonly key: string;
  /** Null for a row added in this editor; the command mints its id. */
  readonly id: string | null;
  /** What the name field holds. For a ready-by row added here, the number of days typed. */
  readonly text: string;
  /** This store does not offer it. */
  readonly hidden: boolean;
  /** A repair type's warranty days as typed; empty on other lists. */
  readonly warranty: string;
  /** A repair type that needs an ownership video; false on other lists. */
  readonly needsVideo: boolean;
}

export interface EditorState {
  readonly list: IntakeOptionList;
  readonly rows: readonly EditorRow[];
  /** Rows added so far, for their local keys. */
  readonly added: number;
}

/** An option's built-in app name, or null when it has none (the screen binds the catalogs). */
export type BuiltInName = (option: IntakeOption) => string | null;

export function editorFor(
  list: IntakeOptionList,
  settings: IntakeOptionSettings,
  builtInName: BuiltInName,
): EditorState {
  const hidden = new Set(settings.hidden[list]);
  return {
    list,
    added: 0,
    rows: settings.lists[list].map((option) => ({
      key: option.id,
      id: option.id,
      text: option.label ?? builtInName(option) ?? option.id,
      hidden: hidden.has(option.id),
      warranty: option.warrantyDays === undefined ? '' : String(option.warrantyDays),
      needsVideo: option.needsVideo ?? false,
    })),
  };
}

/** Add an empty row at the end; returns the new state and the row's key (to focus it). */
export function addRow(state: EditorState): { state: EditorState; key: string } {
  const key = `new-${state.added + 1}`;
  return {
    key,
    state: {
      ...state,
      added: state.added + 1,
      rows: [
        ...state.rows,
        { key, id: null, text: '', hidden: false, warranty: '', needsVideo: false },
      ],
    },
  };
}

export function updateRow(state: EditorState, key: string, patch: Partial<EditorRow>): EditorState {
  return {
    ...state,
    rows: state.rows.map((row) => (row.key === key ? { ...row, ...patch } : row)),
  };
}

export function removeRow(state: EditorState, key: string): EditorState {
  return { ...state, rows: state.rows.filter((row) => row.key !== key) };
}

/** Move the row at `from` to `to` (indices into the rows); an index past either end does nothing. */
export function moveRow(state: EditorState, from: number, to: number): EditorState {
  const count = state.rows.length;
  if (from === to || from < 0 || to < 0 || from >= count || to >= count) return state;
  const rows = [...state.rows];
  const [row] = rows.splice(from, 1);
  rows.splice(to, 0, row!);
  return { ...state, rows };
}

/**
 * The option a row saves as. A built-in item whose name was left as the app's keeps a null label,
 * so it still reads in either language; anything else typed is the owner's label. A ready-by row's
 * id is its days, so a row typed as something other than whole days gets an id the rules refuse.
 */
function optionOf(list: IntakeOptionList, row: EditorRow, builtInName: BuiltInName): IntakeOption {
  const named = namedOption(list, row, builtInName);
  if (list !== 'repairTypes') return named;
  // Typed as anything but whole days, the warranty is one the rules refuse.
  const warranty = row.warranty.trim();
  const days = /^[0-9]{1,3}$/.test(warranty) ? Number(warranty) : -1;
  return { ...named, warrantyDays: days, needsVideo: row.needsVideo };
}

function namedOption(
  list: IntakeOptionList,
  row: EditorRow,
  builtInName: BuiltInName,
): IntakeOption {
  if (list === 'readyBy') {
    if (row.id !== null) return { id: row.id, label: null };
    const text = row.text.trim();
    if (text === READY_UNKNOWN) return { id: READY_UNKNOWN, label: null };
    const days = /^[0-9]+$/.test(text) ? Number(text) : NaN;
    return { id: Number.isSafeInteger(days) ? readyId(days) : '', label: null };
  }
  const text = row.text.trim();
  if (row.id !== null && builtInName({ id: row.id, label: null }) === text) {
    return { id: row.id, label: null };
  }
  return { id: row.id ?? row.key, label: text };
}

/** Why a row cannot be saved, shown under it. */
export type RowProblem = 'emptyLabel' | 'labelTooLong' | 'duplicate' | 'badReadyBy' | 'badWarranty';

/** Why the list as a whole cannot be saved, shown above the save button. */
export type ListProblem = 'empty' | 'tooMany' | 'hidesAll';

export interface EditorProblems {
  readonly rows: ReadonlyMap<string, RowProblem>;
  readonly list: readonly ListProblem[];
}

/** The same rules the command applies (`intakeListProblems`), pinned to the rows they concern. */
export function editorProblems(
  state: EditorState,
  builtInName: BuiltInName,
  nameOf: (option: IntakeOption) => string,
): EditorProblems {
  const rows = new Map<string, RowProblem>();
  const seen = new Set<string>();
  for (const row of state.rows) {
    const option = optionOf(state.list, row, builtInName);
    const own = intakeListProblems(state.list, [option], nameOf).find(
      (p): p is RowProblem =>
        p === 'emptyLabel' || p === 'labelTooLong' || p === 'badReadyBy' || p === 'badWarranty',
    );
    if (own !== undefined) {
      rows.set(row.key, own);
      continue;
    }
    // The later of two rows with one name is the one to fix.
    const name = nameOf(option).trim().toLocaleLowerCase('id');
    if (seen.has(name)) rows.set(row.key, 'duplicate');
    seen.add(name);
  }
  const list: ListProblem[] = intakeListProblems(
    state.list,
    state.rows.map((row) => optionOf(state.list, row, builtInName)),
    nameOf,
  ).filter((p): p is 'empty' | 'tooMany' => p === 'empty' || p === 'tooMany');
  if (hidesEverything(state)) list.push('hidesAll');
  return { rows, list };
}

export function hasProblems(problems: EditorProblems): boolean {
  return problems.rows.size > 0 || problems.list.length > 0;
}

/**
 * A list the intake cannot do without, with every saved item hidden at this store. Rows added here
 * do not count: they cannot be shown or hidden until saved.
 */
function hidesEverything(state: EditorState): boolean {
  const saved = state.rows.filter((row) => row.id !== null);
  return NON_EMPTY_LISTS.has(state.list) && saved.length > 0 && saved.every((row) => row.hidden);
}

/** The `changeIntakeOptions` items, or null when the franchise list is unchanged. */
export function changedItems(
  state: EditorState,
  saved: readonly IntakeOption[],
  builtInName: BuiltInName,
): (Omit<IntakeOption, 'id'> & { id: string | null })[] | null {
  if (state.list === 'readyBy') {
    // Ready-by choices read soonest first whatever order they were added in.
    const items = sortReadyOptions(state.rows.map((row) => optionOf('readyBy', row, builtInName)));
    return sameOptions(items, saved) ? null : items;
  }
  const items = state.rows.map((row) => {
    const option = optionOf(state.list, row, builtInName);
    return { ...option, id: row.id === null ? null : option.id };
  });
  const unchanged =
    items.every((item) => item.id !== null) &&
    sameOptions(
      items.map((item) => ({ ...item, id: item.id! })),
      saved,
    );
  return unchanged ? null : items;
}

/** The ids this store hides, or null when unchanged. */
export function changedHidden(state: EditorState, saved: readonly string[]): string[] | null {
  const hidden = state.rows.flatMap((row) => (row.hidden && row.id !== null ? [row.id] : []));
  const same = hidden.length === saved.length && hidden.every((id) => saved.includes(id));
  return same ? null : hidden;
}
