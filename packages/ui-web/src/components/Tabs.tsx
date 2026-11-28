// Views of one list (the board's queues), as underlined tabs with an optional count. They stay on
// one line: views that do not fit scroll sideways (with room at the end, so the last one can
// scroll clear of the fade) (the mouse wheel scrolls them too), an edge with
// more behind it fades, and the chosen tab is brought into sight. Wrapped onto a second row they
// read as two separate sets of tabs (Joseph, 2026-11-28).
import { clsx } from 'clsx';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';

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
    if (list.current !== null) observer.observe(list.current);
    return () => observer.disconnect();
  }, [value, layoutKey]);

  // Which edges have tabs past them, so each can fade to say the row goes on.
  const [more, setMore] = useState({ start: false, end: false });
  const updateEdges = useCallback((): void => {
    const el = list.current;
    if (el === null) return;
    const start = el.scrollLeft > 1;
    const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setMore((last) => (last.start === start && last.end === end ? last : { start, end }));
  }, []);
  // The chosen tab in sight, clear of the fade, whenever it changes or the row is resized (an
  // open servisan narrows the board).
  const reveal = useCallback((): void => {
    const el = list.current;
    const tab = refs.current.get(value);
    if (el !== null && tab !== undefined) {
      const left = tab.offsetLeft - FADE;
      const right = tab.offsetLeft + tab.offsetWidth + FADE;
      if (left < el.scrollLeft) el.scrollLeft = Math.max(0, left);
      else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth;
    }
    updateEdges();
  }, [value, updateEdges]);
  useLayoutEffect(() => {
    const el = list.current;
    if (el === null) return;
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(el);
    return () => observer.disconnect();
  }, [layoutKey, reveal]);
  // A mouse has no sideways wheel: its wheel scrolls the row while the pointer is over it.
  useEffect(() => {
    const el = list.current;
    if (el === null) return;
    const onWheel = (event: WheelEvent): void => {
      if (el.scrollWidth <= el.clientWidth || Math.abs(event.deltaX) > Math.abs(event.deltaY))
        return;
      event.preventDefault();
      el.scrollLeft += event.deltaY;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
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
    // The rule under the tabs is a shadow on the frame, so it stays put while the tabs scroll.
    <div className="relative min-w-0 shadow-[inset_0_-1px_0_var(--b-border)]">
      <div
        role="tablist"
        aria-label={label}
        onKeyDown={onKeyDown}
        onScroll={updateEdges}
        data-testid={testId}
        ref={list}
        className="relative flex min-w-0 gap-x-6 overflow-x-auto pe-8 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
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
      {(['start', 'end'] as const).map((side) =>
        more[side] ? (
          <span
            key={side}
            aria-hidden
            data-testid={testId === undefined ? undefined : `${testId}.fade.${side}`}
            className={clsx(
              'pointer-events-none absolute top-0 bottom-px',
              side === 'start' ? 'left-0' : 'right-0',
            )}
            style={{
              width: FADE,
              background: `linear-gradient(to ${side === 'start' ? 'left' : 'right'}, transparent, var(--b-surface))`,
            }}
          />
        ) : null,
      )}
    </div>
  );
}

/** How far an edge with more tabs behind it fades: enough to read as "more", not to hide a tab. */
const FADE = 32;
