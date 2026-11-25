// An amount in whole rupiah on the counter PC, grouped as it is typed ("185.000"). Shared by every
// module's money entry; each passes its own ceiling and currency label.
import { formatNumber } from '@bolusi/i18n';
import { TextField, type TextFieldProps } from '@bolusi/ui-web';

import { acceptsRupiahText, parseRupiah } from '../../shared/rupiah.js';

export type MoneyFieldProps = Omit<TextFieldProps, 'value' | 'onChange' | 'inputMode'> & {
  readonly value: number | null;
  readonly onChange: (value: number | null) => void;
  /** The most it takes: a keystroke past it is not typed at all. */
  readonly max: number;
  /** The currency label before the amount ("Rp"). */
  readonly prefix: string;
};

export function MoneyField({ value, onChange, max, ...rest }: MoneyFieldProps): React.JSX.Element {
  return (
    <TextField
      {...rest}
      inputMode="numeric"
      selectOnFocus
      inputClassName="tabular text-right"
      // Empty only when nothing is typed: a fee of 0 (waived) must read as 0.
      value={value === null ? '' : formatNumber(value)}
      onChange={(event) => {
        const text = event.target.value;
        if (acceptsRupiahText(text, max)) onChange(parseRupiah(text, max));
      }}
    />
  );
}
