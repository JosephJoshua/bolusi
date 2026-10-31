// Buttons in three levels, as on the phone: a filled primary, an outlined secondary and a text
// button for quiet actions beside the fact they change. Danger has a filled form for the confirming
// step of a destructive action and a text form for the entry point, which is set apart.
import { clsx } from 'clsx';
import type { LucideIcon } from 'lucide-react';
import {
  forwardRef,
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';

import { Kbd } from './Kbd.js';
import { Spinner } from './Spinner.js';

export type ButtonVariant = 'primary' | 'secondary' | 'text' | 'danger' | 'dangerText';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  readonly label: string;
  readonly variant?: ButtonVariant | undefined;
  readonly size?: ButtonSize | undefined;
  readonly icon?: LucideIcon | undefined;
  /** A keyboard shortcut shown after the label, such as "F2". */
  readonly shortcut?: string | undefined;
  /** Shows a spinner and blocks presses while the action runs. */
  readonly busy?: boolean | undefined;
  readonly trailing?: ReactNode;
}

const VARIANT: Readonly<Record<ButtonVariant, string>> = {
  primary:
    'bg-primary text-on-primary hover:bg-primary-pressed disabled:bg-surface-alt disabled:text-text-disabled',
  secondary:
    'border border-border bg-surface text-text hover:bg-surface-alt disabled:text-text-disabled',
  text: 'text-primary hover:bg-info-bg disabled:text-text-disabled disabled:hover:bg-transparent',
  danger:
    'bg-danger text-on-danger hover:bg-danger-pressed disabled:bg-surface-alt disabled:text-text-disabled',
  dangerText:
    'text-danger hover:bg-danger-bg disabled:text-text-disabled disabled:hover:bg-transparent',
};

const SIZE: Readonly<Record<ButtonSize, string>> = {
  sm: 'h-8 px-3 text-small',
  md: 'h-9 px-4 text-body',
  lg: 'h-11 px-6 text-body',
};

/** Text buttons sit on the text edge of their column, so their padding is tighter. */
const TEXT_SIZE: Readonly<Record<ButtonSize, string>> = {
  sm: 'h-8 px-2 text-small',
  md: 'h-9 px-2 text-body',
  lg: 'h-11 px-3 text-body',
};

const BASE =
  'inline-flex shrink-0 cursor-pointer select-none items-center justify-center gap-2 whitespace-nowrap rounded-sm font-semibold transition-[color,background-color,border-color,box-shadow,scale] duration-150';

function buttonClass(variant: ButtonVariant, size: ButtonSize): string {
  const textual = variant === 'text' || variant === 'dangerText';
  return clsx(BASE, VARIANT[variant], (textual ? TEXT_SIZE : SIZE)[size]);
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    label,
    variant = 'secondary',
    size = 'md',
    icon: Icon,
    shortcut,
    busy = false,
    trailing,
    className,
    disabled,
    type = 'button',
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled === true || busy}
      aria-busy={busy || undefined}
      className={clsx(
        buttonClass(variant, size),
        'enabled:active:scale-[0.98] disabled:cursor-not-allowed',
        className,
      )}
      {...rest}
    >
      {busy ? <Spinner size={16} /> : Icon === undefined ? null : <Icon size={16} aria-hidden />}
      <span>{label}</span>
      {shortcut === undefined ? null : (
        // A disabled filled button turns grey, where a light key would vanish.
        <Kbd
          tone={
            (variant === 'primary' || variant === 'danger') && disabled !== true && !busy
              ? 'inverse'
              : 'plain'
          }
        >
          {shortcut}
        </Kbd>
      )}
      {trailing}
    </button>
  );
});

export interface ButtonLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'children'> {
  readonly label: string;
  readonly href: string;
  readonly variant?: Exclude<ButtonVariant, 'danger' | 'dangerText'> | undefined;
  readonly size?: ButtonSize | undefined;
  readonly icon?: LucideIcon | undefined;
}

/** A link that looks like a button: an action that leaves the page (WhatsApp, a call). */
export function ButtonLink({
  label,
  variant = 'secondary',
  size = 'md',
  icon: Icon,
  className,
  ...rest
}: ButtonLinkProps): React.JSX.Element {
  return (
    <a className={clsx(buttonClass(variant, size), 'active:scale-[0.98]', className)} {...rest}>
      {Icon === undefined ? null : <Icon size={16} aria-hidden />}
      <span>{label}</span>
    </a>
  );
}
