import { clsx } from 'clsx';
import type { LucideIcon } from 'lucide-react';
import { forwardRef, type ButtonHTMLAttributes } from 'react';

import { Tooltip } from './Tooltip.js';

export interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'children' | 'aria-label'
> {
  readonly icon: LucideIcon;
  /** Read aloud and shown as a tooltip: an icon alone never carries the meaning. */
  readonly label: string;
  /** Shown beside the label in the tooltip, such as "Ctrl+B". */
  readonly shortcut?: string | undefined;
  readonly tooltipSide?: 'top' | 'bottom' | 'left' | 'right';
  readonly size?: 'sm' | 'md';
  readonly tone?: 'plain' | 'inverse';
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    icon: Icon,
    label,
    shortcut,
    tooltipSide,
    size = 'md',
    tone = 'plain',
    className,
    type = 'button',
    ...rest
  },
  ref,
) {
  return (
    <Tooltip label={label} shortcut={shortcut} side={tooltipSide}>
      <button
        ref={ref}
        type={type}
        aria-label={label}
        className={clsx(
          'inline-flex shrink-0 cursor-pointer items-center justify-center rounded-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40',
          size === 'sm' ? 'size-8' : 'size-9',
          tone === 'inverse'
            ? 'text-white hover:bg-white/15'
            : 'text-text-muted hover:bg-surface-alt hover:text-text',
          className,
        )}
        {...rest}
      >
        <Icon size={size === 'sm' ? 16 : 18} aria-hidden />
      </button>
    </Tooltip>
  );
});
