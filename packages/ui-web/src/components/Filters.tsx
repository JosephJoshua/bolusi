// Compact filters for a table's toolbar: one button per facet that opens a small popover, and a
// summary of the choice on the button itself, so the toolbar shows what is narrowing the list
// without a separate row of chips.
import * as RadixMenu from '@radix-ui/react-dropdown-menu';
import * as RadixPopover from '@radix-ui/react-popover';
import { clsx } from 'clsx';
import { Check, ChevronDown, Columns3, X } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';

import { OverflowText } from './OverflowText.js';
import { Tooltip } from './Tooltip.js';

const POPOVER =
  'z-50 origin-(--radix-popover-content-transform-origin) rounded-sm border border-border bg-surface shadow-lg focus:outline-none data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out';

/**
 * A facet's button and popover. Empty, it reads as the facet's name; with a choice, it shows the
 * choice and an × to clear it in one click.
 */
export function FilterPopover({
  label,
  summary,
  clearLabel,
  onClear,
  children,
  width = 280,
  testId,
}: {
  readonly label: string;
  /** What is chosen, such as "Dikerjakan" or "3 teknisi"; null when the facet is open. */
  readonly summary: string | null;
  readonly clearLabel: string;
  readonly onClear: () => void;
  readonly children: ReactNode;
  readonly width?: number;
  readonly testId?: string | undefined;
}): React.JSX.Element {
  const active = summary !== null;
  return (
    <RadixPopover.Root>
      <div
        className={clsx(
          'inline-flex h-8 shrink-0 items-center rounded-sm border text-small transition-colors',
          active ? 'border-primary/40 bg-info-bg' : 'border-border bg-surface hover:bg-surface-alt',
        )}
      >
        <RadixPopover.Trigger asChild>
          <button
            type="button"
            data-testid={testId}
            className={clsx(
              'inline-flex h-full cursor-pointer items-center gap-2 rounded-sm pl-3 font-semibold',
              active ? 'pr-1 text-text' : 'pr-3 text-text-muted hover:text-text @min-[54rem]:pr-2',
            )}
          >
            <span>{label}</span>
            {active ? (
              <OverflowText text={summary} className="max-w-48 font-normal text-info" />
            ) : (
              // A narrow toolbar (its nearest `@container`) drops the arrow, so every filter fits.
              <ChevronDown size={14} aria-hidden className="hidden @min-[54rem]:block" />
            )}
          </button>
        </RadixPopover.Trigger>
        {active ? (
          <Tooltip label={`${clearLabel}: ${label}`}>
            <button
              type="button"
              aria-label={`${clearLabel}: ${label}`}
              onClick={onClear}
              data-testid={testId === undefined ? undefined : `${testId}.clear`}
              className="mr-1 flex size-6 cursor-pointer items-center justify-center rounded-xs text-text-muted hover:bg-black/5 hover:text-text"
            >
              <X size={14} aria-hidden />
            </button>
          </Tooltip>
        ) : null}
      </div>
      <RadixPopover.Portal>
        <RadixPopover.Content
          align="start"
          sideOffset={6}
          className={POPOVER}
          style={{ width }}
          data-testid={testId === undefined ? undefined : `${testId}.popover`}
        >
          {children}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}

export interface FilterOption {
  readonly value: string;
  readonly label: string;
  /** How many rows have it, when the caller knows. */
  readonly count?: number | undefined;
}

/**
 * A multi-choice facet (status, technician, brand). Long lists get a search box; the caller passes
 * `match` so the search is the app's own fuzzy match rather than a plain substring test.
 */
export function OptionsFilter({
  label,
  options,
  selected,
  onChange,
  summarize,
  labels,
  match,
  testId,
}: {
  readonly label: string;
  readonly options: readonly FilterOption[];
  readonly selected: readonly string[];
  readonly onChange: (selected: string[]) => void;
  /** The button's text for a choice of several, such as "3 teknisi". */
  readonly summarize: (count: number) => string;
  readonly labels: {
    readonly clear: string;
    readonly search: string;
    readonly noMatches: string;
  };
  /** The options that match typed text, best first. Shown when the list is long. */
  readonly match?: ((options: readonly FilterOption[], text: string) => FilterOption[]) | undefined;
  readonly testId?: string | undefined;
}): React.JSX.Element {
  const [text, setText] = useState('');
  const searchable = match !== undefined && options.length > 8;
  const shown = useMemo(
    () => (searchable && text.trim() !== '' ? match(options, text.trim()) : options),
    [match, options, searchable, text],
  );
  const chosen = options.filter((option) => selected.includes(option.value));
  const summary =
    chosen.length === 0 ? null : chosen.length === 1 ? chosen[0]!.label : summarize(chosen.length);
  const toggle = (value: string): void =>
    onChange(
      selected.includes(value)
        ? selected.filter((other) => other !== value)
        : // Kept in the options' order, so the summary and the query read the same way each time.
          options
            .map((option) => option.value)
            .filter((other) => other === value || selected.includes(other)),
    );
  return (
    <FilterPopover
      label={label}
      summary={summary}
      clearLabel={labels.clear}
      onClear={() => onChange([])}
      testId={testId}
    >
      {searchable ? (
        <div className="border-b border-border p-2">
          <input
            type="search"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={labels.search}
            aria-label={labels.search}
            className="h-8 w-full rounded-xs border border-border bg-surface-alt px-2 text-body text-text placeholder:text-text-muted focus:border-primary focus:bg-surface focus:outline-none"
          />
        </div>
      ) : null}
      <div role="group" aria-label={label} className="max-h-72 overflow-y-auto p-1">
        {shown.length === 0 ? (
          <p className="px-3 py-3 text-small text-text-muted">{labels.noMatches}</p>
        ) : (
          shown.map((option) => {
            const on = selected.includes(option.value);
            return (
              <button
                key={option.value}
                type="button"
                role="checkbox"
                aria-checked={on}
                onClick={() => toggle(option.value)}
                data-testid={testId === undefined ? undefined : `${testId}.option.${option.value}`}
                className="flex min-h-9 w-full cursor-pointer items-center gap-3 rounded-xs px-2 py-1.5 text-left text-body text-text hover:bg-surface-alt focus-visible:bg-surface-alt focus-visible:outline-none"
              >
                <span
                  aria-hidden
                  className={clsx(
                    'flex size-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors',
                    on ? 'border-primary bg-primary text-on-primary' : 'border-text-muted/60',
                  )}
                >
                  {on ? <Check size={12} strokeWidth={3} /> : null}
                </span>
                <span className="min-w-0 flex-1 break-words">{option.label}</span>
                {option.count === undefined ? null : (
                  <span className="tabular text-small text-text-muted">{option.count}</span>
                )}
              </button>
            );
          })
        )}
      </div>
    </FilterPopover>
  );
}

export interface ColumnChoice {
  readonly id: string;
  readonly label: string;
  readonly visible: boolean;
  /** A column the table cannot do without, such as the ticket number. */
  readonly locked?: boolean;
}

/** The "Kolom" menu: which columns the table shows. */
export function ColumnsMenu({
  label,
  columns,
  onToggle,
  testId,
}: {
  readonly label: string;
  readonly columns: readonly ColumnChoice[];
  readonly onToggle: (id: string, visible: boolean) => void;
  readonly testId?: string | undefined;
}): React.JSX.Element {
  return (
    <RadixMenu.Root>
      {/* In a narrow toolbar (its nearest `@container`) only the icon shows, like a collapsed
          FilterToggle, so the filters beside it keep their room. */}
      <Tooltip label={label}>
        <RadixMenu.Trigger asChild>
          <button
            type="button"
            aria-label={label}
            data-testid={testId}
            className="inline-flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-sm border border-border bg-surface px-3 text-small font-semibold text-text-muted transition-colors hover:bg-surface-alt hover:text-text"
          >
            <Columns3 size={14} aria-hidden />
            <span aria-hidden className="hidden whitespace-nowrap @min-[54rem]:inline">
              {label}
            </span>
          </button>
        </RadixMenu.Trigger>
      </Tooltip>
      <RadixMenu.Portal>
        <RadixMenu.Content
          align="end"
          sideOffset={6}
          className="z-50 min-w-48 origin-(--radix-dropdown-menu-content-transform-origin) rounded-sm border border-border bg-surface p-1 shadow-lg data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out"
        >
          {columns.map((column) => (
            <RadixMenu.CheckboxItem
              key={column.id}
              checked={column.visible}
              disabled={column.locked === true}
              // Stays open, so several columns can be switched in one visit.
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(checked) => onToggle(column.id, checked)}
              data-testid={testId === undefined ? undefined : `${testId}.${column.id}`}
              className="flex h-9 cursor-pointer select-none items-center gap-3 rounded-xs px-2 text-body text-text outline-none data-[disabled]:cursor-default data-[disabled]:text-text-muted data-[highlighted]:bg-surface-alt"
            >
              <span
                aria-hidden
                className={clsx(
                  'flex size-4 items-center justify-center rounded-[4px] border',
                  column.visible
                    ? 'border-primary bg-primary text-on-primary'
                    : 'border-text-muted/60',
                  column.locked === true && 'opacity-50',
                )}
              >
                {column.visible ? <Check size={12} strokeWidth={3} /> : null}
              </span>
              {column.label}
            </RadixMenu.CheckboxItem>
          ))}
        </RadixMenu.Content>
      </RadixMenu.Portal>
    </RadixMenu.Root>
  );
}

export interface DayRangeValue {
  readonly from: string | null;
  readonly to: string | null;
}

export interface DayRangePreset {
  readonly key: string;
  readonly label: string;
  readonly range: DayRangeValue;
}

/**
 * A date facet: quick choices (today, the last 7 days…) and a from–to pair for anything else.
 * Days are yyyy-mm-dd, as the browser's date fields read and write them.
 */
export function DayRangeFilter({
  label,
  value,
  presets,
  onChange,
  summarize,
  labels,
  testId,
}: {
  readonly label: string;
  readonly value: DayRangeValue | null;
  readonly presets: readonly DayRangePreset[];
  readonly onChange: (value: DayRangeValue | null) => void;
  /** The button's text for a range that is not a quick choice. */
  readonly summarize: (value: DayRangeValue) => string;
  readonly labels: { readonly clear: string; readonly from: string; readonly to: string };
  readonly testId?: string | undefined;
}): React.JSX.Element {
  const preset = presets.find(
    (candidate) =>
      value !== null && candidate.range.from === value.from && candidate.range.to === value.to,
  );
  const summary = value === null ? null : (preset?.label ?? summarize(value));
  const field =
    'h-8 w-full rounded-xs border border-border bg-surface px-2 text-body text-text focus:border-primary focus:outline-none';
  const set = (from: string | null, to: string | null): void =>
    onChange(from === null && to === null ? null : { from, to });
  return (
    <FilterPopover
      label={label}
      summary={summary}
      clearLabel={labels.clear}
      onClear={() => onChange(null)}
      // Wide enough for two date fields to show a whole dd/mm/yyyy each.
      width={340}
      testId={testId}
    >
      <div role="radiogroup" aria-label={label} className="p-1">
        {presets.map((candidate) => {
          const on = candidate === preset;
          return (
            <button
              key={candidate.key}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onChange(candidate.range)}
              data-testid={testId === undefined ? undefined : `${testId}.preset.${candidate.key}`}
              className="flex min-h-9 w-full cursor-pointer items-center gap-3 rounded-xs px-2 py-1.5 text-left text-body text-text hover:bg-surface-alt focus-visible:bg-surface-alt focus-visible:outline-none"
            >
              <span className="flex w-4 justify-center text-primary">
                {on ? <Check size={14} aria-hidden /> : null}
              </span>
              {candidate.label}
            </button>
          );
        })}
      </div>
      <div className="grid grid-cols-2 gap-2 border-t border-border p-3">
        <label className="flex flex-col gap-1 text-small text-text-muted">
          {labels.from}
          <input
            type="date"
            value={value?.from ?? ''}
            max={value?.to ?? undefined}
            onChange={(event) =>
              set(event.target.value === '' ? null : event.target.value, value?.to ?? null)
            }
            className={field}
          />
        </label>
        <label className="flex flex-col gap-1 text-small text-text-muted">
          {labels.to}
          <input
            type="date"
            value={value?.to ?? ''}
            min={value?.from ?? undefined}
            onChange={(event) =>
              set(value?.from ?? null, event.target.value === '' ? null : event.target.value)
            }
            className={field}
          />
        </label>
      </div>
    </FilterPopover>
  );
}

/** An on/off facet, such as "prices waiting for the customer", drawn like the other filters. */
export function FilterToggle({
  label,
  pressed,
  onChange,
  icon: Icon,
  collapse = false,
  testId,
}: {
  readonly label: string;
  readonly pressed: boolean;
  readonly onChange: (pressed: boolean) => void;
  readonly icon?: React.ComponentType<{ size?: number; 'aria-hidden'?: boolean }> | undefined;
  /**
   * In a narrow toolbar (its nearest `@container`), only the icon shows, with the label as its
   * tooltip, so the label is never cut off. Needs an icon.
   */
  readonly collapse?: boolean | undefined;
  readonly testId?: string | undefined;
}): React.JSX.Element {
  const collapsible = collapse && Icon !== undefined;
  const button = (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={collapsible ? label : undefined}
      onClick={() => onChange(!pressed)}
      data-testid={testId}
      className={clsx(
        'inline-flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-sm border px-3 text-small font-semibold transition-colors',
        pressed
          ? 'border-primary/40 bg-info-bg text-text'
          : 'border-border bg-surface text-text-muted hover:bg-surface-alt hover:text-text',
      )}
    >
      {Icon === undefined ? null : <Icon size={14} aria-hidden />}
      {collapsible ? (
        <span aria-hidden className="hidden whitespace-nowrap @min-[54rem]:inline">
          {label}
        </span>
      ) : (
        label
      )}
    </button>
  );
  return collapsible ? <Tooltip label={label}>{button}</Tooltip> : button;
}
