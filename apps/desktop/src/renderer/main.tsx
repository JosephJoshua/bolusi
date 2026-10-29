import { initI18n } from '@bolusi/i18n';
import idRepairCatalog from '@bolusi/modules/repair/i18n/id.json';
import enRepairCatalog from '@bolusi/modules/repair/i18n/en.json';
import idMoneyCatalog from '@bolusi/modules/money/i18n/id.json';
import enMoneyCatalog from '@bolusi/modules/money/i18n/en.json';
import { registerMoneyCatalog } from '@bolusi/modules/money/desktop';
import { registerRepairCatalog } from '@bolusi/modules/repair/desktop';
import { applyTheme, TooltipProvider } from '@bolusi/ui-web';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import { MediaChoiceProvider } from './media-choice.js';
import './styles.css';

initI18n({ locale: 'id' });
registerRepairCatalog({ id: idRepairCatalog, en: enRepairCatalog });
registerMoneyCatalog({ id: idMoneyCatalog, en: enMoneyCatalog });
applyTheme();

const root = document.getElementById('root');
if (root === null) throw new Error('index.html has no #root');
createRoot(root).render(
  <StrictMode>
    <TooltipProvider>
      <MediaChoiceProvider>
        <App />
      </MediaChoiceProvider>
    </TooltipProvider>
  </StrictMode>,
);
