// An on/off setting that takes effect with the form it sits in: the label and an optional line
// under it on the left, the switch on the right. The whole row toggles, and the switch carries
// the label as its accessible name.
import { clsx } from 'clsx';
import { useId } from 'react';

export function Switch({
  label,
  caption,
  checked,
  onChange,
  disabled = false,
  className,
  testId,
}: {
  readonly label: string;
  readonly caption?: string | undefined;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly disabled?: boolean | undefined;
  readonly className?: string | undefined;
  readonly testId?: string | undefined;
}): React.JSX.Element {
  const id = useId();
  return (
    <div className={clsx('flex items-center justify-between gap-4', className)}>
      <label
        htmlFor={id}
        className={clsx(
          'flex min-w-0 flex-1 flex-col',
          disabled ? 'cursor-default' : 'cursor-pointer',
        )}
      >
        <span className="break-words text-body text-text">{label}</span>
        {caption === undefined ? null : (
          <span className="break-words text-small text-text-muted">{caption}</span>
        )}
      </label>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        data-testid={testId}
        className={clsx(
          'relative inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-150',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2',
          'disabled:cursor-not-allowed disabled:opacity-50',
          checked ? 'bg-primary' : 'bg-text-muted',
        )}
      >
        <span
          aria-hidden
          className={clsx(
            'inline-block size-5 rounded-full bg-surface shadow-sm transition-transform duration-150 motion-reduce:transition-none',
            checked ? 'translate-x-[18px]' : 'translate-x-0.5',
          )}
        />
      </button>
    </div>
  );
}
