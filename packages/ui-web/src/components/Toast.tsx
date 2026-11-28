// The toast: a short note that a step is done, at the bottom of the window, with Batalkan when the
// step can be taken back. A dark bar so it stands apart from the light page; its text, action and
// close share one centre line. The same look and words as the phone's.
import { clsx } from 'clsx';
import { CircleAlert, CircleCheck, X } from 'lucide-react';

import { Spinner } from './Spinner.js';
import { Tooltip } from './Tooltip.js';

export type ToastTone = 'success' | 'danger';

const ICON = {
  success: { Icon: CircleCheck, className: 'text-inverse-success' },
  danger: { Icon: CircleAlert, className: 'text-inverse-danger' },
} as const;

export function Toast({
  tone = 'success',
  message,
  actionLabel,
  onAction,
  busy = false,
  onDismiss,
  dismissLabel,
  testId,
}: {
  readonly tone?: ToastTone | undefined;
  readonly message: string;
  readonly actionLabel?: string | undefined;
  readonly onAction?: (() => void) | undefined;
  /** The action is running: a spinner in its place, and presses wait. */
  readonly busy?: boolean | undefined;
  readonly onDismiss: () => void;
  readonly dismissLabel: string;
  readonly testId?: string | undefined;
}): React.JSX.Element {
  const { Icon, className } = ICON[tone];
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      data-testid={testId}
      className="flex min-h-12 w-full animate-rise-in items-center gap-3 rounded-sm bg-inverse-surface py-1.5 pr-1.5 pl-4 text-body text-on-inverse shadow-lg"
    >
      <Icon size={18} aria-hidden className={clsx('shrink-0', className)} />
      <p className="min-w-0 flex-1 py-1.5">{message}</p>
      {actionLabel === undefined || onAction === undefined ? null : (
        <button
          type="button"
          onClick={onAction}
          disabled={busy}
          aria-busy={busy}
          data-testid={testId === undefined ? undefined : `${testId}.action`}
          className="inline-flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-sm px-3 font-semibold text-inverse-action transition-colors hover:bg-white/10 disabled:cursor-wait"
        >
          {busy ? <Spinner /> : null}
          {actionLabel}
        </button>
      )}
      <Tooltip label={dismissLabel}>
        <button
          type="button"
          aria-label={dismissLabel}
          onClick={onDismiss}
          className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-sm text-on-inverse/70 transition-colors hover:bg-white/10 hover:text-on-inverse"
        >
          <X size={16} aria-hidden />
        </button>
      </Tooltip>
    </div>
  );
}
