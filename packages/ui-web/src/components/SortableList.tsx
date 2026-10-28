// Rows the owner puts in order: drag a row by its handle, or focus the handle and press the arrow
// keys. The caller renders each row and decides where the handle goes; the list only reports moves.
import { clsx } from 'clsx';
import { GripVertical } from 'lucide-react';
import { useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';

import { Tooltip } from './Tooltip.js';

export function SortableList<T>({
  items,
  keyOf,
  onMove,
  renderItem,
  handleLabel,
  label,
  className,
  testId,
}: {
  readonly items: readonly T[];
  readonly keyOf: (item: T) => string;
  /** Move the row at `from` to `to`. */
  readonly onMove: (from: number, to: number) => void;
  /** The row; `handle` is null for a row that holds still (being edited, or a list not in order). */
  readonly renderItem: (item: T, handle: ReactNode, index: number) => ReactNode;
  /** The handle's tooltip and accessible name, saying how to use it. */
  readonly handleLabel: string | null;
  /** The list's accessible name. */
  readonly label: string;
  readonly className?: string | undefined;
  readonly testId?: string | undefined;
}): React.JSX.Element {
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);

  const end = (): void => {
    setDragging(null);
    setOver(null);
  };

  return (
    <ul aria-label={label} data-testid={testId} className={clsx('flex flex-col', className)}>
      {items.map((item, index) => {
        const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
          const to =
            event.key === 'ArrowUp' ? index - 1 : event.key === 'ArrowDown' ? index + 1 : null;
          if (to === null || to < 0 || to >= items.length) return;
          event.preventDefault();
          onMove(index, to);
          // The handle moves with its row; keep the focus on it so the arrows keep working.
          const button = event.currentTarget;
          requestAnimationFrame(() => button.focus());
        };
        const handle =
          handleLabel === null ? null : (
            <Tooltip label={handleLabel}>
              <button
                type="button"
                aria-label={handleLabel}
                draggable
                onDragStart={(event: DragEvent<HTMLButtonElement>) => {
                  event.dataTransfer.effectAllowed = 'move';
                  // Firefox starts a drag only with data set.
                  event.dataTransfer.setData('text/plain', keyOf(item));
                  const row = event.currentTarget.closest('li');
                  if (row !== null) event.dataTransfer.setDragImage(row, 16, 16);
                  setDragging(index);
                }}
                onDragEnd={end}
                onKeyDown={onKeyDown}
                data-testid={testId === undefined ? undefined : `${testId}.handle`}
                className="flex size-8 shrink-0 cursor-grab items-center justify-center rounded-sm text-text-muted hover:bg-surface-alt hover:text-text active:cursor-grabbing"
              >
                <GripVertical size={16} aria-hidden />
              </button>
            </Tooltip>
          );
        return (
          <li
            key={keyOf(item)}
            onDragOver={(event) => {
              if (dragging === null) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              setOver(index);
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (dragging !== null && dragging !== index) onMove(dragging, index);
              end();
            }}
            className={clsx(
              'relative',
              dragging === index && 'opacity-50',
              // Where the row lands: a line on the side it moves to.
              over === index &&
                dragging !== null &&
                dragging !== index &&
                (dragging < index
                  ? 'after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-primary'
                  : 'before:absolute before:inset-x-0 before:-top-px before:h-0.5 before:bg-primary'),
            )}
          >
            {renderItem(item, handle, index)}
          </li>
        );
      })}
    </ul>
  );
}
