// Register module-owned catalogs after initI18n and before rendering screens.
// Keep this in the mobile composition root: the shared module registry is platform-free.
// Add a row when a module gains screens; module-catalog-coverage.test.ts checks registration.
import idNotesCatalog from '@bolusi/modules/notes/i18n/id.json';
import enNotesCatalog from '@bolusi/modules/notes/i18n/en.json';
import { registerNotesCatalog } from '@bolusi/modules/notes/screens';
import idRepairCatalog from '@bolusi/modules/repair/i18n/id.json';
import enRepairCatalog from '@bolusi/modules/repair/i18n/en.json';
import { registerRepairCatalog } from '@bolusi/modules/repair/screens';
import idInventoryCatalog from '@bolusi/modules/inventory/i18n/id.json';
import enInventoryCatalog from '@bolusi/modules/inventory/i18n/en.json';
import { registerInventoryCatalog } from '@bolusi/modules/inventory/screens';
import idMoneyCatalog from '@bolusi/modules/money/i18n/id.json';
import enMoneyCatalog from '@bolusi/modules/money/i18n/en.json';
import { registerMoneyCatalog } from '@bolusi/modules/money/screens';
import idApprovalsCatalog from '@bolusi/modules/approvals/i18n/id.json';
import enApprovalsCatalog from '@bolusi/modules/approvals/i18n/en.json';
import { registerApprovalsCatalog } from '@bolusi/modules/approvals/screens';
import idPurchasingCatalog from '@bolusi/modules/purchasing/i18n/id.json';
import enPurchasingCatalog from '@bolusi/modules/purchasing/i18n/en.json';
import { registerPurchasingCatalog } from '@bolusi/modules/purchasing/screens';

type ModuleCatalogTree = Readonly<Record<string, unknown>>;

interface ClientScreenModule {
  readonly moduleId: string;
  readonly register: (catalogs: {
    readonly id: ModuleCatalogTree;
    readonly en: ModuleCatalogTree;
  }) => void;
  readonly catalogs: { readonly id: ModuleCatalogTree; readonly en: ModuleCatalogTree };
}

export const CLIENT_SCREEN_MODULES: readonly ClientScreenModule[] = [
  {
    moduleId: 'notes',
    register: registerNotesCatalog,
    catalogs: { id: idNotesCatalog, en: enNotesCatalog },
  },
  {
    moduleId: 'repair',
    register: registerRepairCatalog,
    catalogs: { id: idRepairCatalog, en: enRepairCatalog },
  },
  {
    moduleId: 'inventory',
    register: registerInventoryCatalog,
    catalogs: { id: idInventoryCatalog, en: enInventoryCatalog },
  },
  {
    moduleId: 'purchasing',
    register: registerPurchasingCatalog,
    catalogs: { id: idPurchasingCatalog, en: enPurchasingCatalog },
  },
  {
    moduleId: 'money',
    register: registerMoneyCatalog,
    catalogs: { id: idMoneyCatalog, en: enMoneyCatalog },
  },
  {
    moduleId: 'approvals',
    register: registerApprovalsCatalog,
    catalogs: { id: idApprovalsCatalog, en: enApprovalsCatalog },
  },
];

export function registerModuleCatalogs(): void {
  for (const mod of CLIENT_SCREEN_MODULES) {
    mod.register(mod.catalogs);
  }
}
