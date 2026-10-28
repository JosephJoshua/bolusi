/**
 * QrisDialog — the PC's QR for one payment line, the phone's QrisStep over the same
 * `useQrisCharge`: the amount, the QR the customer scans off the counter screen, and what is
 * happening until Xendit confirms the payment. Closing keeps the QR for that line; when it cannot be
 * made or it expired, the counter can take the payment by hand instead.
 */
import { formatMoney, formatTime } from '@bolusi/i18n';
import type { QrisCharge } from '@bolusi/schemas';
import { Banner, Button, Dialog, QrCode, Spinner, StatePanel } from '@bolusi/ui-web';
import { CircleAlert, CircleCheck, Clock } from 'lucide-react';

import { tm } from '../i18n.js';
import { useQrisCharge, type OpenQr } from '../qris-hooks.js';
import { QRIS_FAILURE_KEY, type QrisPort } from '../qris.js';

export interface QrisDialogProps {
  readonly open: OpenQr;
  readonly port: QrisPort;
  readonly canSimulate: boolean;
  readonly onPaid: (charge: QrisCharge) => void;
  readonly onRenew: () => void;
  readonly onTakeByHand: () => void;
  readonly onClose: () => void;
  readonly testId?: string | undefined;
}

/** Big enough to scan from a phone held across the counter, smaller on a short screen. */
const QR_SIZE = 'min(264px, 30vh)';

export function QrisDialog({
  open,
  port,
  canSimulate,
  onPaid,
  onRenew,
  onTakeByHand,
  onClose,
  testId = 'money.desk.qris',
}: QrisDialogProps): React.JSX.Element {
  const view = useQrisCharge(port, open.body, onPaid);
  const { state } = view;
  const amount = formatMoney(open.body.amount);
  const byHand = (
    <Button
      label={tm('money.qris.byHand')}
      variant="text"
      onClick={onTakeByHand}
      data-testid={`${testId}.byHand`}
    />
  );

  const footer =
    state.kind === 'paid' ? (
      <Button
        label={tm('money.qris.done')}
        variant="primary"
        onClick={onClose}
        data-testid={`${testId}.done`}
      />
    ) : state.kind === 'expired' ? (
      <>
        {byHand}
        <Button
          label={tm('money.qris.renew')}
          variant="primary"
          onClick={onRenew}
          data-testid={`${testId}.renew`}
        />
      </>
    ) : state.kind === 'failed' ? (
      <>
        {byHand}
        <Button
          label={tm('money.qris.retry')}
          variant="primary"
          onClick={view.retry}
          data-testid={`${testId}.retry`}
        />
      </>
    ) : (
      <Button label={tm('money.qris.close')} onClick={onClose} data-testid={`${testId}.close`} />
    );

  return (
    <Dialog
      open
      onRequestClose={onClose}
      title={tm('money.qris.title')}
      closeLabel={tm('money.qris.close')}
      size="sm"
      banner={
        state.kind === 'waiting' && state.charge.environment === 'test' ? (
          <Banner
            tone="info"
            message={tm('money.qris.testMode')}
            action={
              canSimulate ? (
                <Button
                  label={tm('money.qris.simulate')}
                  size="sm"
                  busy={view.simulating}
                  onClick={view.simulate}
                  data-testid={`${testId}.simulate`}
                />
              ) : undefined
            }
          />
        ) : undefined
      }
      footer={footer}
      testId={testId}
    >
      {/* Read out when the QR turns paid, expired or failed. */}
      <div aria-live="polite">
        {state.kind === 'creating' || state.kind === 'waiting' ? (
          <div className="flex flex-col items-center gap-3 py-2 text-center">
            <p
              className="tabular text-display font-bold text-text"
              data-testid={`${testId}.amount`}
            >
              {amount}
            </p>
            {state.kind === 'waiting' ? (
              <QrCode
                value={state.charge.qrString}
                label={tm('money.qris.qrLabel', { amount })}
                size={QR_SIZE}
                testId={`${testId}.code`}
              />
            ) : (
              <div
                className="flex items-center justify-center rounded-sm bg-surface-alt"
                style={{ width: QR_SIZE, height: QR_SIZE }}
                data-testid={`${testId}.creating`}
              >
                <Spinner size={24} />
              </div>
            )}
            <p className="text-body text-text">
              {tm(state.kind === 'waiting' ? 'money.qris.scan' : 'money.qris.creating')}
            </p>
            {state.kind === 'waiting' ? (
              <p
                role="status"
                className={
                  state.reconnecting
                    ? 'flex items-center gap-2 text-small text-warning'
                    : 'flex items-center gap-2 text-small text-text-muted'
                }
                data-testid={`${testId}.status`}
              >
                <Spinner />
                {state.reconnecting
                  ? tm('money.qris.reconnecting')
                  : tm('money.qris.expiresAt', { time: formatTime(state.charge.expiresAt) })}
              </p>
            ) : null}
            {view.simulateFailure === null ? null : (
              <p className="text-small text-danger">{tm(QRIS_FAILURE_KEY[view.simulateFailure])}</p>
            )}
          </div>
        ) : state.kind === 'paid' ? (
          <StatePanel
            icon={CircleCheck}
            tone="success"
            title={tm('money.qris.paid')}
            hint={tm('money.qris.paidMessage', { amount: formatMoney(state.charge.amount) })}
            testId={`${testId}.paid`}
          />
        ) : state.kind === 'expired' ? (
          <StatePanel
            icon={Clock}
            title={tm('money.qris.expired')}
            hint={tm('money.qris.expiredMessage')}
            testId={`${testId}.expired`}
          />
        ) : (
          <StatePanel
            icon={CircleAlert}
            tone="danger"
            title={tm(QRIS_FAILURE_KEY[state.reason])}
            testId={`${testId}.failed`}
          />
        )}
      </div>
    </Dialog>
  );
}
