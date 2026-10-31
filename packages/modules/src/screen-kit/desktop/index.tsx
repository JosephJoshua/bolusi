// Pieces every desktop module screen shares (React DOM, apps/desktop only): a read's states,
// a refused action's banner and the dialog frame a task is filled in.
import { t, translateErrorCode, translateFailure } from '@bolusi/i18n';
import { Banner, Button, ConfirmDialog, Dialog, StatePanel } from '@bolusi/ui-web';
import { FileQuestion, LoaderCircle, Lock } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import type { ActionRunner } from '../action.js';
import type { QueryState } from '../live.js';

/** A refused action, in the dialog or pane it came from. */
export function ActionError({
  errorCode,
  onDismiss,
}: {
  readonly errorCode: string | null;
  readonly onDismiss: () => void;
}): React.JSX.Element | null {
  if (errorCode === null) return null;
  return (
    <Banner
      tone="danger"
      message={translateFailure(errorCode)}
      onDismiss={onDismiss}
      dismissLabel={t('core.action.close')}
    />
  );
}

/** A read's loading, no-access, missing and error states; `ready` renders through `children`. */
export function QueryPanel<TData>({
  query,
  onRetry,
  children,
}: {
  readonly query: QueryState<TData>;
  readonly onRetry: () => void;
  readonly children: (data: TData) => ReactNode;
}): React.JSX.Element {
  switch (query.status) {
    case 'loading':
      return (
        <div className="flex justify-center py-12 text-text-muted">
          <LoaderCircle size={24} className="animate-spin" aria-label={t('core.status.loading')} />
        </div>
      );
    case 'unauthorized':
      return (
        <StatePanel
          icon={Lock}
          title={t('core.errors.PERMISSION_DENIED')}
          hint={t('core.unauthorized.askOwner')}
        />
      );
    case 'error':
      return (
        <StatePanel
          icon={FileQuestion}
          tone="danger"
          title={translateErrorCode(query.code)}
          action={
            <button
              type="button"
              onClick={onRetry}
              className="cursor-pointer text-body font-semibold text-primary hover:underline"
            >
              {t('core.action.retry')}
            </button>
          }
        />
      );
    case 'ready':
      return <>{children(query.data)}</>;
  }
}

/** Whether a key press was meant for a field rather than for the page. */
export function typingInField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/**
 * Whether a dialog or menu is up: it owns the keyboard, Escape included, so page shortcuts stand
 * down. (A filter's popover is a dialog too; a tooltip is not, so hovering never mutes the keys.)
 */
export function overlayOpen(): boolean {
  return document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]') !== null;
}

/** What leaving a task with something typed asks, in the module's words. */
export interface DiscardCopy {
  readonly title: string;
  readonly message: string;
  readonly confirm: string;
  readonly keep: string;
}

/** One task in a dialog: the refusal above the body, Cancel and the task's own button below. */
export function TaskDialog({
  title,
  description,
  runner,
  dirty,
  discard,
  onClose,
  submitLabel,
  onSubmit,
  submitDisabled = false,
  destructive = false,
  hint,
  secondary,
  size = 'sm',
  children,
  testId,
}: {
  readonly title: string;
  readonly description?: ReactNode;
  readonly runner: ActionRunner;
  /** Something typed: leaving asks first, so a mis-click does not lose it. */
  readonly dirty: boolean;
  readonly discard: DiscardCopy;
  readonly onClose: () => void;
  readonly submitLabel: string;
  readonly onSubmit: () => void;
  readonly submitDisabled?: boolean | undefined;
  readonly destructive?: boolean | undefined;
  /** What is still missing, beside the buttons. */
  readonly hint?: string | null | undefined;
  /** A second way to finish, such as saving and starting the next one. */
  readonly secondary?:
    { readonly label: string; readonly onClick: () => void; readonly testId: string } | undefined;
  readonly size?: 'sm' | 'md' | 'lg';
  readonly children: ReactNode;
  readonly testId: string;
}): React.JSX.Element {
  const [asking, setAsking] = useState(false);
  const requestClose = (): void => (dirty ? setAsking(true) : onClose());
  return (
    <>
      <Dialog
        open
        onRequestClose={requestClose}
        title={title}
        description={description}
        closeLabel={t('core.action.close')}
        banner={
          runner.errorCode === null ? undefined : (
            <ActionError errorCode={runner.errorCode} onDismiss={runner.clearError} />
          )
        }
        size={size}
        testId={testId}
        footer={
          <>
            {hint === null || hint === undefined ? null : (
              <p className="mr-auto text-small text-text-muted" data-testid={`${testId}.hint`}>
                {hint}
              </p>
            )}
            {/* "Kembali", never "Batal": beside "Batalkan …" the two read alike. */}
            <Button label={t('core.action.back')} onClick={requestClose} />
            {secondary === undefined ? null : (
              <Button
                label={secondary.label}
                onClick={secondary.onClick}
                disabled={runner.busy || submitDisabled}
                data-testid={secondary.testId}
              />
            )}
            <Button
              label={submitLabel}
              variant={destructive ? 'danger' : 'primary'}
              onClick={onSubmit}
              busy={runner.busy}
              disabled={submitDisabled}
              data-testid={`${testId}.submit`}
            />
          </>
        }
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            // A destructive task is never one Enter away: it takes the button.
            if (!submitDisabled && !runner.busy && !destructive) onSubmit();
          }}
        >
          {children}
          {/* Enter in a field submits, as the button does. */}
          <button type="submit" hidden aria-hidden tabIndex={-1} />
        </form>
      </Dialog>
      <ConfirmDialog
        open={asking}
        title={discard.title}
        message={discard.message}
        confirmLabel={discard.confirm}
        cancelLabel={discard.keep}
        closeLabel={t('core.action.close')}
        destructive
        onConfirm={() => {
          setAsking(false);
          onClose();
        }}
        onCancel={() => setAsking(false)}
        testId={`${testId}.leave`}
      />
    </>
  );
}
