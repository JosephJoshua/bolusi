// Opening with Windows (main/startup.ts), as a switch in Settings and on the setup's last step.
// Nothing shows where the system has no such setting.
import { t } from '@bolusi/i18n';
import { Card, Switch } from '@bolusi/ui-web';
import { useEffect, useState } from 'react';

import type { StartupBridge } from '../main/bridge.js';

export function startupBridge(): StartupBridge | undefined {
  return (window as { bolusi?: { startup?: StartupBridge } }).bolusi?.startup;
}

export function StartWithWindows({
  startup = startupBridge(),
}: {
  readonly startup?: StartupBridge | undefined;
}): React.JSX.Element | null {
  const [open, setOpen] = useState<boolean | null>(null);
  useEffect(() => {
    if (startup === undefined) return;
    let live = true;
    startup.get().then(
      (value) => {
        if (live) setOpen(value);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [startup]);
  if (startup === undefined || open === null) return null;
  return (
    <Card className="w-full text-left" testId="desktop.startup">
      <Switch
        label={t('auth.pc.startup.label')}
        caption={t('auth.pc.startup.caption')}
        checked={open}
        onChange={(next) => {
          setOpen(next);
          // Not saved: show what Windows will still do.
          startup.set(next).catch(() => setOpen(!next));
        }}
        testId="desktop.startup.switch"
      />
    </Card>
  );
}
