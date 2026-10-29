/**
 * Put right what intake wrote down while the phone is in the store: the customer, the phone, the
 * complaint, what was left with it. Intake's own fields on one screen; only what differs is saved,
 * and the servisan's history keeps what it was.
 */
import { TextInput } from '@bolusi/ui';
import { useState } from 'react';
import { Text, View } from 'react-native';

import { useActionRunner } from '../../screen-kit/index.js';
import {
  INTAKE_PROBLEM_KEY,
  correctionDraft,
  correctionOptions,
  correctionProblems,
  toCorrectionInput,
  type IntakeDraft,
  type IntakeProblem,
} from '../flows.js';
import { tn } from '../i18n.js';
import { storeIntakeOptions } from '../intake-options.js';
import { INTAKE_STEP_KEY } from '../labels.js';
import type { TicketDetailRow } from '../queries.js';
import { useIntakeOptionSettings, useRepairRuntime } from '../runtime.js';
import { useDiscardConfirm } from './discard.js';
import { AccessoriesSection, CustomerStep, DeviceStep } from './IntakeSteps.js';
import { FlowScreen, QueryView, Section, repairStyles } from './parts.js';
import type { StepProps } from './TicketSteps.js';

export function CorrectDetailsStep({
  chrome,
  ticket,
  stale,
  onDone,
  onCancel,
  onRegisterDiscardGuard,
  testID = 'repair.correct',
}: Omit<StepProps, 'ticketId'> & {
  readonly ticket: TicketDetailRow;
  readonly testID?: string | undefined;
}): React.JSX.Element {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const settings = useIntakeOptionSettings();
  const [initial] = useState(() => correctionDraft(ticket));
  const [draft, setDraft] = useState(initial);
  const [reason, setReason] = useState('');
  const [showProblems, setShowProblems] = useState(false);
  const update = (patch: Partial<IntakeDraft>): void => setDraft((d) => ({ ...d, ...patch }));
  const options =
    settings.status === 'ready'
      ? correctionOptions(storeIntakeOptions(settings.data), ticket)
      : null;
  const problems = options === null ? [] : correctionProblems(draft, options);
  const problemText = (problem: IntakeProblem): string | undefined =>
    showProblems && problems.includes(problem) ? tn(INTAKE_PROBLEM_KEY[problem]) : undefined;
  const changed = JSON.stringify(draft) !== JSON.stringify(initial);
  const discard = useDiscardConfirm({
    dirty: stale === null && (changed || reason.trim() !== ''),
    onRegisterDiscardGuard,
    testID,
  });

  const submit = (): void => {
    if (options === null) return;
    if (problems.length > 0) {
      setShowProblems(true);
      return;
    }
    if (!changed) {
      onCancel();
      return;
    }
    void runner
      .run(() =>
        runtime.run('correctTicketDetails', toCorrectionInput(ticket, draft, options, reason)),
      )
      .then((result) => {
        if (result !== undefined) onDone();
      });
  };

  return (
    <FlowScreen
      chrome={chrome}
      title={tn('repair.correct.title')}
      onBack={() => discard.requestLeave(onCancel)}
      primaryLabel={tn('repair.correct.save')}
      onPrimary={submit}
      primaryDisabled={options === null}
      overlay={discard.overlay}
      busy={runner.busy}
      errorCode={runner.errorCode}
      stale={stale}
      onClearError={runner.clearError}
      testID={testID}
    >
      <Text style={repairStyles.muted}>{tn('repair.correct.about')}</Text>
      <QueryView
        query={settings}
        onBack={onCancel}
        onRetry={() => undefined}
        testID={`${testID}.options`}
      >
        {() =>
          options === null ? null : (
            <View>
              <Section title={tn(INTAKE_STEP_KEY.customer)}>
                <CustomerStep
                  draft={draft}
                  update={update}
                  options={options}
                  nameError={problemText('customerName')}
                  phoneError={problemText('customerPhone')}
                  currentCustomerId={ticket.customerId}
                  testID={`${testID}.customer`}
                />
              </Section>
              <Section title={tn(INTAKE_STEP_KEY.device)}>
                {/* A claim is for its servisan's phone: the rule refuses another one. */}
                {ticket.claimOfTicketId === null ? (
                  <DeviceStep
                    draft={draft}
                    update={update}
                    options={options}
                    brandError={problemText('deviceBrand')}
                    modelError={problemText('deviceModel')}
                    imeiError={problemText('deviceImei')}
                    lockError={problemText('screenLock')}
                    testID={`${testID}.device`}
                  />
                ) : (
                  <Text style={repairStyles.muted}>{tn('repair.correct.claimDevice')}</Text>
                )}
              </Section>
              <Section title={tn(INTAKE_STEP_KEY.condition)}>
                <TextInput
                  label={tn('repair.condition.complaint')}
                  value={draft.complaint}
                  onChangeText={(complaint) => update({ complaint })}
                  errorMessage={problemText('complaint')}
                  multiline
                  testID={`${testID}.complaint`}
                />
              </Section>
              <AccessoriesSection
                draft={draft}
                update={update}
                accessories={options.accessories}
                testID={testID}
              />
              <View style={repairStyles.gap}>
                <TextInput
                  label={tn('repair.correct.reason')}
                  value={reason}
                  onChangeText={setReason}
                  maxLength={500}
                  testID={`${testID}.reason`}
                />
              </View>
            </View>
          )
        }
      </QueryView>
    </FlowScreen>
  );
}
