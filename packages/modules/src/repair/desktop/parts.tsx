// Pieces every desktop repair screen shares: the status chip, a verified photo's state, the
// banners for a refused action or a step overtaken by a change from elsewhere, and money entry.
import { formatNumber, t, translateErrorCode } from '@bolusi/i18n';
import {
  Banner,
  Chip,
  StatePanel,
  TextField,
  type PhotoLabels,
  type PhotoState,
  type TextFieldProps,
} from '@bolusi/ui-web';
import {
  Ban,
  CircleCheck,
  FileQuestion,
  Hourglass,
  Inbox,
  LoaderCircle,
  Lock,
  PackageCheck,
  TriangleAlert,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';

import type { QueryState, ThumbnailRef } from '../../screen-kit/index.js';
import {
  acceptsRupiahText,
  parseRupiah,
  statusTone,
  type StaleStep,
  type TicketStatus,
} from '../flows.js';
import { tn } from '../i18n.js';
import { staleStepMessage, statusLabel } from '../labels.js';
import { useRepairThumbnail } from '../runtime.js';

const STATUS_ICON: Readonly<Record<TicketStatus, LucideIcon>> = {
  received: Inbox,
  in_repair: Wrench,
  waiting_for_parts: Hourglass,
  repaired: CircleCheck,
  cancelled: Ban,
  returned: PackageCheck,
};

export function StatusChip({ status }: { readonly status: TicketStatus }): React.JSX.Element {
  return <Chip label={statusLabel(status)} icon={STATUS_ICON[status]} tone={statusTone(status)} />;
}

export const WarningIcon = TriangleAlert;

/** A photo resolved through the media client, in the shape the photo components take. */
export function usePhotoState(ref: ThumbnailRef | null): PhotoState {
  return useRepairThumbnail(ref);
}

export function photoLabels(): PhotoLabels {
  return {
    unavailable: tn('repair.desk.photoUnavailable'),
    mismatch: tn('repair.desk.photoMismatch'),
  };
}

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

/** A step the ticket can no longer finish because it changed on another device. */
export function StaleNotice({
  stale,
}: {
  readonly stale: StaleStep | null;
}): React.JSX.Element | null {
  return stale === null ? null : <Banner tone="warning" message={staleStepMessage(stale)} />;
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

/** "650.000" for 650000 and nothing for 0, so an amount reads as the customer hears it. */
export function rupiahText(amount: number | null): string {
  return amount === null || amount === 0 ? '' : formatNumber(amount);
}

/** An amount in whole rupiah, grouped as it is typed; refuses keystrokes past the line limit. */
export function MoneyField({
  value,
  onChange,
  ...rest
}: Omit<TextFieldProps, 'value' | 'onChange' | 'prefix' | 'inputMode'> & {
  readonly value: number | null;
  readonly onChange: (value: number | null) => void;
}): React.JSX.Element {
  return (
    <TextField
      {...rest}
      prefix={tn('repair.desk.currency')}
      inputMode="numeric"
      inputClassName="tabular text-right"
      // Empty only when nothing is typed: a fee of 0 (waived) must read as 0.
      value={value === null ? '' : formatNumber(value)}
      onChange={(event) => {
        const text = event.target.value;
        if (acceptsRupiahText(text)) onChange(parseRupiah(text));
      }}
    />
  );
}
