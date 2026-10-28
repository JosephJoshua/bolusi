/**
 * PaymentMethodField — the phone's method picker for a single payment (a DP) on the counter PC:
 * the store's methods as chips and the reference the picked one takes. Nothing while the store
 * takes cash only.
 */
import { TextField, ToggleChip } from '@bolusi/ui-web';

import { referenceRequired } from '../constants.js';
import { tm } from '../i18n.js';
import { lineKind, offeredAccount, paymentMethods } from '../payment-entry.js';
import type { PaymentAccountRow } from '../queries.js';

export interface PaymentMethodFieldProps {
  readonly accounts: readonly PaymentAccountRow[];
  readonly account: string;
  readonly reference: string;
  readonly onChange: (method: { readonly account: string; readonly reference: string }) => void;
  readonly referenceError?: string | undefined;
  readonly testId: string;
  /** `end` lines it up under a right-aligned amount, as on the intake page. */
  readonly align?: 'start' | 'end';
}

export function PaymentMethodField({
  accounts,
  account,
  reference,
  onChange,
  referenceError,
  testId,
  align = 'start',
}: PaymentMethodFieldProps): React.JSX.Element | null {
  if (accounts.length === 0) return null;
  const chosen = offeredAccount(account, accounts);
  const kind = lineKind(chosen, accounts);
  return (
    <div
      className={align === 'end' ? 'flex flex-col items-end gap-3' : 'flex flex-col gap-3'}
      data-testid={testId}
    >
      <div
        className={align === 'end' ? 'flex flex-wrap justify-end gap-2' : 'flex flex-wrap gap-2'}
        role="group"
        aria-label={tm('money.pay.method')}
        data-testid={`${testId}.methods`}
      >
        {paymentMethods(accounts).map((method) => (
          <ToggleChip
            key={method.account}
            label={method.label}
            selected={chosen === method.account}
            onToggle={() => onChange({ account: method.account, reference: '' })}
          />
        ))}
      </div>
      {kind === 'cash' ? null : (
        <TextField
          className={align === 'end' ? 'w-60' : undefined}
          label={tm(referenceRequired(kind) ? 'money.pay.approvalCode' : 'money.pay.reference')}
          value={reference}
          onChange={(event) => onChange({ account: chosen, reference: event.target.value })}
          error={referenceError}
          autoComplete="off"
          spellCheck={false}
          data-testid={`${testId}.reference`}
        />
      )}
    </div>
  );
}
