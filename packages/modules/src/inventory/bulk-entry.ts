// Entering a shelf of items in one sitting on the PC (owner decision, 2026-10-28): a sheet with one
// column per field of the chosen category, then the name, codes, labels and the stock on the shelf,
// filled by typing or by pasting from Excel. Each row reads into what `addItems` takes, with the
// name built by the category's format when the Nama cell is left empty, values spelled as the
// category already spells them, and the phones matched to the phone catalog. This file is the pure
// reading of a row; `useBulkEntry` keeps the sheet and saves it.
import { MAX_FIELD_VALUE, formatItemName, valueKey, type CategoryField } from './categories.js';
import {
  MAX_COUNTED_QTY,
  MAX_FIELD_OPTIONS,
  MAX_ITEM_TAGS,
  MAX_PART_FITS,
  TAG_FACET,
} from './constants.js';
import { ti } from './i18n.js';
import { MAX_BARCODE, MAX_PART_CODE, MAX_PART_NAME } from './operations.js';
import type { CategoryRow, ItemFitRow } from './queries.js';

export type BulkColumnKind = 'field' | 'fits' | 'name' | 'code' | 'barcode' | 'tags' | 'stock';

export interface BulkColumn {
  readonly id: string;
  readonly kind: BulkColumnKind;
  readonly label: string;
  /** Other headings a pasted sheet may use for it. */
  readonly aliases: readonly string[];
  /** For a field's column: the field. */
  readonly field?: CategoryField | undefined;
}

export const fieldColumnId = (field: CategoryField): string => `field.${field.id}`;

/**
 * The sheet's columns: the category's fields in its order (its phones field where the owner put
 * it), then the name, code, barcode, labels and, for whoever may count, the stock. Without a
 * category the name comes first and the phones follow it.
 */
export function bulkColumns(category: CategoryRow | null, canCount: boolean): BulkColumn[] {
  const name: BulkColumn = {
    id: 'name',
    kind: 'name',
    label: ti('inventory.bulk.col.name'),
    aliases: [ti('inventory.form.name'), ti('inventory.desk.col.name'), 'Nama', 'Name'],
  };
  const fits: BulkColumn = {
    id: 'fits',
    kind: 'fits',
    label: ti('inventory.bulk.col.fits'),
    aliases: [ti('inventory.form.fits'), 'HP', 'Tipe HP'],
  };
  const lead: BulkColumn[] =
    category === null
      ? [name, fits]
      : [
          ...category.fields.map((field): BulkColumn =>
            field.kind === 'phones'
              ? { ...fits, label: field.label, aliases: [...fits.aliases, fits.label], field }
              : { id: fieldColumnId(field), kind: 'field', label: field.label, aliases: [], field },
          ),
          name,
        ];
  return [
    ...lead,
    {
      id: 'code',
      kind: 'code',
      label: ti('inventory.bulk.col.code'),
      aliases: [ti('inventory.form.code'), 'SKU'],
    },
    {
      id: 'barcode',
      kind: 'barcode',
      label: ti('inventory.bulk.col.barcode'),
      aliases: [ti('inventory.form.barcode')],
    },
    {
      id: 'tags',
      kind: 'tags',
      label: ti('inventory.bulk.col.tags'),
      aliases: [ti('inventory.form.tags'), 'Tag', 'Tags'],
    },
    ...(canCount
      ? [
          {
            id: 'stock',
            kind: 'stock' as const,
            label: ti('inventory.bulk.col.stock'),
            aliases: [ti('inventory.form.stock'), 'Qty', 'Jumlah'],
          },
        ]
      : []),
  ];
}

/** A list in one cell: items between commas or semicolons, blanks dropped. */
export function splitList(text: string): string[] {
  return text
    .split(/[,;]/)
    .map((item) => item.trim().replace(/\s+/g, ' '))
    .filter((item) => item !== '');
}

/** What the phone catalog says about one phone typed in a cell. */
export interface FitMatch {
  /** The catalog's model, when it has this one under the same spelling. */
  readonly exact: ItemFitRow | null;
  /** Its closest model otherwise, to suggest. */
  readonly near: ItemFitRow | null;
}

export interface CellProblem {
  readonly tone: 'danger' | 'warning';
  readonly message: string;
}

export interface ItemToAdd {
  readonly name: string;
  readonly nameAuto: boolean;
  readonly code: string | null;
  readonly barcode: string | null;
  readonly categoryId: string | null;
  readonly values: Record<string, string[]>;
  readonly tags: string[];
  readonly fits: ItemFitRow[];
  readonly counted: number;
}

export interface ReadRow {
  /** Anything typed in the row. Empty rows are left out of a save. */
  readonly filled: boolean;
  readonly item: ItemToAdd;
  /** The name the format builds from the row, shown in an empty Nama cell. */
  readonly builtName: string;
  /** By column id. A `danger` one keeps the row from being saved. */
  readonly problems: Readonly<Record<string, CellProblem>>;
  readonly ready: boolean;
}

export interface RowContext {
  readonly category: CategoryRow | null;
  readonly columns: readonly BulkColumn[];
  /** The spelling already used for a field's value (`one`/`many`) or a label, if any. */
  readonly spelling: (facet: string, value: string) => string | undefined;
  /** The catalog's answer for one typed phone; undefined while it is still being looked up. */
  readonly fit: (typed: string) => FitMatch | undefined;
  /** Whether missing details are said: only once saving was tried, so a row being typed is calm. */
  readonly strict: boolean;
}

const tooLong = (max: number): CellProblem => ({
  tone: 'danger',
  message: ti('inventory.bulk.problem.tooLong', { max }),
});

/** One row of the sheet read into an item, with what is wrong in which cell. */
export function readRow(cells: Readonly<Record<string, string>>, ctx: RowContext): ReadRow {
  const problems: Record<string, CellProblem> = {};
  const text = (id: string): string => (cells[id] ?? '').trim();
  const filled = ctx.columns.some((column) => text(column.id) !== '');
  const values: Record<string, string[]> = {};
  const spell = (facet: string, value: string): string => ctx.spelling(facet, value) ?? value;

  for (const column of ctx.columns) {
    const field = column.field;
    if (column.kind !== 'field' || field === undefined) continue;
    const raw = text(column.id);
    if (raw === '') continue;
    const list = field.kind === 'many' ? splitList(raw) : [raw.replace(/\s+/g, ' ')];
    if (list.some((value) => value.length > MAX_FIELD_VALUE)) {
      problems[column.id] = tooLong(MAX_FIELD_VALUE);
    } else if (list.length > MAX_FIELD_OPTIONS) {
      problems[column.id] = {
        tone: 'danger',
        message: ti('inventory.bulk.problem.tooMany', { max: MAX_FIELD_OPTIONS }),
      };
    }
    const seen = new Set<string>();
    values[field.id] = list
      .map((value) => (field.kind === 'text' ? value : spell(field.id, value)))
      .filter((value) => {
        const key = valueKey(value);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  // Phones: each matched to the catalog's spelling, else kept as typed and said so.
  const fitsText = text('fits');
  const fitsColumn = ctx.columns.some((column) => column.kind === 'fits');
  const fits: ItemFitRow[] = [];
  const unknown: string[] = [];
  let near: ItemFitRow | null = null;
  if (fitsColumn && fitsText !== '') {
    const seen = new Set<string>();
    for (const typed of splitList(fitsText)) {
      const match = ctx.fit(typed);
      const fit = match?.exact ?? { brand: '', model: typed };
      const key = valueKey(`${fit.brand} ${fit.model}`);
      if (seen.has(key)) continue;
      seen.add(key);
      fits.push(fit);
      if (match !== undefined && match.exact === null) {
        unknown.push(typed);
        near ??= match.near;
      }
    }
    if (fits.length > MAX_PART_FITS) {
      problems['fits'] = {
        tone: 'danger',
        message: ti('inventory.bulk.problem.tooMany', { max: MAX_PART_FITS }),
      };
    } else if (unknown.length > 0) {
      problems['fits'] = {
        tone: 'warning',
        message:
          near === null
            ? ti('inventory.bulk.problem.phoneUnknown', { phones: unknown.join(', ') })
            : ti('inventory.bulk.problem.phoneNear', {
                phones: unknown.join(', '),
                near: `${near.brand} ${near.model}`.trim(),
              }),
      };
    }
  }

  const tags = splitList(text('tags')).map((tag) => spell(TAG_FACET, tag));
  if (tags.some((tag) => tag.length > MAX_FIELD_VALUE)) problems['tags'] = tooLong(MAX_FIELD_VALUE);
  else if (tags.length > MAX_ITEM_TAGS) {
    problems['tags'] = {
      tone: 'danger',
      message: ti('inventory.bulk.problem.tooMany', { max: MAX_ITEM_TAGS }),
    };
  }

  const code = text('code');
  if (code.length > MAX_PART_CODE) problems['code'] = tooLong(MAX_PART_CODE);
  const barcode = text('barcode');
  if (barcode.length > MAX_BARCODE) problems['barcode'] = tooLong(MAX_BARCODE);

  let counted = 0;
  const stock = text('stock').replace(/[.\s]/g, '');
  if (stock !== '') {
    if (!/^\d+$/.test(stock)) {
      problems['stock'] = { tone: 'danger', message: ti('inventory.bulk.problem.wholeNumber') };
    } else if (Number(stock) > MAX_COUNTED_QTY) {
      problems['stock'] = {
        tone: 'danger',
        message: ti('inventory.bulk.problem.tooMany', { max: MAX_COUNTED_QTY }),
      };
    } else {
      counted = Number(stock);
    }
  }

  const category = ctx.category;
  const builtName = category === null ? '' : formatItemName(category, values, fits);
  const typedName = text('name').replace(/\s+/g, ' ');
  const nameAuto = category !== null && typedName === '';
  const name = nameAuto ? builtName : typedName;
  if (name.length > MAX_PART_NAME) problems['name'] = tooLong(MAX_PART_NAME);
  else if (filled && name === '' && ctx.strict) {
    problems['name'] = {
      tone: 'danger',
      message: ti(
        category === null ? 'inventory.form.nameRequired' : 'inventory.bulk.problem.nameOrFields',
      ),
    };
  }

  return {
    filled,
    builtName,
    problems,
    ready: filled && name !== '' && !Object.values(problems).some((p) => p.tone === 'danger'),
    item: {
      name: nameAuto ? '' : name,
      nameAuto,
      code: code === '' ? null : code,
      barcode: barcode === '' ? null : barcode,
      categoryId: category?.id ?? null,
      values,
      tags,
      fits,
      counted,
    },
  };
}
