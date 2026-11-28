// Adding or editing a category on the phone and the PC: its name, whether its items are spareparts,
// the fields its items fill in and the name format built from them (owner decision, 2026-10-28).
// A new category's format follows its name and fields until the owner edits it; relabelling a field
// carries its `{token}` along, and removing one takes it out. The screens only lay this out.
import { useState } from 'react';

import { useActionRunner, type ActionRunner } from '../screen-kit/index.js';

import {
  defaultNameFormat,
  dropToken,
  formatItemName,
  formatTokens,
  renameToken,
  valueKey,
  type CategoryField,
} from './categories.js';
import type { FieldKind } from './constants.js';
import { ti, type InventoryKey } from './i18n.js';
import type { CategoryRow } from './queries.js';
import { useInventoryRuntime } from './runtime.js';

/** How each kind of field is named to the owner. */
export const FIELD_KIND_KEY: Readonly<Record<FieldKind, InventoryKey>> = {
  one: 'inventory.category.kind.one',
  many: 'inventory.category.kind.many',
  text: 'inventory.category.kind.text',
  phones: 'inventory.category.kind.phones',
};

export interface CategoryDraft {
  readonly name: string;
  readonly isPart: boolean;
  readonly fields: readonly CategoryField[];
  readonly nameFormat: string;
  /** False while a new category's format still follows its name and fields by itself. */
  readonly formatTouched: boolean;
  /** Each field's label as the format names it, so relabelling a field renames its token. */
  readonly formatLabels: Readonly<Record<string, string>>;
}

function draftOf(category: CategoryRow | undefined): CategoryDraft {
  return {
    name: category?.name ?? '',
    isPart: category?.isPart ?? true,
    fields: category?.fields ?? [],
    nameFormat: category?.nameFormat ?? '',
    formatTouched: category !== undefined,
    formatLabels: Object.fromEntries((category?.fields ?? []).map((f) => [f.id, f.label])),
  };
}

/** The format as it stands: a new category's follows its name and fields until edited. */
export const formatOf = (draft: CategoryDraft): string =>
  draft.formatTouched
    ? draft.nameFormat
    : defaultNameFormat(
        draft.name,
        draft.fields.filter((f) => f.label.trim() !== ''),
      );

/** A field id the editor mints; never shown, kept across relabels. */
const newFieldId = (): string =>
  `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export interface CategoryProblems {
  readonly name: InventoryKey | null;
  readonly fields: ReadonlyMap<string, InventoryKey>;
  readonly list: readonly string[];
  readonly format: string | null;
}

export function categoryProblems(draft: CategoryDraft): CategoryProblems {
  const fields = new Map<string, InventoryKey>();
  const seen = new Set<string>();
  for (const field of draft.fields) {
    const key = valueKey(field.label);
    if (key === '') fields.set(field.id, 'inventory.category.problem.labelEmpty');
    else if (seen.has(key)) fields.set(field.id, 'inventory.category.problem.labelTwice');
    seen.add(key);
  }
  const list: string[] = [];
  if (draft.fields.filter((f) => f.kind === 'phones').length > 1) {
    list.push(ti('inventory.category.problem.phonesTwice'));
  }
  const format = formatOf(draft).trim();
  const unknown = formatTokens(format).find((token) => !seen.has(valueKey(token)));
  return {
    name: draft.name.trim() === '' ? 'inventory.category.nameRequired' : null,
    fields,
    list,
    format:
      format === ''
        ? ti('inventory.category.problem.formatEmpty')
        : unknown !== undefined
          ? ti('inventory.category.problem.formatUnknown', { label: unknown })
          : null,
  };
}

/** What the example name fills each field with: its first choice, a sample phone, or its label. */
export function exampleName(draft: CategoryDraft): string {
  const values = Object.fromEntries(
    draft.fields.filter((f) => f.kind !== 'phones').map((f) => [f.id, [f.options[0] ?? f.label]]),
  );
  return formatItemName({ fields: draft.fields, nameFormat: formatOf(draft) }, values, [
    { brand: 'Samsung', model: 'Galaxy A14' },
  ]);
}

/** The first thing to fix, in the order the form shows them: the screen brings it into sight. */
export type CategoryProblemAt =
  | { readonly at: 'name' }
  | { readonly at: 'field'; readonly field: string }
  | { readonly at: 'list' }
  | { readonly at: 'format' };

export type CategorySaveOutcome =
  | ({ readonly status: 'blocked' } & CategoryProblemAt)
  | { readonly status: 'saved'; readonly notice: string | null }
  | { readonly status: 'refused' };

export interface CategoryForm {
  readonly adding: boolean;
  readonly draft: CategoryDraft;
  readonly format: string;
  readonly dirty: boolean;
  /** Saving was tried, so problems are shown. */
  readonly tried: boolean;
  readonly problems: CategoryProblems;
  readonly blocked: boolean;
  /** The format filled in with sample values, or empty. */
  readonly example: string;
  readonly runner: ActionRunner;
  readonly set: (patch: Partial<Pick<CategoryDraft, 'name' | 'isPart'>>) => void;
  readonly setFormat: (format: string) => void;
  readonly updateField: (id: string, patch: Partial<Omit<CategoryField, 'id'>>) => void;
  /** Adds an empty field and says its id, for the screen to open it. */
  readonly addField: () => string;
  readonly removeField: (id: string) => void;
  readonly moveField: (from: number, to: number) => void;
  /** Adds `{Label}` to the end of the format. */
  readonly addToken: (label: string) => void;
  /** Save as it stands; an unchanged category saves as done, with nothing to say. */
  readonly save: () => Promise<CategorySaveOutcome>;
  /** Archive or bring back the category being edited, with whatever else changed. */
  readonly setArchived: (archived: boolean) => Promise<CategorySaveOutcome>;
}

export function useCategoryForm(category: CategoryRow | undefined): CategoryForm {
  const runtime = useInventoryRuntime();
  const runner = useActionRunner();
  const [base] = useState(() => draftOf(category));
  const [draft, setDraft] = useState<CategoryDraft>(base);
  const [tried, setTried] = useState(false);
  // Fields added since saving was last tried: not marked until typed in or saving is tried again.
  const [untouched, setUntouched] = useState<ReadonlySet<string>>(new Set());

  const format = formatOf(draft);
  const dirty =
    draft.name !== base.name ||
    draft.isPart !== base.isPart ||
    JSON.stringify(draft.fields) !== JSON.stringify(base.fields) ||
    format !== formatOf(base);
  const found = categoryProblems(draft);
  const blocked =
    found.name !== null || found.fields.size > 0 || found.list.length > 0 || found.format !== null;
  const problems =
    untouched.size === 0
      ? found
      : { ...found, fields: new Map([...found.fields].filter(([id]) => !untouched.has(id))) };

  const updateField: CategoryForm['updateField'] = (id, patch) => {
    if (untouched.has(id)) setUntouched(new Set([...untouched].filter((u) => u !== id)));
    setDraft((current) => {
      const fields = current.fields.map((f) => (f.id === id ? { ...f, ...patch } : f));
      const label = patch.label?.trim();
      const was = current.formatLabels[id];
      // A relabel carries the field's token along, unless the new label clashes with another.
      if (label === undefined || was === undefined || label === '') return { ...current, fields };
      const clash = current.fields.some(
        (f) => f.id !== id && valueKey(f.label) === valueKey(label),
      );
      if (clash) return { ...current, fields };
      return {
        ...current,
        fields,
        nameFormat: renameToken(current.nameFormat, was, label),
        formatLabels: { ...current.formatLabels, [id]: label },
      };
    });
  };

  const addField = (): string => {
    const id = newFieldId();
    if (tried) setUntouched(new Set([...untouched, id]));
    setDraft((current) => ({
      ...current,
      fields: [...current.fields, { id, label: '', kind: 'one', options: [] }],
      formatLabels: { ...current.formatLabels, [id]: '' },
    }));
    return id;
  };

  const removeField = (id: string): void =>
    setDraft((current) => {
      const label = current.formatLabels[id];
      return {
        ...current,
        fields: current.fields.filter((f) => f.id !== id),
        nameFormat:
          label === undefined || label === ''
            ? current.nameFormat
            : dropToken(current.nameFormat, label),
        formatLabels: Object.fromEntries(
          Object.entries(current.formatLabels).filter(([fieldId]) => fieldId !== id),
        ),
      };
    });

  const moveField = (from: number, to: number): void =>
    setDraft((current) => {
      const fields = [...current.fields];
      const [moved] = fields.splice(from, 1);
      if (moved !== undefined) fields.splice(to, 0, moved);
      return { ...current, fields };
    });

  const shape = () => ({
    name: draft.name.trim(),
    isPart: draft.isPart,
    fields: draft.fields.map((f) => ({
      id: f.id,
      label: f.label.trim(),
      kind: f.kind,
      options: f.kind === 'one' || f.kind === 'many' ? [...f.options] : [],
    })),
    nameFormat: format.trim(),
  });

  const run = async (archived: boolean): Promise<CategorySaveOutcome> => {
    // Read before saving: a runtime may hand back the same row, already changed.
    const archiving = category !== undefined && archived !== category.archived;
    const renamed = await runner.run(async () => {
      if (category === undefined) {
        await runtime.run('addCategory', shape());
        return 0;
      }
      const result = await runtime.run('editCategory', {
        categoryId: category.id,
        archived,
        ...shape(),
      });
      return result.renamed;
    });
    if (renamed === undefined) return { status: 'refused' };
    // Archiving or restoring says so; an edit saved alongside it is part of the same step.
    return {
      status: 'saved',
      notice: archiving
        ? ti(archived ? 'inventory.category.archivedNotice' : 'inventory.category.restoredNotice')
        : renamed > 0
          ? ti('inventory.category.savedRenamed', { count: renamed })
          : ti('inventory.category.saved'),
    };
  };

  const check = (): CategorySaveOutcome | null => {
    setTried(true);
    setUntouched(new Set());
    if (!blocked) return null;
    const field = draft.fields.find((f) => found.fields.has(f.id))?.id;
    if (found.name !== null) return { status: 'blocked', at: 'name' };
    if (field !== undefined) return { status: 'blocked', at: 'field', field };
    if (found.list.length > 0) return { status: 'blocked', at: 'list' };
    return { status: 'blocked', at: 'format' };
  };

  return {
    adding: category === undefined,
    draft,
    format,
    dirty,
    tried,
    problems,
    blocked,
    example: exampleName(draft),
    runner,
    set: (patch) => setDraft((current) => ({ ...current, ...patch })),
    setFormat: (nameFormat) =>
      setDraft((current) => ({ ...current, nameFormat, formatTouched: true })),
    updateField,
    addField,
    removeField,
    moveField,
    addToken: (label) =>
      setDraft((current) => ({
        ...current,
        formatTouched: true,
        nameFormat: `${formatOf(current)} {${label.trim()}}`.trim(),
      })),
    save: () => {
      const stop = check();
      if (stop !== null) return Promise.resolve(stop);
      if (category !== undefined && !dirty) {
        return Promise.resolve({ status: 'saved', notice: null });
      }
      return run(category?.archived ?? false);
    },
    setArchived: (archived) => {
      const stop = check();
      if (stop !== null) return Promise.resolve(stop);
      return run(archived);
    },
  };
}
