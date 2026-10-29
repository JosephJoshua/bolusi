/**
 * The Xendit part of a QRIS method's form ("Metode pembayaran"): connect it with the Xendit
 * account's secret key, so the counter shows a QR for the exact amount and the payment records
 * itself, or disconnect it. Online only, so it says plainly when the server cannot be asked.
 * The key goes to the server and is never kept on this phone.
 */
import { Chip, Button, TextButton, TextInput, color, space, type } from '@bolusi/ui';
import { StyleSheet, Text, View } from 'react-native';

import { tm } from '../i18n.js';
import type { QrisConnectionControl } from '../qris-hooks.js';
import { QRIS_FAILURE_KEY } from '../qris.js';

export function QrisConnectSection({
  control,
  onDisconnect,
  testID = 'money.methodForm.qris',
}: {
  readonly control: QrisConnectionControl;
  /** Ask before disconnecting. */
  readonly onDisconnect: () => void;
  readonly testID?: string | undefined;
}): React.JSX.Element {
  const { state, connection, failure } = control;
  return (
    <View style={styles.section} testID={testID}>
      <Text style={styles.title}>{tm('money.qris.section')}</Text>
      {state.status === 'loading' && connection === null ? (
        <Text style={styles.muted} testID={`${testID}.checking`}>
          {tm('money.qris.checking')}
        </Text>
      ) : state.status === 'failed' && connection === null ? (
        <View style={styles.group} testID={`${testID}.checkFailed`}>
          <Text style={styles.muted}>
            {`${tm('money.qris.checkFailed')} ${tm(QRIS_FAILURE_KEY[state.reason])}`}
          </Text>
          <View style={styles.textAction}>
            <TextButton
              label={tm('money.qris.retry')}
              onPress={control.reload}
              testID={`${testID}.reload`}
            />
          </View>
        </View>
      ) : connection !== null ? (
        <View style={styles.connected} testID={`${testID}.connected`}>
          <Chip
            icon="success"
            tone="success"
            label={tm(
              connection.environment === 'test'
                ? 'money.qris.testConnected'
                : 'money.qris.connected',
            )}
            testID={`${testID}.status`}
          />
          <TextButton
            label={tm('money.qris.disconnect')}
            tone="danger"
            disabled={control.busy}
            onPress={onDisconnect}
            testID={`${testID}.disconnect`}
          />
        </View>
      ) : (
        <View style={styles.group}>
          <Text style={styles.muted}>{tm('money.qris.connectHint')}</Text>
          <TextInput
            label={tm('money.qris.secretKey')}
            value={control.secretKey}
            onChangeText={control.setSecretKey}
            secureTextEntry
            revealLabels={{ show: tm('money.qris.showKey'), hide: tm('money.qris.hideKey') }}
            autoCorrect={false}
            autoCapitalize="none"
            errorMessage={failure === null ? undefined : tm(QRIS_FAILURE_KEY[failure])}
            testID={`${testID}.key`}
          />
          <View style={styles.action}>
            <Button
              label={tm('money.qris.connect')}
              variant="secondary"
              size="compact"
              disabled={!control.keyTyped || control.busy}
              onPress={() => void control.connect()}
              testID={`${testID}.connect`}
            />
          </View>
        </View>
      )}
      {connection !== null && failure !== null ? (
        <Text style={styles.error}>{tm(QRIS_FAILURE_KEY[failure])}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: space.md },
  title: { ...type.bodyBold, color: color.text },
  group: { gap: space.md },
  muted: { ...type.bodySm, color: color.textMuted },
  error: { ...type.bodySm, color: color.danger },
  connected: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  action: { alignItems: 'flex-start' },
  // The text, not the hit box, lines up with the text above.
  textAction: { alignItems: 'flex-start', marginLeft: -space.sm },
});
