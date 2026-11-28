// The phone's Batalkan: the offer showing now, in the bottom dock of whichever screen is open, above
// its action. A reverse that fails says why there instead, and goes after the same window.
import { errorCodeOrUnexpected, refusalKeyOf } from '@bolusi/core';
import { t, translateFailure } from '@bolusi/i18n';
import { ShellToastProvider, Toast } from '@bolusi/ui';

import { useShownUndo } from '@bolusi/modules/screen-kit';

export function UndoHost({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  const shown = useShownUndo();
  const toast =
    shown === null ? null : shown.failed === undefined ? (
      <Toast
        key={shown.key}
        message={shown.message}
        actionLabel={t('core.action.undo')}
        onAction={shown.undo}
        onHide={shown.dismiss}
        autoHide={false}
        testID="undo.toast"
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
        testID="undo.failed"
      />
    );
  return <ShellToastProvider toast={toast}>{children}</ShellToastProvider>;
}
