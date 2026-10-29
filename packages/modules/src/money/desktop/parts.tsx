// The pieces the money dialogs on the counter PC share: the dialog frame with its refusal banner,
// asking before something typed is dropped, an amount field and a label beside its amount.
import { t } from '@bolusi/i18n';
import { Button, ConfirmDialog, Dialog, TextField } from '@bolusi/ui-web';
import { useState, type ReactNode } from 'react';

import type { ActionRunner } from '../../screen-kit/index.js';
import { ActionError } from '../../screen-kit/desktop/index.js';

import { tm } from '../i18n.js';
import { digitsOf, digitsText } from '../payment-entry.js';

/** One task over the Kas page: the refusal above the body, Cancel and the task's own button below. */
export function MoneyDialog({
  title,
  description,
  runner,
  dirty,
  onClose,
  submitLabel,
  onSubmit,
  submitDisabled = false,
  destructive = false,
  hint,
  size = 'sm',
  children,
  testId,
}: {
  readonly title: string;
  readonly description?: ReactNode;
  readonly runner: ActionRunner;
  /** Something typed: leaving asks first, so a mis-click does not lose it. */
  readonly dirty: boolean;
  readonly onClose: () => void;
  readonly submitLabel: string;
  readonly onSubmit: () => void;
  readonly submitDisabled?: boolean | undefined;
  readonly destructive?: boolean | undefined;
  /** What is still missing, beside the buttons. */
  readonly hint?: string | null | undefined;
  readonly size?: 'sm' | 'md' | 'lg';
  readonly children: ReactNode;
  readonly testId: string;
}): React.JSX.Element {
  const [asking, setAsking] = useState(false);
  const requestClose = (): void => (dirty ? setAsking(true) : onClose());
  return (
    <>
      <Dialog
        open
        onRequestClose={requestClose}
        title={title}
        description={description}
        closeLabel={t('core.action.close')}
        banner={
          runner.errorCode === null ? undefined : (
            <ActionError errorCode={runner.errorCode} onDismiss={runner.clearError} />
          )
        }
        size={size}
        testId={testId}
        footer={
          <>
            {hint === null || hint === undefined ? null : (
              <p className="mr-auto text-small text-text-muted" data-testid={`${testId}.hint`}>
                {hint}
              </p>
            )}
            <Button label={t('core.action.cancel')} onClick={requestClose} />
            <Button
              label={submitLabel}
              variant={destructive ? 'danger' : 'primary'}
              onClick={onSubmit}
              busy={runner.busy}
              disabled={submitDisabled}
              data-testid={`${testId}.submit`}
            />
          </>
        }
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            // A destructive task is never one Enter away: it takes the button.
            if (!submitDisabled && !runner.busy && !destructive) onSubmit();
          }}
        >
          {children}
          {/* Enter in a field submits, as the button does. */}
          <button type="submit" hidden aria-hidden tabIndex={-1} />
        </form>
      </Dialog>
      <ConfirmDialog
        open={asking}
        title={tm('money.discard.title')}
        message={tm('money.discard.message')}
        confirmLabel={tm('money.discard.confirm')}
        cancelLabel={tm('money.discard.keep')}
        closeLabel={t('core.action.close')}
        destructive
        onConfirm={() => {
          setAsking(false);
          onClose();
        }}
        onCancel={() => setAsking(false)}
        testId={`${testId}.leave`}
      />
    </>
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
