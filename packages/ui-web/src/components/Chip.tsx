import { clsx } from 'clsx';
import type { LucideIcon } from 'lucide-react';

export type ChipTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

const TONE: Readonly<Record<ChipTone, string>> = {
  neutral: 'bg-surface-alt text-text',
  info: 'bg-info-bg text-info',
  success: 'bg-success-bg text-on-success-bg',
  warning: 'bg-warning-bg text-warning',
  danger: 'bg-danger-bg text-on-danger-bg',
};

/** A status or fact in a few words. It always has an icon, so colour never carries it alone. */
export function Chip({
  label,
  icon: Icon,
  tone = 'neutral',
  className,
}: {
  readonly label: string;
  readonly icon: LucideIcon;
  readonly tone?: ChipTone;
  readonly className?: string;
}): React.JSX.Element {
  return (
    <span
      className={clsx(
        'inline-flex h-6 max-w-full shrink-0 items-center gap-1 whitespace-nowrap rounded-xs px-2 text-small font-medium',
        TONE[tone],
        className,
      )}
    >
      <Icon size={14} aria-hidden className="shrink-0" />
      {label}
    </span>
  );
}

/** An on/off choice among several, such as an accessory left with the phone. */
export function ToggleChip({
  label,
  selected,
  onToggle,
  skipTab = false,
}: {
  readonly label: string;
  readonly selected: boolean;
  readonly onToggle: () => void;
  /** A mouse shortcut for a field beside it: Tab passes it by instead of stopping at each chip. */
  readonly skipTab?: boolean;
}): React.JSX.Element {
  return (
    <button
      type="button"
      tabIndex={skipTab ? -1 : undefined}
      aria-pressed={selected}
      onClick={onToggle}
      className={clsx(
        'inline-flex h-8 shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-full border px-3 text-small font-medium transition-colors',
        selected
          ? 'border-primary bg-info-bg text-info'
          : 'border-border bg-surface text-text hover:bg-surface-alt',
      )}
    >
      {label}
    </button>
  );
}
