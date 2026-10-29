/**
 * PaymentLines — taking a payment at the counter PC: the phone's step (money/screens) in the
 * desktop's denser form, over the same `paymentEntry` arithmetic. Each method is a row of chips,
 * then its amount beside what that method needs (cash handed over, an EDC's approval code). On a
 * QRIS method connected to Xendit that is the QR instead (`qris`, QrisDialog).
 */
import { formatMoney } from '@bolusi/i18n';
import { QRIS_MIN_AMOUNT } from '@bolusi/schemas';
import { Button, TextField, ToggleChip } from '@bolusi/ui-web';
import { Plus, QrCode } from 'lucide-react';

import { referenceRequired } from '../constants.js';
import { tm } from '../i18n.js';
import {
  digitsOf,
  digitsText,
  lineKind,
  newPaymentLine,
  offeredAccount,
  paidByQr,
  paymentMethods,
  type PaymentEntry,
  type PaymentLine,
} from '../payment-entry.js';
import type { PaymentAccountRow } from '../queries.js';
import { qrAmountOk, unresolvedText, type QrisCheckout } from '../qris-hooks.js';

export interface PaymentLinesProps {
  readonly lines: readonly PaymentLine[];
  readonly entry: PaymentEntry;
  readonly accounts: readonly PaymentAccountRow[];
  readonly onChange: (lines: readonly PaymentLine[]) => void;
  readonly newKey: () => string;
  /** QRIS through Xendit; absent where payments are only taken by hand. */
  readonly qris?: QrisCheckout | undefined;
  readonly testId?: string | undefined;
}

export function PaymentLines({
  lines,
  entry,
  accounts,
  onChange,
  newKey,
  qris,
  testId = 'money.desk.payment',
}: PaymentLinesProps): React.JSX.Element {
  const methods = paymentMethods(accounts);
  const labelOf = (account: string) =>
    methods.find((method) => method.account === account)?.label ?? tm('money.method.cash');
  const set = (key: string, patch: Partial<PaymentLine>) =>
    onChange(lines.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  const digits = (key: string, field: 'amount' | 'tendered') => (text: string) => {
    const typed = digitsOf(text);
    if (typed !== null) set(key, { [field]: typed });
  };

  return (
    <div className="flex flex-col gap-4" data-testid={testId}>
      {qris !== undefined && qris.received > 0 ? (
        <p className="text-body text-success" data-testid={`${testId}.qrisReceived`}>
          {tm('money.qris.received', { amount: formatMoney(qris.received) })}
        </p>
      ) : null}
      {qris !== undefined && qris.unresolved.length > 0 ? (
        <p className="text-body text-warning" data-testid={`${testId}.qrisUnresolved`}>
          {unresolvedText(qris.unresolved)}
        </p>
      ) : null}
      {lines.map((line, index) => {
        const id = `${testId}.line${String(index)}`;
        const account = offeredAccount(line.account, accounts);
        const kind = lineKind(account, accounts);
        const amount = Number(line.amount === '' ? 0 : line.amount);
        const tendered = Number(line.tendered === '' ? 0 : line.tendered);
        const connected = qris?.qrAccounts.has(account) === true;
        const byQr = connected && paidByQr(line, qris.qrAccounts);
        return (
          <div
            key={line.key}
            className={index > 0 ? 'border-t border-border pt-4' : undefined}
            data-testid={id}
          >
            {methods.length > 1 ? (
              <div
                className="mb-3 flex gap-2 overflow-x-auto"
                role="group"
                aria-label={tm('money.pay.method')}
                data-testid={`${id}.methods`}
              >
                {methods.map((method) => (
                  <ToggleChip
                    key={method.account}
                    label={method.label}
                    selected={account === method.account}
                    onToggle={() =>
                      set(line.key, {
                        account: method.account,
                        tendered: '',
                        reference: '',
                        qr: undefined,
                        manual: false,
                      })
                    }
                  />
                ))}
              </div>
            ) : null}
            <div className="grid grid-cols-2 gap-3">
              <TextField
                label={tm('money.pay.amount')}
                prefix={tm('money.pay.currency')}
                inputMode="numeric"
                inputClassName="tabular text-right"
                value={digitsText(line.amount)}
                onChange={(event) => digits(line.key, 'amount')(event.target.value)}
                data-testid={`${id}.amount`}
              />
              {kind === 'cash' ? (
                <TextField
                  label={tm('money.pay.tendered')}
                  prefix={tm('money.pay.currency')}
                  inputMode="numeric"
                  inputClassName="tabular text-right"
                  value={digitsText(line.tendered)}
                  onChange={(event) => digits(line.key, 'tendered')(event.target.value)}
                  error={
                    entry.problems[line.key] === 'tendered'
                      ? tm('money.pay.problem.tendered')
                      : undefined
                  }
                  data-testid={`${id}.tendered`}
                />
              ) : byQr ? (
                <div className="flex flex-col justify-end gap-1">
                  <Button
                    label={tm('money.qris.show')}
                    icon={QrCode}
                    disabled={!qrAmountOk(line) || entry.overpaid > 0}
                    onClick={() => qris.show(line.key)}
                    data-testid={`${id}.showQr`}
                  />
                </div>
              ) : (
                <TextField
                  label={tm(
                    referenceRequired(kind) ? 'money.pay.approvalCode' : 'money.pay.reference',
                  )}
                  value={line.reference}
                  onChange={(event) => set(line.key, { reference: event.target.value })}
                  autoComplete="off"
                  spellCheck={false}
                  data-testid={`${id}.reference`}
                />
              )}
            </div>
            <div className="mt-2 flex items-center justify-between gap-3">
              {lines.length > 1 ? (
                <Button
                  label={tm('money.pay.remove')}
                  aria-label={tm('money.pay.removeLabel', { method: labelOf(account) })}
                  variant="dangerText"
                  size="sm"
                  onClick={() => onChange(lines.filter((other) => other.key !== line.key))}
                  data-testid={`${id}.remove`}
                />
              ) : (
                <span />
              )}
              {connected && !byQr && line.manual !== true ? (
                <p className="text-small text-text-muted" data-testid={`${id}.qrMinimum`}>
                  {tm('money.qris.minimum', { amount: formatMoney(QRIS_MIN_AMOUNT) })}
                </p>
              ) : connected && !byQr ? (
                <Button
                  label={tm('money.qris.useQr')}
                  variant="text"
                  size="sm"
                  onClick={() => qris.useQr(line.key)}
                  data-testid={`${id}.useQr`}
                />
              ) : null}
              {kind === 'cash' && line.tendered !== '' && tendered >= amount && amount > 0 ? (
                <p className="text-body text-text" data-testid={`${id}.change`}>
                  <span className="text-text-muted">{tm('money.pay.change')} </span>
                  <span className="tabular font-semibold">{formatMoney(tendered - amount)}</span>
                </p>
              ) : null}
            </div>
          </div>
        );
      })}
      <div className="flex items-center justify-between gap-3">
        {methods.length > 1 && lines.length < 10 ? (
          <Button
            label={tm('money.pay.addMethod')}
            icon={Plus}
            variant="text"
            size="sm"
            onClick={() => {
              const used = new Set(lines.map((line) => line.account));
              const next = methods.find((method) => !used.has(method.account))?.account;
              onChange([...lines, newPaymentLine(newKey(), entry.remaining, next)]);
            }}
            data-testid={`${testId}.add`}
          />
        ) : (
          <span />
        )}
        {entry.overpaid > 0 ? (
          <p className="text-small text-danger" data-testid={`${testId}.overpaid`}>
            {tm('money.pay.overpaid', { amount: formatMoney(entry.overpaid) })}
          </p>
        ) : entry.remaining > 0 ? (
          <p className="text-small text-text-muted" data-testid={`${testId}.remaining`}>
            {tm('money.pay.remaining', { amount: formatMoney(entry.remaining) })}
          </p>
        ) : null}
      </div>
    </div>
  );
}
