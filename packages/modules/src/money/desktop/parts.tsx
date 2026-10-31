// The pieces the money dialogs on the counter PC share: the dialog frame with its refusal banner,
// asking before something typed is dropped, an amount field and a label beside its amount.
import { TextField } from '@bolusi/ui-web';

import { TaskDialog } from '../../screen-kit/desktop/index.js';

import { tm } from '../i18n.js';
import { digitsOf, digitsText } from '../payment-entry.js';

/** One task over the Kas page, in the frame every desktop task shares. */
export function MoneyDialog(
  props: Omit<React.ComponentProps<typeof TaskDialog>, 'discard'>,
): React.JSX.Element {
  return (
    <TaskDialog
      {...props}
      discard={{
        title: tm('money.discard.title'),
        message: tm('money.discard.message'),
        confirm: tm('money.discard.confirm'),
        keep: tm('money.discard.keep'),
      }}
    />
  );
}

/** Rupiah typed as digits, shown grouped ("150.000"). */
export function AmountField({
  label,
  digits,
  onChange,
  error,
  testId,
}: {
  readonly label: string;
  readonly digits: string;
  readonly onChange: (digits: string) => void;
  readonly error?: string | undefined;
  readonly testId: string;
}): React.JSX.Element {
  return (
    <TextField
      label={label}
      error={error}
      prefix={tm('money.pay.currency')}
      inputMode="numeric"
      selectOnFocus
      inputClassName="tabular text-right"
      value={digitsText(digits)}
      onChange={(event) => {
        const typed = digitsOf(event.target.value);
        if (typed !== null) onChange(typed);
      }}
      data-testid={testId}
    />
  );
}

/** A label and its amount on one line; `strong` for the figure that matters. */
export function AmountLine({
  label,
  value,
  strong = false,
  tone = 'text',
  testId,
}: {
  readonly label: string;
  readonly value: string;
  readonly strong?: boolean | undefined;
  readonly tone?: 'text' | 'danger' | undefined;
  readonly testId?: string | undefined;
}): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className={strong ? 'text-body font-semibold text-text' : 'text-body text-text-muted'}>
        {label}
      </span>
      <span
        className={[
          'tabular whitespace-nowrap',
          strong ? 'text-heading font-semibold' : 'text-body',
          tone === 'danger' ? 'text-danger' : 'text-text',
        ].join(' ')}
        data-testid={testId}
      >
        {value}
      </span>
    </div>
  );
}
