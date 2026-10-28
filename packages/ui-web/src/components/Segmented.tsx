// One choice among a few equals, as a row of joined buttons (a condition check's state, the kind
// of a price line). Arrow keys move between options, as in any radio group.
import * as ToggleGroup from '@radix-ui/react-toggle-group';
import { clsx } from 'clsx';

export interface SegmentedOption<T extends string> {
  readonly value: T;
  readonly label: string;
  /** Colours the chosen option by meaning, such as a check marked broken. */
  readonly tone?: 'neutral' | 'success' | 'danger';
}

const CHOSEN = {
  // A plain choice is marked quietly; only meaningful states take a colour.
  neutral:
    'data-[state=on]:bg-surface-alt data-[state=on]:font-semibold data-[state=on]:text-text data-[state=on]:shadow-[inset_0_0_0_1px_var(--b-border)]',
  success: 'data-[state=on]:bg-success data-[state=on]:text-white',
  danger: 'data-[state=on]:bg-danger data-[state=on]:text-white',
};

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  size = 'md',
  testId,
}: {
  readonly options: readonly SegmentedOption<T>[];
  readonly value: T | null;
  readonly onChange: (value: T) => void;
  /** The question the options answer, read aloud. */
  readonly label: string;
  readonly size?: 'sm' | 'md';
  readonly testId?: string | undefined;
}): React.JSX.Element {
  return (
    <ToggleGroup.Root
      type="single"
      value={value ?? ''}
      onValueChange={(next) => {
        // Re-clicking the chosen option keeps it: one of these is always the answer.
        if (next !== '') onChange(next as T);
      }}
      aria-label={label}
      data-testid={testId}
      className="inline-flex shrink-0 self-start rounded-sm border border-border bg-surface p-0.5"
    >
      {options.map((option) => (
        <ToggleGroup.Item
          key={option.value}
          value={option.value}
          data-testid={testId === undefined ? undefined : `${testId}.${option.value}`}
          className={clsx(
            'cursor-pointer whitespace-nowrap rounded-xs font-medium text-text-muted transition-colors hover:text-text',
            size === 'sm' ? 'h-7 px-2 text-small' : 'h-8 px-3 text-small',
            CHOSEN[option.tone ?? 'neutral'],
          )}
        >
          {option.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
