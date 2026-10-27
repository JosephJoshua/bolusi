// A table's footer: where the rows on screen sit in the whole list, how many to show at once, and
// page numbers to jump with. Page numbers start at 1, as people say them.
import * as RadixMenu from '@radix-ui/react-dropdown-menu';
import { clsx } from 'clsx';
import { Check, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';

export interface PaginationLabels {
  /** "1–50 dari 312" */
  readonly range: (from: number, to: number, total: number) => string;
  /** "50 per halaman" */
  readonly perPage: (size: number) => string;
  readonly previous: string;
  readonly next: string;
  /** The accessible name of a page button, such as "Halaman 3". */
  readonly page: (page: number) => string;
  /** The footer's accessible name. */
  readonly label: string;
}

/** The page numbers to draw: the first, the last, and two either side of the current one. */
export function pageWindow(page: number, pageCount: number): (number | 'gap')[] {
  const pages = new Set([1, pageCount, page - 2, page - 1, page, page + 1, page + 2]);
  const shown = [...pages].filter((n) => n >= 1 && n <= pageCount).sort((a, b) => a - b);
  const out: (number | 'gap')[] = [];
  for (const n of shown) {
    const last = out[out.length - 1];
    // A single missing number is drawn rather than hidden behind a gap that saves no room.
    if (typeof last === 'number' && n - last === 2) out.push(last + 1);
    else if (typeof last === 'number' && n - last > 2) out.push('gap');
    out.push(n);
  }
  return out;
}

export function Pagination({
  page,
  pageSize,
  total,
  pageSizes,
  onPageChange,
  onPageSizeChange,
  labels,
  testId,
}: {
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly pageSizes: readonly number[];
  readonly onPageChange: (page: number) => void;
  readonly onPageSizeChange: (size: number) => void;
  readonly labels: PaginationLabels;
  readonly testId?: string | undefined;
}): React.JSX.Element {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const step =
    'flex h-8 min-w-8 cursor-pointer items-center justify-center rounded-xs px-2 text-small font-semibold tabular transition-colors disabled:cursor-not-allowed disabled:text-text-disabled';
  return (
    <nav
      aria-label={labels.label}
      data-testid={testId}
      className="flex h-12 shrink-0 items-center gap-4 border-t border-border px-6"
    >
      <p
        className="tabular text-small text-text-muted"
        data-testid={`${testId ?? 'pagination'}.range`}
      >
        {labels.range(from, to, total)}
      </p>
      <RadixMenu.Root>
        <RadixMenu.Trigger asChild>
          <button
            type="button"
            data-testid={`${testId ?? 'pagination'}.size`}
            className="inline-flex h-8 cursor-pointer items-center gap-1 rounded-xs px-2 text-small text-text-muted transition-colors hover:bg-surface-alt hover:text-text"
          >
            {labels.perPage(pageSize)}
            <ChevronDown size={14} aria-hidden />
          </button>
        </RadixMenu.Trigger>
        <RadixMenu.Portal>
          <RadixMenu.Content
            side="top"
            align="start"
            sideOffset={4}
            className="z-50 min-w-40 origin-(--radix-dropdown-menu-content-transform-origin) rounded-sm border border-border bg-surface p-1 shadow-lg data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out"
          >
            {pageSizes.map((size) => (
              <RadixMenu.Item
                key={size}
                onSelect={() => onPageSizeChange(size)}
                className="flex h-9 cursor-pointer select-none items-center gap-3 rounded-xs px-2 text-body text-text outline-none data-[highlighted]:bg-surface-alt"
              >
                <span className="flex w-4 justify-center text-primary">
                  {size === pageSize ? <Check size={14} aria-hidden /> : null}
                </span>
                {labels.perPage(size)}
              </RadixMenu.Item>
            ))}
          </RadixMenu.Content>
        </RadixMenu.Portal>
      </RadixMenu.Root>
      <div className="ml-auto flex items-center gap-1">
        <button
          type="button"
          aria-label={labels.previous}
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          className={clsx(step, 'text-text enabled:hover:bg-surface-alt')}
        >
          <ChevronLeft size={16} aria-hidden />
        </button>
        {pageWindow(page, pageCount).map((entry, index) =>
          entry === 'gap' ? (
            <span
              key={`gap-${String(index)}`}
              aria-hidden
              className="px-1 text-small text-text-muted"
            >
              …
            </span>
          ) : (
            <button
              key={entry}
              type="button"
              aria-label={labels.page(entry)}
              aria-current={entry === page ? 'page' : undefined}
              onClick={() => onPageChange(entry)}
              data-testid={`${testId ?? 'pagination'}.page.${String(entry)}`}
              className={clsx(
                step,
                entry === page
                  ? 'bg-info-bg text-primary'
                  : 'text-text-muted hover:bg-surface-alt hover:text-text',
              )}
            >
              {entry}
            </button>
          ),
        )}
        <button
          type="button"
          aria-label={labels.next}
          disabled={page >= pageCount}
          onClick={() => onPageChange(page + 1)}
          data-testid={`${testId ?? 'pagination'}.next`}
          className={clsx(step, 'text-text enabled:hover:bg-surface-alt')}
        >
          <ChevronRight size={16} aria-hidden />
        </button>
      </div>
    </nav>
  );
}
