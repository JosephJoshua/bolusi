// Supplier payments on the counter PC: a bill's payments in its pane, and the dialogs that pay a
// bill or cancel a payment made by mistake. The form's state and checks are the phone's
// (`pay.tsx`).
import { formatDate, formatMoney, keepCodeWhole } from '@bolusi/i18n';
import { Button, Section, Segmented, TextArea, TextField } from '@bolusi/ui-web';
import { QueryPanel, TaskDialog } from '../../screen-kit/desktop/index.js';
import { MAX_PAYMENT, MAX_PAYMENT_REFERENCE, MAX_PURCHASING_NOTE } from '../constants.js';
import { tp } from '../i18n.js';
import type { BillDetailRow } from '../bills/queries.js';
import { usePayForm, useVoidPayment } from '../pay.js';
import { paymentLine, sourceLabel } from '../payments/pay-form.js';
import type { PaymentRow } from '../payments/queries.js';
import { discardCopy } from './dialogs.js';
import { PriceField } from './bills.js';

/** A bill's payments, cancelled ones struck through, and what the supplier's credit paid of it. */
export function PaymentsSection({
  bill,
  mayCancel,
  onCancel,
  testId,
}: {
  readonly bill: BillDetailRow;
  /** Whether this person may cancel a payment here (they pay suppliers, and the bill stands). */
  readonly mayCancel: boolean;
  readonly onCancel: (payment: PaymentRow) => void;
  readonly testId: string;
}): React.JSX.Element | null {
  if (bill.payments.length === 0 && bill.fromCredit === 0) return null;
  return (
    <Section title={tp('purchasing.pay.payments')} testId={`${testId}.payments`}>
      <ul>
        {bill.payments.map((payment) => {
          const cancelled = payment.voidedAt !== null;
          return (
            <li
              key={payment.id}
              className="flex items-baseline gap-4 border-b border-border py-2"
              data-testid={`${testId}.payment.${payment.id}`}
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-body text-text">{paymentLine(payment)}</span>
                {cancelled ? (
                  <span className="text-small text-text-muted">
                    {tp('purchasing.pay.voided', { reason: payment.voidReason ?? '' })}
                  </span>
                ) : null}
              </span>
              {!cancelled && mayCancel ? (
                <Button
                  label={tp('purchasing.pay.void')}
                  aria-label={tp('purchasing.pay.voidLabel', {
                    amount: formatMoney(payment.amount),
                    date: formatDate(payment.createdAt),
                  })}
                  variant="dangerText"
                  onClick={() => onCancel(payment)}
                  data-testid={`${testId}.payment.${payment.id}.void`}
                />
              ) : null}
              <span
                className={
                  cancelled
                    ? 'tabular shrink-0 text-body text-text-muted line-through'
                    : 'tabular shrink-0 text-body text-text'
                }
              >
                {formatMoney(payment.amount)}
              </span>
            </li>
          );
        })}
        {bill.fromCredit === 0 ? null : (
          <li
            className="flex items-baseline gap-4 border-b border-border py-2"
            data-testid={`${testId}.fromCredit`}
          >
            <span className="min-w-0 flex-1 text-body text-text">
              {tp('purchasing.bill.fromCredit')}
            </span>
            <span className="tabular shrink-0 text-body text-text">
              {formatMoney(bill.fromCredit)}
            </span>
          </li>
        )}
      </ul>
    </Section>
  );
}

/** Bayar: what is left on the bill to start with, and where the money comes from. */
export function PayDialog({
  bill,
  onClose,
  onDone,
}: {
  readonly bill: BillDetailRow;
  readonly onClose: () => void;
  readonly onDone: () => void;
}): React.JSX.Element {
  const form = usePayForm(bill, onDone);
  const { draft, setDraft } = form;
  const testId = 'purchasing.desk.pay';
  return (
    <TaskDialog
      title={tp('purchasing.pay.title')}
      description={`${keepCodeWhole(bill.billNumber)} · ${bill.supplierName}`}
      runner={form.runner}
      dirty={form.dirty}
      discard={discardCopy()}
      onClose={onClose}
      submitLabel={
        form.amount === null
          ? tp('purchasing.pay.action')
          : tp('purchasing.pay.save', { amount: formatMoney(form.amount) })
      }
      onSubmit={form.save}
      submitDisabled={form.gap !== null}
      hint={form.gap === null ? null : tp(form.gap)}
      size="sm"
      testId={testId}
    >
      <p className="tabular text-body text-text-muted">
        {tp('purchasing.bill.balanceDue', { amount: formatMoney(bill.balance) })}
      </p>
      <div>
        <PriceField
          label={tp('purchasing.pay.amount')}
          value={draft.amount}
          onChange={(text) => setDraft({ ...draft, amount: text })}
          max={MAX_PAYMENT}
          testId={`${testId}.amount`}
        />
        {form.above ? (
          <p className="mt-1 text-small text-warning" data-testid={`${testId}.above`}>
            {tp('purchasing.pay.aboveBalance')}
          </p>
        ) : null}
      </div>
      <div>
        <p className="mb-2 text-small font-semibold text-text">{tp('purchasing.pay.source')}</p>
        <QueryPanel query={form.sources} onRetry={form.retrySources}>
          {(rows) => (
            <Segmented
              label={tp('purchasing.pay.source')}
              options={rows.map((source) => ({
                value: source.source,
                label: sourceLabel(source),
              }))}
              value={draft.source}
              onChange={(source) => setDraft({ ...draft, source })}
              testId={`${testId}.source`}
            />
          )}
        </QueryPanel>
      </div>
      {form.bank ? (
        <TextField
          label={tp('purchasing.pay.reference')}
          value={draft.reference}
          onChange={(event) => setDraft({ ...draft, reference: event.target.value })}
          maxLength={MAX_PAYMENT_REFERENCE}
          data-testid={`${testId}.reference`}
        />
      ) : null}
    </TaskDialog>
  );
}

/** Batalkan pembayaran: one recorded by mistake, with why. It stays in the history. */
export function VoidPaymentDialog({
  bill,
  payment,
  onClose,
  onDone,
}: {
  readonly bill: BillDetailRow;
  readonly payment: PaymentRow;
  readonly onClose: () => void;
  readonly onDone: () => void;
}): React.JSX.Element {
  const form = useVoidPayment(payment, onDone);
  const testId = 'purchasing.desk.voidPayment';
  return (
    <TaskDialog
      title={tp('purchasing.pay.voidTitle')}
      description={`${formatMoney(payment.amount)} · ${paymentLine(payment)} · ${keepCodeWhole(bill.billNumber)}`}
      runner={form.runner}
      dirty={form.ready}
      discard={discardCopy()}
      onClose={onClose}
      submitLabel={tp('purchasing.pay.voidConfirm')}
      destructive
      onSubmit={form.save}
      submitDisabled={!form.ready}
      hint={form.ready ? null : tp('purchasing.bill.voidReasonFirst')}
      size="sm"
      testId={testId}
    >
      <p className="text-body text-text-muted">{tp('purchasing.pay.voidHint')}</p>
      <TextArea
        label={tp('purchasing.bill.voidReason')}
        value={form.reason}
        onChange={(event) => form.setReason(event.target.value)}
        maxLength={MAX_PURCHASING_NOTE}
        rows={2}
        data-testid={`${testId}.reason`}
      />
    </TaskDialog>
  );
}
