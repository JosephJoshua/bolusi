// A downloaded update, offered in the title bar: it installs by itself when the app closes or the
// counter has been quiet for a while, or now if someone chooses to. Nothing shows while there is
// nothing to install.
import { t } from '@bolusi/i18n';
import { Menu } from '@bolusi/ui-web';
import { CircleArrowUp, RotateCw } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { UpdatesBridge, UpdateState } from '../main/bridge.js';

import { BAR_CONTROL } from './TitleBar.js';

export function updatesBridge(): UpdatesBridge | undefined {
  return (window as { bolusi?: { updates?: UpdatesBridge } }).bolusi?.updates;
}

function useUpdateState(updates: UpdatesBridge | undefined): UpdateState {
  const [state, setState] = useState<UpdateState>({ kind: 'none' });
  useEffect(() => {
    if (updates === undefined) return;
    let live = true;
    const off = updates.onChange((next) => {
      if (live) setState(next);
    });
    void updates.state().then((next) => {
      if (live) setState(next);
    });
    return () => {
      live = false;
      off();
    };
  }, [updates]);
  return state;
}

export function UpdateNotice({
  updates = updatesBridge(),
}: {
  readonly updates?: UpdatesBridge | undefined;
}): React.JSX.Element | null {
  const state = useUpdateState(updates);
  if (updates === undefined || state.kind !== 'ready') return null;
  // Installing restarts the app, so it is a choice in a menu, never a click on the notice itself.
  return (
    <Menu
      align="end"
      tooltip={{ label: t('core.update.ready'), side: 'bottom' }}
      header={
        <span className="flex max-w-64 flex-col gap-1">
          <span className="text-body font-semibold text-text">{t('core.update.ready')}</span>
          <span className="text-small font-normal text-text-muted">{t('core.update.later')}</span>
        </span>
      }
      items={[
        {
          key: 'install',
          label: t('core.update.install'),
          icon: RotateCw,
          onSelect: () => void updates.install(),
        },
      ]}
      trigger={
        <button
          type="button"
          aria-label={t('core.update.ready')}
          data-testid="desktop.update"
          className={BAR_CONTROL}
        >
          <CircleArrowUp size={16} aria-hidden className="shrink-0 text-chrome-success" />
          <span className="hidden whitespace-nowrap @min-[56rem]:inline">
            {t('core.update.ready')}
          </span>
        </button>
      }
    />
  );
}

/** The installed version, for Settings; null outside the desktop app. */
export function useAppVersion(updates: UpdatesBridge | undefined = updatesBridge()): string | null {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    if (updates === undefined) return;
    let live = true;
    void updates.version().then((next) => {
      if (live) setVersion(next);
    });
    return () => {
      live = false;
    };
  }, [updates]);
  return version;
}

/** What counts as someone in the middle of something: any open dialog (camera, phone, print, confirm). */
const OPEN_DIALOG = '[role="dialog"], [role="alertdialog"]';

/**
 * Tells the main process whenever a dialog opens or closes, so a quiet-time update never restarts
 * the app under a phone handoff or a print. Dialogs mount in portals straight under `body`, so
 * watching its children is enough and costs nothing while the counter is idle.
 */
export function useReportBusy(updates: UpdatesBridge | undefined = updatesBridge()): void {
  useEffect(() => {
    if (updates === undefined) return;
    let busy = false;
    const report = (): void => {
      const now = document.querySelector(OPEN_DIALOG) !== null;
      if (now === busy) return;
      busy = now;
      updates.busy(now);
    };
    const observer = new MutationObserver(report);
    observer.observe(document.body, { childList: true });
    report();
    return () => {
      observer.disconnect();
      if (busy) updates.busy(false);
    };
  }, [updates]);
}
