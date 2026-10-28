// Categories and how their items are named (owner decision, 2026-10-28).
//
// A category lists the fields its items fill in (LCD: the phones it fits, Kualitas, Tambahan) and a
// name format built from them, so a thousand LCDs entered by five people are still named one way:
// `LCD {HP} {Kualitas} {Tambahan}` names one `LCD Samsung Galaxy A14/A14 5G Original + frame`.
// Someone can still type a name for an odd item; the format then leaves it alone.
//
// Pure: used by the commands, the form's live preview and the browser preview alike.
import { z } from 'zod';

import { normalizeText } from '@bolusi/core';

import {
  FIELD_KINDS,
  MAX_CATEGORY_FIELDS,
  MAX_FIELD_OPTIONS,
  type FieldKind,
} from './constants.js';

export const MAX_CATEGORY_NAME = 60;
export const MAX_FIELD_LABEL = 30;
export const MAX_FIELD_VALUE = 60;
export const MAX_NAME_FORMAT = 200;
/** Field ids are minted by the editor (a new id per field), never typed. */
const MAX_FIELD_ID = 40;

export interface CategoryField {
  /** Stable across label edits, so items keep their values when a field is renamed. */
  readonly id: string;
  readonly label: string;
  readonly kind: FieldKind;
  /** The choices a `one` or `many` field offers first. Values typed on an item are kept too. */
  readonly options: readonly string[];
}

export interface CategoryShape {
  readonly name: string;
  readonly fields: readonly CategoryField[];
  readonly nameFormat: string;
}

/** What an item holds in each field, by field id. One-value fields hold a list of one. */
export type FieldValues = Readonly<Record<string, readonly string[]>>;

export interface PhoneFit {
  readonly brand: string;
  readonly model: string;
}

/** Same spelling for matching: `+ Frame` and `+ frame` are one value. */
export const valueKey = (value: string): string => normalizeText(value);

const zValue = z.string().trim().min(1).max(MAX_FIELD_VALUE);

export const zCategoryField = z
  .object({
    id: z
      .string()
      .min(1)
      .max(MAX_FIELD_ID)
      .regex(/^[A-Za-z0-9_-]+$/),
    label: z
      .string()
      .trim()
      .min(1)
      .max(MAX_FIELD_LABEL)
      .regex(/^[^{}]+$/),
    kind: z.enum(FIELD_KINDS),
    options: z.array(zValue).max(MAX_FIELD_OPTIONS),
  })
  .strict();

export const zFieldValues = z.record(
  z.string().min(1).max(MAX_FIELD_ID),
  z.array(zValue).max(MAX_FIELD_OPTIONS),
);

/** `{Kualitas}` → `kualitas`: how a token names a field, whatever its case or spacing. */
const labelKey = (label: string): string => normalizeText(label);

const TOKEN = /\{([^{}]*)\}/g;

/** The labels a name format names, in order. */
export function formatTokens(format: string): string[] {
  return [...format.matchAll(TOKEN)].map((match) => match[1]!.trim());
}

/**
 * Why a category can't be saved as given, or null: labels must be told apart, one field at most
 * holds phones, a field's choices are listed once, and the name format only names its fields.
 */
export function categoryProblem(category: CategoryShape): string | null {
  const labels = new Set<string>();
  for (const field of category.fields) {
    const key = labelKey(field.label);
    if (key === '' || labels.has(key)) return `field label ${field.label} twice`;
    labels.add(key);
    const options = new Set(field.options.map(valueKey));
    if (options.size !== field.options.length) return `a choice of ${field.label} twice`;
  }
  if (new Set(category.fields.map((field) => field.id)).size !== category.fields.length) {
    return 'a field id twice';
  }
  if (category.fields.filter((field) => field.kind === 'phones').length > 1) {
    return 'more than one phones field';
  }
  for (const token of formatTokens(category.nameFormat)) {
    if (!labels.has(labelKey(token))) return `no field ${token}`;
  }
  return null;
}

export const zCategoryShape = z
  .object({
    name: z.string().trim().min(1).max(MAX_CATEGORY_NAME),
    fields: z.array(zCategoryField).max(MAX_CATEGORY_FIELDS),
    nameFormat: z.string().trim().min(1).max(MAX_NAME_FORMAT),
  })
  .strict();

/** A new category's format: its name, then every field in order. */
export function defaultNameFormat(name: string, fields: readonly CategoryField[]): string {
  return [name.trim(), ...fields.map((field) => `{${field.label}}`)].join(' ').trim();
}

/** A field relabelled in the editor keeps its place in the format. */
export function renameToken(format: string, from: string, to: string): string {
  return format.replace(TOKEN, (whole, label: string) =>
    labelKey(label) === labelKey(from) ? `{${to}}` : whole,
  );
}

/** A field removed in the editor leaves the format too. */
export function dropToken(format: string, label: string): string {
  return format
    .replace(TOKEN, (whole, token: string) => (labelKey(token) === labelKey(label) ? '' : whole))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The phones as a name says them: the brand once, and each further model of that brand without the
 * words it shares with the first (`Samsung Galaxy A14/A14 5G`, `Xiaomi Redmi Note 10/10S`).
 */
export function phonesForName(fits: readonly PhoneFit[]): string {
  const groups: { brand: string; models: string[] }[] = [];
  for (const fit of fits) {
    const last = groups.at(-1);
    if (last !== undefined && valueKey(last.brand) === valueKey(fit.brand)) {
      last.models.push(fit.model);
    } else {
      groups.push({ brand: fit.brand, models: [fit.model] });
    }
  }
  return groups
    .map(({ brand, models }) => {
      const first = models[0]!.split(/\s+/);
      const rest = models.slice(1).map((model) => {
        const words = model.split(/\s+/);
        let shared = 0;
        // Never the first model's last word: that is what tells the models apart.
        while (
          shared < first.length - 1 &&
          shared < words.length - 1 &&
          valueKey(words[shared]!) === valueKey(first[shared]!)
        ) {
          shared += 1;
        }
        return words.slice(shared).join(' ');
      });
      return [`${brand} ${models[0]!}`.trim(), ...rest].join('/');
    })
    .join('/');
}

/** An item's name by its category's format: each `{Label}` replaced by what that field holds. */
export function formatItemName(
  category: Pick<CategoryShape, 'fields' | 'nameFormat'>,
  values: FieldValues,
  fits: readonly PhoneFit[],
): string {
  const byLabel = new Map(category.fields.map((field) => [labelKey(field.label), field]));
  return category.nameFormat
    .replace(TOKEN, (_, label: string) => {
      const field = byLabel.get(labelKey(label));
      if (field === undefined) return '';
      if (field.kind === 'phones') return phonesForName(fits);
      return (values[field.id] ?? []).join(' ');
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/** Only the fields the category has, each once, blanks dropped; a one-value field keeps one. */
export function cleanValues(fields: readonly CategoryField[], values: FieldValues): FieldValues {
  const clean: Record<string, readonly string[]> = {};
  for (const field of fields) {
    if (field.kind === 'phones') continue;
    const seen = new Set<string>();
    const kept = (values[field.id] ?? [])
      .map((value) => value.trim())
      .filter((value) => {
        const key = valueKey(value);
        if (value === '' || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    const limited = field.kind === 'many' ? kept : kept.slice(0, 1);
    if (limited.length > 0) clean[field.id] = limited;
  }
  return clean;
}

/** Tags, each once whatever its case, blanks dropped. */
export function cleanTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  return tags
    .map((tag) => tag.trim())
    .filter((tag) => {
      const key = valueKey(tag);
      if (key === '' || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function parseFields(json: string): CategoryField[] {
  return JSON.parse(json) as CategoryField[];
}

export function parseValues(json: string): FieldValues {
  return JSON.parse(json) as FieldValues;
}
