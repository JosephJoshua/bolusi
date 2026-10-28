// One choice from a list that comes from the outside world (the printers on this PC), as full-width
// rows with a radio mark. Arrow keys move between rows, as in any radio group; a long list scrolls
// inside its frame instead of pushing the page down.
import * as ToggleGroup from '@radix-ui/react-toggle-group';
import { clsx } from 'clsx';
import { Check } from 'lucide-react';

export interface ChoiceOption<T extends string> {
  readonly value: T;
  readonly label: string;
}

export function ChoiceList<T extends string>({
  options,
  value,
  onChange,
  label,
  testId,
}: {
  readonly options: readonly ChoiceOption<T>[];
  readonly value: T | null;
  readonly onChange: (value: T) => void;
  /** The question the rows answer, read aloud. */
  readonly label: string;
  readonly testId?: string | undefined;
}): React.JSX.Element {
  return (
    <ToggleGroup.Root
      type="single"
      orientation="vertical"
      value={value ?? ''}
      onValueChange={(next) => {
        // Re-clicking the chosen row keeps it.
        if (next !== '') onChange(next as T);
      }}
      aria-label={label}
      data-testid={testId}
      className="flex max-h-72 flex-col overflow-y-auto rounded-sm border border-border bg-surface"
    >
      {options.map((option) => (
        <ToggleGroup.Item
          key={option.value}
          value={option.value}
          data-testid={testId === undefined ? undefined : `${testId}.option`}
          className={clsx(
            'group flex min-h-10 cursor-pointer items-center gap-3 border-b border-border px-3 py-2 text-left text-body text-text last:border-b-0',
            'hover:bg-surface-alt data-[state=on]:bg-info-bg data-[state=on]:font-semibold',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary',
          )}
        >
          <span
            aria-hidden
            className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-surface group-data-[state=on]:border-primary group-data-[state=on]:bg-primary"
          >
            <Check
              size={12}
              strokeWidth={3}
              className="hidden text-on-primary group-data-[state=on]:block"
            />
          </span>
          <span className="min-w-0 flex-1 break-words">{option.label}</span>
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
