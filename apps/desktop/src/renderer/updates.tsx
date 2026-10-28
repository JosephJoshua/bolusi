// A downloaded update, offered in the sidebar: it installs by itself when the app closes, or now if
// the counter has a quiet moment. Nothing shows while there is nothing to install.
import { t } from '@bolusi/i18n';
import { Button, IconButton } from '@bolusi/ui-web';
import { CircleArrowUp } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { UpdatesBridge, UpdateState } from '../main/bridge.js';

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
  compact,
  updates = updatesBridge(),
}: {
  readonly compact: boolean;
  readonly updates?: UpdatesBridge | undefined;
}): React.JSX.Element | null {
  const state = useUpdateState(updates);
  if (updates === undefined || state.kind !== 'ready') return null;
  const install = (): void => void updates.install();
  if (compact) {
    return (
      <div className="flex justify-center">
        <IconButton
          icon={CircleArrowUp}
          label={`${t('core.update.ready')}: ${t('core.update.install')}`}
          tooltipSide="right"
          onClick={install}
          className="text-primary"
          data-testid="desktop.update"
        />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 rounded-sm bg-info-bg p-3" data-testid="desktop.update">
      <div className="flex items-start gap-2">
        <CircleArrowUp size={18} aria-hidden className="mt-0.5 shrink-0 text-primary" />
        <div className="min-w-0">
          <p className="text-body font-semibold text-text">{t('core.update.ready')}</p>
          <p className="text-small text-text-muted">{t('core.update.later')}</p>
        </div>
      </div>
      <Button label={t('core.update.install')} size="sm" variant="secondary" onClick={install} />
    </div>
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
