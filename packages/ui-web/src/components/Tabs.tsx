// Views of one list (the board's queues), as underlined tabs with an optional count.
import { clsx } from 'clsx';
import { useRef, type KeyboardEvent } from 'react';

export interface TabItem<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly count?: number | undefined;
}

export function Tabs<T extends string>({
  items,
  value,
  onChange,
  label,
  testId,
}: {
  readonly items: readonly TabItem<T>[];
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly label: string;
  readonly testId?: string | undefined;
}): React.JSX.Element {
  const refs = useRef(new Map<T, HTMLButtonElement>());
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const index = items.findIndex((item) => item.value === value);
    const target: Record<string, number> = {
      ArrowRight: index + 1,
      ArrowLeft: index - 1,
      Home: 0,
      End: items.length - 1,
    };
    if (!(event.key in target) || index < 0) return;
    event.preventDefault();
    const next = items[(target[event.key]! + items.length) % items.length]!;
    onChange(next.value);
    refs.current.get(next.value)?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      data-testid={testId}
      // The rule under the tabs is a shadow so a scrolling strip clips nothing.
      className="flex min-w-0 gap-6 overflow-x-auto overflow-y-hidden shadow-[inset_0_-1px_0_var(--b-border)]"
    >
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            ref={(node) => {
              if (node === null) refs.current.delete(item.value);
              else refs.current.set(item.value, node);
            }}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(item.value)}
            data-testid={testId === undefined ? undefined : `${testId}.${item.value}`}
            className={clsx(
              'inline-flex h-10 shrink-0 cursor-pointer items-center gap-2 whitespace-nowrap border-b-2 text-body font-semibold transition-colors',
              active
                ? 'border-primary text-text'
                : 'border-transparent text-text-muted hover:text-text',
            )}
          >
            {item.label}
            {item.count === undefined ? null : (
              <span
                className={clsx(
                  'tabular rounded-full px-2 text-small font-semibold',
                  active ? 'bg-info-bg text-info' : 'bg-surface-alt text-text-muted',
                )}
              >
                {item.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
