import { clsx } from 'clsx';
import type { ReactNode } from 'react';

/** A keyboard key, shown beside an action so counter staff learn the shortcut by seeing it. */
export function Kbd({
  children,
  tone = 'plain',
}: {
  readonly children: ReactNode;
  readonly tone?: 'plain' | 'inverse';
}): React.JSX.Element {
  return (
    <kbd
      className={clsx(
        'inline-flex h-5 min-w-5 items-center justify-center rounded-xs px-1 font-sans text-small font-semibold leading-none',
        tone === 'inverse'
          ? 'bg-white/20 text-on-primary'
          : 'border border-border bg-surface-alt text-text-muted',
      )}
    >
      {children}
    </kbd>
  );
}
