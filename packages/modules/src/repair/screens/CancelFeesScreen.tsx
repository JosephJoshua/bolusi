/**
 * CancelFeesScreen — what a cancelled servisan costs the customer at this store: one fee before work
 * starts and one once it has. The owner fills them in here; whoever cancels gets the right one filled
 * in and may still change it, with the reason on record. Leaving with unsaved changes asks first.
 */
import { formatMoney } from '@bolusi/i18n';
import { ConfirmSheet, TextInput } from '@bolusi/ui';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';

import { useActionRunner, type DiscardGuard } from '../../screen-kit/index.js';

import { acceptsRupiahText, parseRupiah } from '../flows.js';
import type { CancelFees } from '../queries.js';

import { tn, type RepairKey } from './i18n.js';
import { FlowScreen, QueryView, repairStyles, type RepairChrome } from './parts.js';
import { useCancelFees, useRepairRuntime } from './runtime.js';

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
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const [text, setText] = useState<Record<keyof CancelFees, string>>(() => ({
    beforeWork: String(saved.beforeWork),
    afterWork: String(saved.afterWork),
  }));
  const [baseline, setBaseline] = useState(saved);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);

  const beforeWork = parseRupiah(text.beforeWork);
  const afterWork = parseRupiah(text.afterWork);
  const complete = beforeWork !== null && afterWork !== null;
  const dirty = beforeWork !== baseline.beforeWork || afterWork !== baseline.afterWork;

  useEffect(() => {
    onRegisterDiscardGuard?.(dirty ? (proceed) => setPendingLeave(() => proceed) : null);
    return () => onRegisterDiscardGuard?.(null);
  }, [dirty, onRegisterDiscardGuard]);

  const save = (): void => {
    if (beforeWork === null || afterWork === null) return;
    if (!dirty) {
      onClose();
      return;
    }
    void runner
      .run(() => runtime.run('setCancelFees', { beforeWork, afterWork }))
      .then((result) => {
        if (result === undefined) return;
        setBaseline(result);
        setNotice(tn('repair.fees.saved'));
      });
  };

  return (
    <FlowScreen
      chrome={chrome}
      title={tn('repair.fees.title')}
      onBack={() => (dirty ? setPendingLeave(() => onClose) : onClose())}
      primaryLabel={tn('repair.fees.save')}
      onPrimary={save}
      primaryDisabled={!complete}
      primaryHint={tn('repair.fees.hint')}
      busy={runner.busy}
      errorCode={runner.errorCode}
      onClearError={runner.clearError}
      notice={notice}
      onClearNotice={() => setNotice(null)}
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
      {FIELDS.map(({ key, label }) => {
        const amount = parseRupiah(text[key]);
        return (
          <View key={key} style={repairStyles.gap}>
            <TextInput
              label={tn(label)}
              value={text[key]}
              onChangeText={(next) => {
                if (!acceptsRupiahText(next)) return;
                setNotice(null);
                setText((current) => ({ ...current, [key]: next }));
              }}
              keyboardType="number-pad"
              testID={`${testID}.${key}`}
            />
            {amount === null ? null : (
              <Text style={repairStyles.caption} testID={`${testID}.${key}.preview`}>
                {formatMoney(amount)}
              </Text>
            )}
          </View>
        );
      })}
    </FlowScreen>
  );
}
