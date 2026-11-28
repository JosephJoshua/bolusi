// The phone's toast: the one showing now, in the bottom dock of whichever screen is open, above its
// action. A Batalkan that fails says why there instead, and goes after the same window.
import { errorCodeOrUnexpected, refusalKeyOf } from '@bolusi/core';
import { t, translateFailure } from '@bolusi/i18n';
import { ShellToastProvider, Toast } from '@bolusi/ui';

import { useShownToast } from '@bolusi/modules/screen-kit';

export function ToastHost({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  const shown = useShownToast();
  const toast =
    shown === null ? null : shown.failed === undefined ? (
      <Toast
        key={shown.key}
        message={shown.message}
        tone="success"
        actionLabel={shown.undo === undefined ? undefined : t('core.action.undo')}
        onAction={shown.undo}
        onHide={shown.dismiss}
        autoHide={false}
        testID="toast"
      />
    ) : (
      <Toast
        key={`${String(shown.key)}.failed`}
        message={translateFailure(
          refusalKeyOf(shown.failed) ?? errorCodeOrUnexpected(shown.failed),
        )}
        tone="danger"
        onHide={shown.dismiss}
        autoHide={false}
        testID="toast.failed"
      />
    );
  return <ShellToastProvider toast={toast}>{children}</ShellToastProvider>;
}
