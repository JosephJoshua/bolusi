// A PC with no printer to print on says so in the title bar, until one is chosen: the setup's
// printer step can be skipped, and a slip that cannot print is otherwise only found at handover.
import { t } from '@bolusi/i18n';
import { useDevicePrinters, useRepairRuntime } from '@bolusi/modules/repair/desktop';
import { Tooltip } from '@bolusi/ui-web';
import { Printer } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { BAR_CONTROL } from '../TitleBar.js';

export function PrinterReminder({
  recheck,
  onChoose,
}: {
  /** Changes when the printer may have been chosen (leaving Settings or the setup). */
  readonly recheck: unknown;
  readonly onChoose: () => void;
}): React.JSX.Element | null {
  const printers = useRepairRuntime().printing?.printers;
  const { state, reload } = useDevicePrinters(printers);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) first.current = false;
    else reload();
  }, [recheck, reload]);
  // A printer plugged in or installed while the app was open.
  useEffect(() => {
    window.addEventListener('focus', reload);
    return () => window.removeEventListener('focus', reload);
  }, [reload]);
  if (printers === undefined || state.kind !== 'ready') return null;
  const { chosen } = state;
  if (chosen !== null && state.printers.some((p) => p.name === chosen)) return null;
  const label = t(chosen === null ? 'auth.pc.setup.printerReminder' : 'auth.pc.setup.printerGone');
  return (
    <Tooltip label={t('auth.pc.setup.printerReminderHint')} side="bottom">
      <button
        type="button"
        aria-label={label}
        onClick={onChoose}
        data-testid="desktop.printerReminder"
        className={BAR_CONTROL}
      >
        <Printer size={16} aria-hidden className="shrink-0 text-chrome-warning" />
        <span className="hidden whitespace-nowrap @min-[56rem]:inline">{label}</span>
      </button>
    </Tooltip>
  );
}
