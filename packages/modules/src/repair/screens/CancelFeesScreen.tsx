/**
 * CancelFeesScreen — what a cancelled servisan costs the customer at this store: one fee before work
 * starts and one once it has. The owner fills them in here; whoever cancels gets the right one filled
 * in and may still change it, with the reason on record. Leaving with unsaved changes asks first.
 */
import { formatMoney } from '@bolusi/i18n';
import { ConfirmSheet, TextInput, Text } from '@bolusi/ui';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { type DiscardGuard } from '../../screen-kit/index.js';

import { acceptsRupiahText, parseRupiah } from '../flows.js';
import type { CancelFees } from '../queries.js';

import { tn, type RepairKey } from '../i18n.js';
import { FlowScreen, QueryView, repairStyles, type RepairChrome } from './parts.js';
import { useCancelFees } from '../runtime.js';
import { useCancelFeesForm } from '../settings-forms.js';

export interface CancelFeesScreenProps {
  readonly chrome: RepairChrome;
  readonly onClose: () => void;
  readonly onRegisterDiscardGuard?: ((guard: DiscardGuard | null) => void) | undefined;
  readonly testID?: string | undefined;
}

export function CancelFeesScreen({
  chrome,
  onClose,
  onRegisterDiscardGuard,
  testID = 'repair.fees',
}: CancelFeesScreenProps): React.JSX.Element {
  const [reloadNonce, setReloadNonce] = useState(0);
  const fees = useCancelFees(reloadNonce);
  return (
    <QueryView
      query={fees}
      onBack={onClose}
      onRetry={() => setReloadNonce((n) => n + 1)}
      testID={testID}
    >
      {(saved) => (
        <FeesForm
          saved={saved}
          chrome={chrome}
          onClose={onClose}
          onRegisterDiscardGuard={onRegisterDiscardGuard}
          testID={testID}
        />
      )}
    </QueryView>
  );
}

/** A fee as rupiah; an emptied field stays empty rather than snapping back to "Rp 0". */
function moneyText(amount: number | null): string {
  return amount === null ? '' : formatMoney(amount);
}

const FIELDS: readonly { readonly key: keyof CancelFees; readonly label: RepairKey }[] = [
  { key: 'beforeWork', label: 'repair.fees.beforeWork' },
  { key: 'afterWork', label: 'repair.fees.afterWork' },
];

function FeesForm({
  saved,
  chrome,
  onClose,
  onRegisterDiscardGuard,
  testID,
}: {
  /** The fees on opening; after a save, the form compares against what it saved. */
  readonly saved: CancelFees;
  readonly chrome: RepairChrome;
  readonly onClose: () => void;
  readonly onRegisterDiscardGuard?: ((guard: DiscardGuard | null) => void) | undefined;
  readonly testID: string;
}): React.JSX.Element {
  const form = useCancelFeesForm(saved);
  const { runner, fees, dirty } = form;
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);

  useEffect(() => {
    onRegisterDiscardGuard?.(dirty ? (proceed) => setPendingLeave(() => proceed) : null);
    return () => onRegisterDiscardGuard?.(null);
  }, [dirty, onRegisterDiscardGuard]);

  return (
    <FlowScreen
      chrome={chrome}
      title={tn('repair.fees.title')}
      onBack={() => (dirty ? setPendingLeave(() => onClose) : onClose())}
      primaryLabel={tn('repair.fees.save')}
      onPrimary={() => form.save(onClose)}
      primaryDisabled={!form.complete}
      primaryHint={tn('repair.fees.hint')}
      busy={runner.busy}
      errorCode={runner.errorCode}
      onClearError={runner.clearError}
      notice={form.notice}
      onClearNotice={form.clearNotice}
      overlay={
        pendingLeave === null ? null : (
          <ConfirmSheet
            title={tn('repair.options.discardTitle')}
            message={tn('repair.options.discardMessage')}
            confirmLabel={tn('repair.options.discard')}
            onConfirm={() => {
              const proceed = pendingLeave;
              setPendingLeave(null);
              proceed();
            }}
            cancelLabel={tn('repair.options.keepEditing')}
            onCancel={() => setPendingLeave(null)}
            testID={`${testID}.discard`}
          />
        )
      }
      testID={testID}
    >
      <Text style={repairStyles.muted}>{tn('repair.fees.intro')}</Text>
      {FIELDS.map(({ key, label }) => (
        <View key={key} style={repairStyles.gap}>
          <TextInput
            label={tn(label)}
            // Shown as money while typing ("Rp 50.000"), so there is no second line to read back.
            value={moneyText(fees[key])}
            onChangeText={(next) => {
              if (!acceptsRupiahText(next)) return;
              form.setFee(key, parseRupiah(next.replace(/\D/g, '')));
            }}
            keyboardType="number-pad"
            selectTextOnFocus
            testID={`${testID}.${key}`}
          />
        </View>
      ))}
    </FlowScreen>
  );
}
