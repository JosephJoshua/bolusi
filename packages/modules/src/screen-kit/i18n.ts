// Module-owned translations (07-i18n §3.3): each module ships its own catalog JSON and merges it
// into the app's one i18n instance under its namespace, then translates with a typed key union.
import { getI18nInstance, t } from '@bolusi/i18n';
import type { TranslationKey, TranslationValues } from '@bolusi/i18n';

/** A shipped catalog locale tree, as the module JSON carries it (nested, prefix added at merge). */
export type ModuleCatalogTree = Readonly<Record<string, unknown>>;

export interface ModuleCatalogs {
  readonly id: ModuleCatalogTree;
  readonly en: ModuleCatalogTree;
}

/**
 * Merge a module's catalogs under `namespace`. The trees are passed in because the JSON lives
 * outside the compiled `rootDir`; the composition root owns the import. Idempotent (deep +
 * overwrite), so booting twice or re-registering in a test is safe.
 */
export function registerModuleCatalog(namespace: string, catalogs: ModuleCatalogs): void {
  const i18n = getI18nInstance();
  i18n.addResourceBundle('id', 'translation', { [namespace]: catalogs.id }, true, true);
  i18n.addResourceBundle('en', 'translation', { [namespace]: catalogs.en }, true, true);
}

/**
 * A translator for one module's typed keys. It goes through the reserved `t()` so module screens
 * share its fallback logging. The cast is the module-catalog escape hatch: `t()` is typed to the
 * reserved keys, and the registered catalog is what makes a module key resolve at runtime.
 */
export function moduleTranslator<K extends string>(): (
  key: K,
  values?: TranslationValues,
) => string {
  return (key, values) => {
    const reserved = key as unknown as TranslationKey;
    return values === undefined ? t(reserved) : t(reserved, values);
  };
}
