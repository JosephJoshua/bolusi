// The PC's Batalkan: the offer showing now, near the bottom of the window (clear of a list's paging)
// over whatever page is open.
// A reverse that fails says why there instead, until it is dismissed or its window ends.
import { errorCodeOrUnexpected, refusalKeyOf } from '@bolusi/core';
import { t, translateFailure } from '@bolusi/i18n';
import { UndoProvider, useShownUndo } from '@bolusi/modules/screen-kit';
import { Banner, Button } from '@bolusi/ui-web';

function ShownUndo(): React.JSX.Element | null {
  const shown = useShownUndo();
  if (shown === null) return null;
  const failed = shown.failed !== undefined;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-40 flex justify-center px-4">
      <div className="pointer-events-auto w-full max-w-[480px] shadow-lg" data-testid="undo.toast">
        <Banner
          key={shown.key}
          tone={failed ? 'danger' : 'info'}
          message={
            failed
              ? translateFailure(refusalKeyOf(shown.failed) ?? errorCodeOrUnexpected(shown.failed))
              : shown.message
          }
          action={
            failed ? undefined : (
              <Button
                label={t('core.action.undo')}
                variant="secondary"
                size="sm"
                onClick={shown.undo}
                busy={shown.undoing}
                data-testid="undo.toast.action"
              />
            )
          }
          onDismiss={shown.dismiss}
          dismissLabel={t('core.action.close')}
        />
      </div>
    </div>
  );
}

/** One Batalkan offer at a time for the person signed in, drawn over the counter app. */
export function UndoHost({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <UndoProvider>
      {children}
      <ShownUndo />
    </UndoProvider>
  );
}
