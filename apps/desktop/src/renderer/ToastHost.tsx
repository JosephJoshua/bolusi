// The PC's toast: the one showing now, near the bottom of the window (clear of a list's paging)
// over whatever page is open. A Batalkan that fails says why there instead, until it is closed or
// its window ends.
import { errorCodeOrUnexpected, refusalKeyOf } from '@bolusi/core';
import { t, translateFailure } from '@bolusi/i18n';
import { ToastProvider, useShownToast } from '@bolusi/modules/screen-kit';
import { Toast } from '@bolusi/ui-web';

function ShownToast(): React.JSX.Element | null {
  const shown = useShownToast();
  if (shown === null) return null;
  const failed = shown.failed !== undefined;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-40 flex justify-center px-4">
      <div className="pointer-events-auto w-full max-w-[480px]">
        <Toast
          key={`${String(shown.key)}${failed ? '.failed' : ''}`}
          tone={failed ? 'danger' : 'success'}
          message={
            failed
              ? translateFailure(refusalKeyOf(shown.failed) ?? errorCodeOrUnexpected(shown.failed))
              : shown.message
          }
          actionLabel={failed ? undefined : t('core.action.undo')}
          onAction={failed ? undefined : shown.undo}
          busy={shown.undoing}
          onDismiss={shown.dismiss}
          dismissLabel={t('core.action.close')}
          testId={failed ? 'toast.failed' : 'toast'}
        />
      </div>
    </div>
  );
}

/** One toast at a time for the person signed in, drawn over the counter app. */
export function ToastHost({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <ToastProvider>
      {children}
      <ShownToast />
    </ToastProvider>
  );
}
