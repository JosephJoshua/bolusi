// The states every list and page ships besides its data: loading, empty, error and no access.
import { clsx } from 'clsx';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export function Skeleton({ className }: { readonly className?: string }): React.JSX.Element {
  return <div aria-hidden className={clsx('animate-pulse rounded-xs bg-surface-alt', className)} />;
}

/** A centred message in place of content that is not there. */
export function StatePanel({
  icon: Icon,
  title,
  hint,
  action,
  tone = 'neutral',
  testId,
}: {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly hint?: string | undefined;
  readonly action?: ReactNode;
  readonly tone?: 'neutral' | 'success' | 'danger';
  readonly testId?: string | undefined;
}): React.JSX.Element {
  const mark = (
    <Icon
      size={40}
      aria-hidden
      className={
        tone === 'danger'
          ? 'text-danger'
          : tone === 'success'
            ? 'text-success'
            : 'text-text-disabled'
      }
      strokeWidth={1.5}
    />
  );
  return (
    <div
      data-testid={testId}
      className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center"
    >
      {tone === 'success' ? (
        // Success draws itself in from its leading edge, as if a pen made the tick.
        <span className="inline-flex animate-wipe-window overflow-hidden">
          <span className="inline-flex animate-wipe-content">{mark}</span>
        </span>
      ) : (
        mark
      )}
      <p className="mt-2 text-heading font-semibold text-text">{title}</p>
      {hint === undefined ? null : <p className="max-w-md text-body text-text-muted">{hint}</p>}
      {action === undefined ? null : <div className="mt-3">{action}</div>}
    </div>
  );
}
