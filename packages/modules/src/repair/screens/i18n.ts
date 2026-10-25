// Module-owned translations for `repair`, merged into the app's i18n instance like notes'
// (notes/screens/i18n.ts). Screens land with the phone flows; the op-type labels ship now so the
// sync status screen names rejected repair changes.
import { getI18nInstance } from '@bolusi/i18n';

/** A shipped catalog locale tree, as the module JSON carries it (nested, prefix added at merge). */
export type RepairCatalogTree = Readonly<Record<string, unknown>>;

/** Merge the repair catalog under the `repair` namespace. Idempotent (deep + overwrite). */
export function registerRepairCatalog(catalogs: {
  readonly id: RepairCatalogTree;
  readonly en: RepairCatalogTree;
}): void {
  const i18n = getI18nInstance();
  i18n.addResourceBundle('id', 'translation', { repair: catalogs.id }, true, true);
  i18n.addResourceBundle('en', 'translation', { repair: catalogs.en }, true, true);
}
