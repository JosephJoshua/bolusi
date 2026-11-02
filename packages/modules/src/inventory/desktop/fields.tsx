// The item form's pieces on the counter PC: choices as chips that grow when a new value is typed,
// the phones a part fits from the phone catalog, and a whole-number quantity.
import { FieldFrame, IconButton, ToggleChip, controlClass, useSelectOnFocus } from '@bolusi/ui-web';
import { Minus, Plus, X } from 'lucide-react';
import { useId, useState } from 'react';

import { MAX_FIELD_VALUE } from '../categories.js';
import { ti } from '../i18n.js';
import { fitKey, fitLabel, useModelOptions } from '../model-options.js';
import type { ItemFitRow } from '../queries.js';

/** Values picked from chips; one more can be typed in place, and then reads as a chip too. */
export function ValuePicker({
  label,
  options,
  value,
  onChange,
  multiple,
  addLabel,
  newLabel,
  testId,
}: {
  readonly label: string;
  /** The category's own list, then values already in use; repeats are shown once. */
  readonly options: readonly string[];
  readonly value: readonly string[];
  readonly onChange: (value: readonly string[]) => void;
  readonly multiple: boolean;
  /** The chip that starts typing a new value ("Lainnya", "Tambah label"). */
  readonly addLabel: string;
  /** The typed value's accessible name ("Pilihan baru", "Label baru"). */
  readonly newLabel: string;
  readonly testId: string;
}): React.JSX.Element {
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState('');
  const shown = [...new Set([...options, ...value])];
  const toggle = (option: string): void => {
    if (value.includes(option)) onChange(value.filter((other) => other !== option));
    else onChange(multiple ? [...value, option] : [option]);
  };
  const add = (): void => {
    const next = typed.trim();
    if (next !== '' && !value.includes(next)) onChange(multiple ? [...value, next] : [next]);
    setTyped('');
    setTyping(false);
  };
  return (
    <div role="group" aria-label={label} data-testid={testId}>
      <p className="mb-2 text-small font-semibold text-text">{label}</p>
      <div className="flex flex-wrap gap-2">
        {shown.map((option) => (
          <ToggleChip
            key={option}
            label={option}
            selected={value.includes(option)}
            onToggle={() => toggle(option)}
            testId={`${testId}.option.${option}`}
          />
        ))}
        {typing ? (
          <input
            autoFocus
            aria-label={newLabel}
            placeholder={newLabel}
            value={typed}
            maxLength={MAX_FIELD_VALUE}
            onChange={(event) => setTyped(event.target.value)}
            // Enter adds the value here, not the whole form; leaving the box adds what was typed.
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                add();
              }
            }}
            onBlur={add}
            className="h-8 w-44 rounded-full border border-primary bg-surface px-3 text-small text-text placeholder:text-text-disabled focus:outline-none focus:ring-2 focus:ring-primary/25"
            data-testid={`${testId}.new`}
          />
        ) : (
          <button
            type="button"
            onClick={() => setTyping(true)}
            className="inline-flex h-8 shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-full border border-dashed border-border px-3 text-small font-medium text-text-muted hover:bg-surface-alt hover:text-text"
            data-testid={`${testId}.add`}
          >
            <Plus size={14} aria-hidden />
            {addLabel}
          </button>
        )}
      </div>
    </div>
  );
}

/** The phones a part fits: type a few letters, pick the model; an unknown one is added as typed. */
export function ModelsPicker({
  label = ti('inventory.form.fits'),
  value,
  onChange,
  testId,
}: {
  readonly label?: string | undefined;
  readonly value: readonly ItemFitRow[];
  readonly onChange: (value: readonly ItemFitRow[]) => void;
  readonly testId: string;
}): React.JSX.Element {
  const [text, setText] = useState('');
  const listId = useId();
  const { suggestions, offerTyped, hasCatalog, full, current } = useModelOptions(text, value);
  const add = (fit: ItemFitRow): void => {
    onChange([...value, { brand: fit.brand, model: fit.model }]);
    setText('');
  };
  const typed = text.trim();
  const inputId = useId();
  return (
    <div role="group" aria-label={label} data-testid={testId}>
      <label htmlFor={inputId} className="mb-2 block text-small font-semibold text-text">
        {label}
      </label>
      {value.length === 0 ? null : (
        <ul className="mb-2 flex flex-wrap gap-2">
          {value.map((fit) => (
            <li
              key={fitKey(fit)}
              className="inline-flex h-8 items-center gap-1 rounded-full border border-primary bg-info-bg pl-3 pr-1 text-small font-medium text-info"
            >
              {fitLabel(fit)}
              <IconButton
                icon={X}
                size="sm"
                label={`${ti('inventory.form.removeFit')} ${fitLabel(fit)}`}
                onClick={() => onChange(value.filter((other) => fitKey(other) !== fitKey(fit)))}
                data-testid={`${testId}.remove.${fitKey(fit)}`}
              />
            </li>
          ))}
        </ul>
      )}
      {full ? null : (
        <>
          <input
            id={inputId}
            type="search"
            placeholder={ti('inventory.form.fitsSearch')}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              // Enter takes the best match, or the typed model when the catalog has none, once the
              // search has caught up with what is typed.
              event.preventDefault();
              if (!current) return;
              const first = suggestions[0];
              if (first !== undefined) add(first);
              else if (offerTyped) add({ brand: '', model: typed });
            }}
            autoComplete="off"
            aria-controls={listId}
            className={`${controlClass(false)} h-10`}
            data-testid={`${testId}.search`}
          />
          {typed === '' ? null : (
            <ul id={listId} className="mt-1 flex flex-col" data-testid={`${testId}.suggestions`}>
              {suggestions.map((option) => (
                <li key={option.key}>
                  <button
                    type="button"
                    onClick={() => add(option)}
                    className="flex w-full cursor-pointer items-baseline justify-between gap-4 rounded-sm px-3 py-2 text-left hover:bg-surface-alt"
                    data-testid={`${testId}.suggestion.${option.key}`}
                  >
                    <span className="text-body text-text">{fitLabel(option)}</span>
                    {option.caption === '' ? null : (
                      <span className="text-small text-text-muted">{option.caption}</span>
                    )}
                  </button>
                </li>
              ))}
              {offerTyped ? (
                <li>
                  <button
                    type="button"
                    onClick={() => add({ brand: '', model: typed })}
                    className="flex w-full cursor-pointer items-baseline justify-between gap-4 rounded-sm px-3 py-2 text-left hover:bg-surface-alt"
                    data-testid={`${testId}.typed`}
                  >
                    <span className="text-body font-semibold text-primary">
                      {ti('inventory.form.addTyped', { model: typed })}
                    </span>
                    {hasCatalog ? (
                      <span className="text-small text-text-muted">
                        {ti('inventory.form.notInCatalog')}
                      </span>
                    ) : null}
                  </button>
                </li>
              ) : null}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

/** A whole number with a step either side; typing works too. */
export function QtyField({
  label,
  value,
  onChange,
  min = 0,
  max,
  hint,
  autoFocus,
  testId,
}: {
  readonly label: string;
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly min?: number | undefined;
  readonly max: number;
  readonly hint?: string | undefined;
  readonly autoFocus?: boolean | undefined;
  readonly testId: string;
}): React.JSX.Element {
  const id = useId();
  const select = useSelectOnFocus<HTMLInputElement>({});
  const clamp = (n: number): number => Math.min(max, Math.max(min, n));
  return (
    <FieldFrame id={id} label={label} hint={hint}>
      <div className="flex items-center gap-2">
        <IconButton
          icon={Minus}
          label={ti('inventory.stepper.decrease')}
          onClick={() => onChange(clamp(value - 1))}
          disabled={value <= min}
          data-testid={`${testId}.decrease`}
        />
        <input
          id={id}
          autoFocus={autoFocus}
          inputMode="numeric"
          value={String(value)}
          onChange={(event) => {
            const digits = event.target.value.replace(/\D/g, '');
            onChange(clamp(digits === '' ? min : Number(digits)));
          }}
          {...select}
          className={`${controlClass(false)} tabular h-10 max-w-32 text-right`}
          data-testid={testId}
        />
        <IconButton
          icon={Plus}
          label={ti('inventory.stepper.increase')}
          onClick={() => onChange(clamp(value + 1))}
          disabled={value >= max}
          data-testid={`${testId}.increase`}
        />
      </div>
    </FieldFrame>
  );
}
