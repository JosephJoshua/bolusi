// The core's own translations. It runs in its own process, so the window's `initI18n` does not
// reach it, yet a few things it hands the window are already words: the servisan a refused change
// was about ("Servisan #…" in the sync status). Same locale and catalog as the window (main.tsx).
import { initI18n } from '@bolusi/i18n';
import { registerRepairCatalog } from '@bolusi/modules/repair';
import enRepairCatalog from '@bolusi/modules/repair/i18n/en.json' with { type: 'json' };
import idRepairCatalog from '@bolusi/modules/repair/i18n/id.json' with { type: 'json' };

export function initCoreI18n(): void {
  initI18n({ locale: 'id' });
  registerRepairCatalog({ id: idRepairCatalog, en: enRepairCatalog });
}
