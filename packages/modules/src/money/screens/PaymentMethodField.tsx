/**
 * PaymentMethodField — how a single payment came in (a DP at intake or later): the store's methods
 * as chips, and the reference the picked one takes (an EDC's approval code). Shows nothing while
 * the store takes cash only.
 */
import { ChipRow, TextInput, ToggleChip, space } from '@bolusi/ui';
import { StyleSheet, View } from 'react-native';

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
  readonly testID: string;
}

export function PaymentMethodField({
  accounts,
  account,
  reference,
  onChange,
  referenceError,
  testID,
}: PaymentMethodFieldProps): React.JSX.Element | null {
  if (accounts.length === 0) return null;
  const chosen = offeredAccount(account, accounts);
  const kind = lineKind(chosen, accounts);
  return (
    <View style={styles.field} testID={testID}>
      <ChipRow testID={`${testID}.methods`}>
        {paymentMethods(accounts).map((method) => (
          <ToggleChip
            key={method.account}
            label={method.label}
            selected={chosen === method.account}
            onToggle={() => onChange({ account: method.account, reference: '' })}
            testID={`${testID}.method.${method.account}`}
          />
        ))}
      </ChipRow>
      {kind === 'cash' ? null : (
        <TextInput
          label={tm(referenceRequired(kind) ? 'money.pay.approvalCode' : 'money.pay.reference')}
          value={reference}
          onChangeText={(text) => onChange({ account: chosen, reference: text })}
          autoCorrect={false}
          autoCapitalize="characters"
          errorMessage={referenceError}
          testID={`${testID}.reference`}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { gap: space.md },
});
