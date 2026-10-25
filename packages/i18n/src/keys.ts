import type { resources } from './generated/resources.js';

/** Catalog types come from the bundled data, so they cannot drift from it. */
export type TranslationResources = (typeof resources)['id']['translation'];

type LeafKeys<Tree> = {
  [Key in keyof Tree & string]: Tree[Key] extends string
    ? Key
    : Tree[Key] extends Record<string, unknown>
      ? `${Key}.${LeafKeys<Tree[Key]>}`
      : never;
}[keyof Tree & string];

/** Dotted paths to labels, excluding intermediate objects and empty namespaces. */
export type TranslationKey = LeafKeys<TranslationResources>;
