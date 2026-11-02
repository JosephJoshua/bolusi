/**
 * UncollectedDaysScreen — after how many days a repaired or cancelled phone still in the store is
 * flagged as not collected, so the counter calls the customer. The store owner sets it here; until
 * then it is two months. Leaving with an unsaved change asks first.
 */
import { ConfirmSheet, TextInput, Text } from '@bolusi/ui';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { useActionRunner, type DiscardGuard } from '../../screen-kit/index.js';

import { parseUncollectedDays } from '../constants.js';
import { tn } from '../i18n.js';
import { FlowScreen, QueryView, repairStyles, type RepairChrome } from './parts.js';
import { useRepairRuntime, useUncollectedLimit } from '../runtime.js';

export interface UncollectedDaysScreenProps {
  readonly chrome: RepairChrome;
  readonly onClose: () => void;
  readonly onRegisterDiscardGuard?: ((guard: DiscardGuard | null) => void) | undefined;
  readonly testID?: string | undefined;
}

export function UncollectedDaysScreen({
  chrome,
  onClose,
  onRegisterDiscardGuard,
  testID = 'repair.uncollected',
}: UncollectedDaysScreenProps): React.JSX.Element {
  const [reloadNonce, setReloadNonce] = useState(0);
  const limit = useUncollectedLimit(reloadNonce);
  return (
    <QueryView
      query={limit}
      onBack={onClose}
      onRetry={() => setReloadNonce((n) => n + 1)}
      testID={testID}
    >
      {(saved) => (
        <DaysForm
          saved={saved.days}
          chrome={chrome}
          onClose={onClose}
          onRegisterDiscardGuard={onRegisterDiscardGuard}
          testID={testID}
        />
      )}
    </QueryView>
  );
}

function DaysForm({
  saved,
  chrome,
  onClose,
  onRegisterDiscardGuard,
  testID,
}: {
  /** The days on opening; after a save, the form compares against what it saved. */
  readonly saved: number;
  readonly chrome: RepairChrome;
  readonly onClose: () => void;
  readonly onRegisterDiscardGuard?: ((guard: DiscardGuard | null) => void) | undefined;
  readonly testID: string;
}): React.JSX.Element {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const [text, setText] = useState(String(saved));
  const [baseline, setBaseline] = useState(saved);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);

  const days = parseUncollectedDays(text);
  const dirty = days !== baseline;

  useEffect(() => {
    onRegisterDiscardGuard?.(dirty ? (proceed) => setPendingLeave(() => proceed) : null);
    return () => onRegisterDiscardGuard?.(null);
  }, [dirty, onRegisterDiscardGuard]);

  const save = (): void => {
    if (days === null) return;
    if (!dirty) {
      onClose();
      return;
    }
    void runner
      .run(() => runtime.run('setUncollectedDays', { days }))
      .then((result) => {
        if (result === undefined) return;
        setBaseline(result.days);
        setNotice(tn('repair.uncollected.saved'));
      });
  };

  return (
    <FlowScreen
      chrome={chrome}
      title={tn('repair.uncollected.title')}
      onBack={() => (dirty ? setPendingLeave(() => onClose) : onClose())}
      primaryLabel={tn('repair.uncollected.save')}
      onPrimary={save}
      primaryDisabled={days === null}
      primaryHint={tn('repair.uncollected.hint')}
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
      <Text style={repairStyles.muted}>{tn('repair.uncollected.intro')}</Text>
      <View style={repairStyles.gap}>
        <TextInput
          label={tn('repair.uncollected.days')}
          value={text}
          onChangeText={(next) => {
            const digits = next.replace(/\D/g, '').slice(0, 3);
            setNotice(null);
            setText(digits);
          }}
          keyboardType="number-pad"
          testID={`${testID}.days`}
        />
      </View>
    </FlowScreen>
  );
}
