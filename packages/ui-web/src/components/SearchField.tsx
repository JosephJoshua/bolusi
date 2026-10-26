import { clsx } from 'clsx';
import { Search, X } from 'lucide-react';
import { forwardRef } from 'react';

import { Kbd } from './Kbd.js';

/** The page's search. The placeholder says what it finds, so there is no label above it. */
export const SearchField = forwardRef<
  HTMLInputElement,
  {
    readonly value: string;
    readonly onChange: (value: string) => void;
    readonly placeholder: string;
    /** The accessible name, such as "Cari". */
    readonly label: string;
    readonly clearLabel: string;
    readonly shortcut?: string | undefined;
    readonly className?: string | undefined;
    readonly testId?: string | undefined;
  }
>(function SearchField(
  { value, onChange, placeholder, label, clearLabel, shortcut, className, testId },
  ref,
) {
  return (
    <div className={clsx('relative', className)}>
      <Search
        size={18}
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-3 my-auto text-text-muted"
      />
      <input
        ref={ref}
        type="search"
        aria-label={label}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && value !== '') {
            event.stopPropagation();
            onChange('');
          }
        }}
        data-testid={testId}
        className="h-10 w-full rounded-sm border border-border bg-surface-alt pl-10 pr-12 text-body text-text placeholder:text-text-muted transition-colors focus:border-primary focus:bg-surface focus:outline-none focus:ring-2 focus:ring-primary/25 [&::-webkit-search-cancel-button]:hidden"
      />
      <div className="absolute inset-y-0 right-2 flex items-center">
        {value === '' ? (
          shortcut === undefined ? null : (
            <Kbd>{shortcut}</Kbd>
          )
        ) : (
          <button
            type="button"
            aria-label={clearLabel}
            onClick={() => onChange('')}
            className="flex size-7 cursor-pointer items-center justify-center rounded-xs text-text-muted hover:bg-surface hover:text-text"
          >
            <X size={16} aria-hidden />
          </button>
        )}
      </div>
    </div>
  );
});
