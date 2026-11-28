/**
 * Put right what intake wrote down while the phone is in the store: the customer, the phone, the
 * complaint, what was left with it. Intake's own fields on one screen; only what differs is saved,
 * and the servisan's history keeps what it was.
 */
import { TextInput, Text } from '@bolusi/ui';
import { View } from 'react-native';

import { useCorrectDetails } from '../correct-details.js';
import { tn } from '../i18n.js';
import { INTAKE_STEP_KEY } from '../labels.js';
import type { TicketDetailRow } from '../queries.js';
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
  const form = useCorrectDetails(ticket, { onDone, onUnchanged: onCancel });
  const { runner, settings, draft, update, reason, setReason, options, problemText, submit } = form;
  const discard = useDiscardConfirm({
    dirty: stale === null && form.dirty,
    onRegisterDiscardGuard,
    testID,
  });

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
              {/* The slip signed at a handover (since taken back) names this customer and phone. */}
              {ticket.returnedAt !== null ? (
                <View style={repairStyles.gap}>
                  <Text style={repairStyles.muted}>{tn('repair.correct.handedOverLocked')}</Text>
                </View>
              ) : (
                <>
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
                </>
              )}
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
