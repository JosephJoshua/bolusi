import { clsx } from 'clsx';
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react';
import type { ReactNode } from 'react';

export type BannerTone = 'info' | 'success' | 'warning' | 'danger';

const TONE: Readonly<Record<BannerTone, string>> = {
  info: 'bg-info-bg text-info',
  success: 'bg-success-bg text-on-success-bg',
  warning: 'bg-warning-bg text-warning',
  danger: 'bg-danger-bg text-on-danger-bg',
};
const ICON = { info: Info, success: CircleCheck, warning: TriangleAlert, danger: CircleAlert };

/** A message about the page: what an action did, a refusal, or something to check. */
export function Banner({
  tone,
  message,
  action,
  onDismiss,
  dismissLabel,
  className,
}: {
  readonly tone: BannerTone;
  readonly message: string;
  readonly action?: ReactNode;
  readonly onDismiss?: (() => void) | undefined;
  readonly dismissLabel?: string | undefined;
  readonly className?: string | undefined;
}): React.JSX.Element {
  const Icon = ICON[tone];
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={clsx(
        'flex items-start gap-3 rounded-sm px-4 py-3 text-body',
        TONE[tone],
        className,
      )}
    >
      <Icon size={20} aria-hidden className="mt-px shrink-0" />
      <p className="min-w-0 flex-1">{message}</p>
      {action}
      {onDismiss === undefined ? null : (
        <button
          type="button"
          aria-label={dismissLabel}
          onClick={onDismiss}
          className="-my-1 -mr-2 flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-sm hover:bg-black/5"
        >
          <X size={16} aria-hidden />
        </button>
      )}
    </div>
  );
}
