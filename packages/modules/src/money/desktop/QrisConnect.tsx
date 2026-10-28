/**
 * The Xendit part of a QRIS method's dialog on the PC, the phone's QrisConnectSection over the same
 * `useQrisConnection`: connect it with the Xendit secret key, or disconnect it after asking.
 */
import { Button, Chip, ConfirmDialog, SecretField } from '@bolusi/ui-web';
import { CircleCheck } from 'lucide-react';
import { useState } from 'react';

import { tm } from '../i18n.js';
import type { QrisConnectionControl } from '../qris-hooks.js';
import { QRIS_FAILURE_KEY } from '../qris.js';

export function QrisConnectSection({
  control,
  testId = 'money.desk.methodForm.qris',
}: {
  readonly control: QrisConnectionControl;
  readonly testId?: string | undefined;
}): React.JSX.Element {
  const { state, connection, failure } = control;
  const [asking, setAsking] = useState(false);
  return (
    <section className="flex flex-col gap-2 border-t border-border pt-4" data-testid={testId}>
      <h3 className="text-body font-semibold text-text">{tm('money.qris.section')}</h3>
      {state.status === 'loading' && connection === null ? (
        <p className="text-body text-text-muted" data-testid={`${testId}.checking`}>
          {tm('money.qris.checking')}
        </p>
      ) : state.status === 'failed' && connection === null ? (
        <div
          className="flex items-center justify-between gap-3"
          data-testid={`${testId}.checkFailed`}
        >
          <p className="text-body text-text-muted">
            {`${tm('money.qris.checkFailed')} ${tm(QRIS_FAILURE_KEY[state.reason])}`}
          </p>
          <Button
            label={tm('money.qris.retry')}
            variant="text"
            size="sm"
            onClick={control.reload}
            data-testid={`${testId}.reload`}
          />
        </div>
      ) : connection !== null ? (
        <div
          className="flex items-center justify-between gap-3"
          data-testid={`${testId}.connected`}
        >
          <Chip
            icon={CircleCheck}
            tone="success"
            label={tm(
              connection.environment === 'test'
                ? 'money.qris.testConnected'
                : 'money.qris.connected',
            )}
          />
          <Button
            label={tm('money.qris.disconnect')}
            variant="dangerText"
            size="sm"
            disabled={control.busy}
            onClick={() => setAsking(true)}
            data-testid={`${testId}.disconnect`}
          />
        </div>
      ) : (
        <>
          <p className="text-body text-text-muted">{tm('money.qris.connectHint')}</p>
          <div className="flex flex-col items-start gap-3">
            <SecretField
              className="w-full"
              label={tm('money.qris.secretKey')}
              showLabel={tm('money.qris.showKey')}
              hideLabel={tm('money.qris.hideKey')}
              value={control.secretKey}
              onChange={(event) => control.setSecretKey(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              error={failure === null ? undefined : tm(QRIS_FAILURE_KEY[failure])}
              data-testid={`${testId}.key`}
            />
            <Button
              label={tm('money.qris.connect')}
              disabled={!control.keyTyped}
              busy={control.busy}
              onClick={() => void control.connect()}
              data-testid={`${testId}.connect`}
            />
          </div>
        </>
      )}
      {connection !== null && failure !== null ? (
        <p role="alert" className="text-small text-danger">
          {tm(QRIS_FAILURE_KEY[failure])}
        </p>
      ) : null}
      <ConfirmDialog
        open={asking}
        title={tm('money.qris.disconnectTitle')}
        message={tm('money.qris.disconnectMessage')}
        confirmLabel={tm('money.qris.disconnect')}
        cancelLabel={tm('money.qris.cancel')}
        closeLabel={tm('money.qris.close')}
        destructive
        onConfirm={() => {
          setAsking(false);
          void control.disconnect();
        }}
        onCancel={() => setAsking(false)}
        testId={`${testId}.confirm`}
      />
    </section>
  );
}
