// Closing the window (the title bar's X, Alt+F4, the taskbar) while a dialog is open asks first, as
// Escape does inside the dialog: a handover or a correction half filled in is not lost to a slip.
// The renderer holds the close back and asks in the app's own words; "Tutup" closes for real.
import { t } from '@bolusi/i18n';
import { ConfirmDialog } from '@bolusi/ui-web';
import { useEffect, useRef, useState } from 'react';

/** Whether something being filled in is open: a dialog, which the page has nowhere else to keep. */
function fillingIn(): boolean {
  return document.querySelector('[role="dialog"], [role="alertdialog"]') !== null;
}

export function CloseGuard(): React.JSX.Element {
  const [asking, setAsking] = useState(false);
  const leaving = useRef(false);
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (leaving.current || !fillingIn()) return;
      // Electron keeps the window open when the page cancels its unload, and shows nothing.
      event.preventDefault();
      event.returnValue = '';
      setAsking(true);
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);
  return (
    <ConfirmDialog
      open={asking}
      title={t('core.closeWindow.title')}
      message={t('core.closeWindow.message')}
      confirmLabel={t('core.closeWindow.confirm')}
      cancelLabel={t('core.closeWindow.keep')}
      closeLabel={t('core.action.close')}
      destructive
      onConfirm={() => {
        leaving.current = true;
        window.close();
      }}
      onCancel={() => setAsking(false)}
      testId="desktop.closeGuard"
    />
  );
}
