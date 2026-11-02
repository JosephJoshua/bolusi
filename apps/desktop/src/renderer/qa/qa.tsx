// Scratch QA harness (not committed).
import { initI18n } from '@bolusi/i18n';
import idRepairCatalog from '@bolusi/modules/repair/i18n/id.json';
import enRepairCatalog from '@bolusi/modules/repair/i18n/en.json';
import idMoneyCatalog from '@bolusi/modules/money/i18n/id.json';
import enMoneyCatalog from '@bolusi/modules/money/i18n/en.json';
import { registerMoneyCatalog } from '@bolusi/modules/money/desktop';
import idApprovalsCatalog from '@bolusi/modules/approvals/i18n/id.json';
import enApprovalsCatalog from '@bolusi/modules/approvals/i18n/en.json';
import { registerApprovalsCatalog } from '@bolusi/modules/approvals';
import idInventoryCatalog from '@bolusi/modules/inventory/i18n/id.json';
import enInventoryCatalog from '@bolusi/modules/inventory/i18n/en.json';
import { registerInventoryCatalog } from '@bolusi/modules/inventory/desktop';
import idPurchasingCatalog from '@bolusi/modules/purchasing/i18n/id.json';
import enPurchasingCatalog from '@bolusi/modules/purchasing/i18n/en.json';
import { registerPurchasingCatalog } from '@bolusi/modules/purchasing/desktop';
import { registerRepairCatalog } from '@bolusi/modules/repair/desktop';
import { applyTheme, setDataArriving, TooltipProvider } from '@bolusi/ui-web';
import type { SyncStatusInput } from '@bolusi/device/models/sync-status/model';
import { createRoot } from 'react-dom/client';
import { useState } from 'react';

import { App } from '../App.js';
import { MediaChoiceProvider } from '../media-choice.js';
import { SyncStatusButton } from '../SyncStatus.js';
import '../styles.css';

initI18n({ locale: 'id' });
registerRepairCatalog({ id: idRepairCatalog, en: enRepairCatalog });
registerMoneyCatalog({ id: idMoneyCatalog, en: enMoneyCatalog });
registerApprovalsCatalog({ id: idApprovalsCatalog, en: enApprovalsCatalog });
registerInventoryCatalog({ id: idInventoryCatalog, en: enInventoryCatalog });
registerPurchasingCatalog({ id: idPurchasingCatalog, en: enPurchasingCatalog });
applyTheme();
(window as unknown as { setArriving: (b: boolean) => void }).setArriving = setDataArriving;

const NOW = Date.now();
function input(over: Partial<SyncStatusInput>): SyncStatusInput {
  return {
    state: {
      cursor: 0,
      devicesDirectoryVersion: 0,
      lastSuccessfulSyncAt: NOW - 60_000,
      lastPushAt: null,
      lastPullAt: null,
      pushHalted: false,
      syncDisabled: false,
      syncDisabledReason: null,
      lastSyncError: null,
      backoffUntil: null,
      tokenRejectedSince: null,
      tokenRejectedCount: 0,
      readSet: null,
      backfill: null,
      lastServerTime: NOW,
      lastServerTimeReceivedAt: NOW,
    },
    loopState: 'idle',
    pendingOperationCount: 0,
    pendingMediaCount: 0,
    rejected: [],
    quarantined: [],
    media: [],
    isOffline: false,
    manualSyncBusy: false,
    manualSyncError: null,
    firstSync: null,
    now: NOW,
    ...over,
  } as SyncStatusInput;
}
const refused = [
  {
    opId: 'op-1',
    type: 'repair.ticket_claimed',
    at: NOW - 600_000,
    rejectionCode: 'RULE_VIOLATED',
    rejectionReason: 'repair.refusal.takenElsewhere',
    subject: 'SRV-0042',
  },
];
const view = new URLSearchParams(location.search).get('view') ?? 'app';
function Sync(): React.JSX.Element {
  const [open, setOpen] = useState(true);
  const given =
    view === 'sync-refused'
      ? input({ rejected: refused, pendingOperationCount: 1 })
      : view === 'sync-pending'
        ? input({ pendingOperationCount: 3 })
        : input({});
  return (
    <div className="bg-chrome p-2">
      <SyncStatusButton
        input={given}
        open={open}
        onOpenChange={setOpen}
        onSyncNow={() => undefined}
        onReenrol={() => undefined}
        onMarkRejectedHandled={() => undefined}
      />
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <TooltipProvider>
    <MediaChoiceProvider>{view.startsWith('sync') ? <Sync /> : <App />}</MediaChoiceProvider>
  </TooltipProvider>,
);
