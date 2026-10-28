/**
 * QrisStep — the QR the customer scans to pay one line (qris-hooks.ts `useQrisCharge`), a full-screen
 * step over the payment it came from: the amount big, the QR, and what is happening until Xendit
 * confirms the payment. Back closes it and keeps the QR: shown again for the same amount it is the
 * same one, since the customer may have scanned it. When the QR cannot be made (no connection,
 * Xendit down) or it expired, the counter can take the payment by hand instead.
 */
import { formatMoney, formatTime } from '@bolusi/i18n';
import type { QrisCharge } from '@bolusi/schemas';
import {
  Banner,
  Button,
  OutcomeState,
  QrCode,
  TextButton,
  color,
  size,
  space,
  type,
} from '@bolusi/ui';
import { useCallback, useRef } from 'react';
import { ActivityIndicator, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import type { DiscardGuard } from '../../screen-kit/index.js';
import { FlowScreen, type ScreenChrome } from '../../screen-kit/screens/views.js';

import { tm } from '../i18n.js';
import { useQrisCharge, type OpenQr } from '../qris-hooks.js';
import { QRIS_FAILURE_KEY, type QrisPort } from '../qris.js';

export interface QrisStepProps {
  readonly chrome: ScreenChrome;
  readonly open: OpenQr;
  readonly port: QrisPort;
  /** Test mode's "pay it" for someone who manages the method. */
  readonly canSimulate: boolean;
  readonly onPaid: (charge: QrisCharge) => void;
  readonly onRenew: () => void;
  readonly onTakeByHand: () => void;
  readonly onClose: () => void;
  readonly testID?: string | undefined;
}

/** The largest the QR is drawn: scannable from a customer's phone across the counter. */
const QR_MAX = 320;

export function QrisStep({
  chrome,
  open,
  port,
  canSimulate,
  onPaid,
  onRenew,
  onTakeByHand,
  onClose,
  testID = 'money.qris',
}: QrisStepProps): React.JSX.Element {
  const view = useQrisCharge(port, open.body, onPaid);
  const { state } = view;
  const { width } = useWindowDimensions();
  const amount = formatMoney(open.body.amount);
  const qrSize = Math.min(QR_MAX, Math.min(width, size.contentMax) - space.lg * 2);
  const primary =
    state.kind === 'paid'
      ? { label: tm('money.qris.done'), onPress: onClose }
      : state.kind === 'expired'
        ? { label: tm('money.qris.renew'), onPress: onRenew }
        : state.kind === 'failed'
          ? { label: tm('money.qris.retry'), onPress: view.retry }
          : null;

  return (
    <FlowScreen
      chrome={chrome}
      title={tm('money.qris.title')}
      onBack={onClose}
      primaryLabel={primary?.label}
      onPrimary={primary?.onPress}
      busy={false}
      errorCode={null}
      onClearError={() => undefined}
      testID={testID}
    >
      {/* Read out when the QR turns paid, expired or failed. */}
      <View accessibilityLiveRegion="polite">
        {state.kind === 'creating' || state.kind === 'waiting' ? (
          <View style={styles.centre} testID={`${testID}.${state.kind}`}>
            <Text style={styles.amount} testID={`${testID}.amount`}>
              {amount}
            </Text>
            {state.kind === 'waiting' ? (
              <QrCode
                value={state.charge.qrString}
                accessibilityLabel={tm('money.qris.qrLabel', { amount })}
                size={qrSize}
                testID={`${testID}.code`}
              />
            ) : (
              <View style={[styles.placeholder, { width: qrSize, height: qrSize }]}>
                <ActivityIndicator color={color.primary} />
              </View>
            )}
            <Text style={styles.body}>
              {tm(state.kind === 'waiting' ? 'money.qris.scan' : 'money.qris.creating')}
            </Text>
            {state.kind === 'waiting' ? (
              <Text
                style={state.reconnecting ? styles.warning : styles.muted}
                testID={`${testID}.status`}
              >
                {state.reconnecting
                  ? tm('money.qris.reconnecting')
                  : tm('money.qris.expiresAt', { time: formatTime(state.charge.expiresAt) })}
              </Text>
            ) : null}
            {state.kind === 'waiting' && state.charge.environment === 'test' ? (
              <View style={styles.test}>
                <Banner variant="info" message={tm('money.qris.testMode')} />
                {canSimulate ? (
                  <View style={styles.centre}>
                    <Button
                      label={tm('money.qris.simulate')}
                      variant="secondary"
                      size="compact"
                      disabled={view.simulating}
                      onPress={view.simulate}
                      testID={`${testID}.simulate`}
                    />
                    {view.simulateFailure === null ? null : (
                      <Text style={styles.warning}>
                        {tm(QRIS_FAILURE_KEY[view.simulateFailure])}
                      </Text>
                    )}
                  </View>
                ) : null}
              </View>
            ) : null}
          </View>
        ) : state.kind === 'paid' ? (
          <OutcomeState
            tone="success"
            icon="success"
            title={tm('money.qris.paid')}
            message={tm('money.qris.paidMessage', { amount: formatMoney(state.charge.amount) })}
            testID={`${testID}.paid`}
          />
        ) : (
          <OutcomeState
            tone={state.kind === 'expired' ? 'warning' : 'danger'}
            icon={state.kind === 'expired' ? 'pending' : 'rejected'}
            title={tm(
              state.kind === 'expired' ? 'money.qris.expired' : QRIS_FAILURE_KEY[state.reason],
            )}
            message={state.kind === 'expired' ? tm('money.qris.expiredMessage') : undefined}
            testID={`${testID}.${state.kind}`}
          >
            <TextButton
              label={tm('money.qris.byHand')}
              onPress={onTakeByHand}
              testID={`${testID}.byHand`}
            />
          </OutcomeState>
        )}
      </View>
    </FlowScreen>
  );
}

/**
 * While a QR step is open, hardware back closes it rather than asking to leave the payment it came
 * from: wraps the payment step's guard registration.
 */
export function useQrStepBack(
  onRegisterDiscardGuard: ((guard: DiscardGuard | null) => void) | undefined,
  open: boolean,
  close: () => void,
): ((guard: DiscardGuard | null) => void) | undefined {
  const closeRef = useRef(close);
  closeRef.current = close;
  const register = useCallback(
    (guard: DiscardGuard | null) =>
      onRegisterDiscardGuard?.(open ? () => closeRef.current() : guard),
    [onRegisterDiscardGuard, open],
  );
  return onRegisterDiscardGuard === undefined ? undefined : register;
}

const styles = StyleSheet.create({
  centre: { alignItems: 'center', gap: space.md },
  amount: { ...type.title, color: color.text, fontVariant: ['tabular-nums'] },
  placeholder: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.surfaceAlt,
  },
  body: { ...type.body, color: color.text, textAlign: 'center' },
  muted: { ...type.bodySm, color: color.textMuted, textAlign: 'center' },
  warning: { ...type.bodySm, color: color.warning, textAlign: 'center' },
  test: { alignSelf: 'stretch', gap: space.md, marginTop: space.sm },
});
