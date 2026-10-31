// Views of one list (the board's queues), as underlined tabs with an optional count.
import { clsx } from 'clsx';
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';

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
  const layoutKey = items
    .map((item) => `${item.value}:${item.label}:${String(item.count)}`)
    .join('|');
  // One underline that glides to the chosen tab, measured from the tab itself so any label fits.
  const list = useRef<HTMLDivElement>(null);
  const [bar, setBar] = useState<{ left: number; top: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const tab = refs.current.get(value);
    const measure = (): void =>
      setBar((last) => {
        if (tab === undefined) return null;
        const next = {
          left: tab.offsetLeft,
          top: tab.offsetTop + tab.offsetHeight,
          width: tab.offsetWidth,
        };
        return last?.left === next.left && last.top === next.top && last.width === next.width
          ? last
          : next;
      });
    measure();
    if (tab === undefined) return;
    const observer = new ResizeObserver(measure);
    observer.observe(tab);
    // A narrower list moves the tab to another row without changing its size.
    if (list.current !== null) observer.observe(list.current);
    return () => observer.disconnect();
  }, [value, layoutKey]);
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
      ref={list}
      // Tabs that do not fit wrap to a second row: every view stays in sight, none behind a
      // sideways scroll. The rule under them is a shadow, so it draws under the last row.
      className="relative flex min-w-0 flex-wrap gap-x-6 shadow-[inset_0_-1px_0_var(--b-border)]"
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
              'inline-flex h-10 shrink-0 cursor-pointer items-center gap-2 whitespace-nowrap text-body font-semibold transition-colors',
              active ? 'text-text' : 'text-text-muted hover:text-text',
            )}
          >
            {item.label}
            {item.count === undefined ? null : (
              <span
                className={clsx(
                  'tabular rounded-full px-2 text-small font-semibold',
                  'transition-colors',
                  active ? 'bg-info-bg text-info' : 'bg-surface-alt text-text-muted',
                )}
              >
                {item.count}
              </span>
            )}
          </button>
        );
      })}
      {bar === null ? null : (
        <span
          aria-hidden
          className="pointer-events-none absolute h-0.5 -translate-y-full bg-primary transition-[left,top,width] duration-200 ease-out"
          style={{ left: bar.left, top: bar.top, width: bar.width }}
        />
      )}
    </div>
  );
}
