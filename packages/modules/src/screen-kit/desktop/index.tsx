// Pieces every desktop module screen shares (React DOM, apps/desktop only): a read's states and
// a refused action's banner.
import { t, translateErrorCode } from '@bolusi/i18n';
import { Banner, StatePanel } from '@bolusi/ui-web';
import { FileQuestion, LoaderCircle, Lock } from 'lucide-react';
import type { ReactNode } from 'react';

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
      message={translateErrorCode(errorCode)}
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
