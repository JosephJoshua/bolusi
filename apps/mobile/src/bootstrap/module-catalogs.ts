// Register module-owned catalogs after initI18n and before rendering screens.
// Keep this in the mobile composition root: the shared module registry is platform-free.
// Add a row when a module gains screens; module-catalog-coverage.test.ts checks registration.
import idNotesCatalog from '@bolusi/modules/notes/i18n/id.json';
import enNotesCatalog from '@bolusi/modules/notes/i18n/en.json';
import { registerNotesCatalog } from '@bolusi/modules/notes/screens';

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
];

export function registerModuleCatalogs(): void {
  for (const mod of CLIENT_SCREEN_MODULES) {
    mod.register(mod.catalogs);
  }
}
