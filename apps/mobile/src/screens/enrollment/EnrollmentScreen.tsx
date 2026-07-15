/**
 * Device Enrollment wizard (design-system §8.5/§3.10). Renders `model.ts`; the reasoning is there.
 *
 * Three things are visible only here:
 *
 *  - PROGRESS IS TEXT ("1/3"), not a progress bar. §3.10 asks for it, and on this screen it earns
 *    its place: it is the promise that this ends. A supervised, one-time, high-stakes flow with no
 *    visible end is where a nervous owner gives up and calls someone.
 *
 *  - STEP 2 LEADS WITH THE BINDING, not with the form. The tenant and store are the biggest text on
 *    the screen, above the device-name field, because they are what the user is being asked to
 *    check — not what they are being asked to fill in. A summary tucked under a form is a summary
 *    nobody reads, and wrong-store enrollment is the error §8.5 says to design against.
 *
 *  - THE FAILURE SLOT IS INLINE AND ALWAYS IN THE SAME PLACE — directly under the primary action,
 *    never a toast (§3.7: toasts vanish before slow readers finish, and this reader is nervous).
 */
import { t } from '@bolusi/i18n';
import {
  AppShell,
  Banner,
  Button,
  Card,
  ConfirmSheet,
  ListRow,
  SyncChip,
  TextInput,
  color,
  space,
  type,
} from '@bolusi/ui';
import { StyleSheet, Text, View } from 'react-native';

import {
  bindingSummary,
  canSubmitConfirm,
  canSubmitCredentials,
  credentialsError,
  deviceNameError,
  failureKey,
  type EnrollmentState,
} from './model.js';
// `needsDiscardConfirm` is deliberately NOT used here: whether a back press needs the ConfirmSheet
// is the SHELL's question (hardware back and header back are one action — §8.1), so the root asks the
// model and passes the answer down as `discardPrompt`. Deciding it inside this component would give
// the header's back and Android's back two different opinions about the same press.

export interface EnrollmentScreenProps {
  readonly state: EnrollmentState;
  readonly onChange: (patch: Partial<EnrollmentState>) => void;
  readonly onLogin: () => void;
  readonly onEnroll: () => void;
  readonly onFinish: () => void;
  readonly onBack: () => void;
  /** Set when a back press hit non-empty input — §8.1's ConfirmSheet before discarding. */
  readonly discardPrompt: boolean;
  readonly onConfirmDiscard: () => void;
  readonly onCancelDiscard: () => void;
}

/** §3.10: "1/3" in the header. Ordered so the index is the step's position, not a magic number. */
const STEPS = ['credentials', 'confirm', 'done'] as const;

export function EnrollmentScreen(props: EnrollmentScreenProps): React.JSX.Element {
  const { state, discardPrompt, onConfirmDiscard, onCancelDiscard } = props;
  const stepNumber = STEPS.indexOf(state.step) + 1;

  return (
    <AppShell
      title={t('auth.enroll.title')}
      // The progress lives in the accessibility label as well as the visible counter: a screen
      // reader user needs "2 of 3" as much as a sighted one does.
      backLabel={t('core.action.back')}
      syncChip={
        <SyncChip
          state="offline"
          accessibilityLabel={t('auth.enroll.needsConnection')}
          onPress={noop}
        />
      }
      avatar={<View testID="enroll-no-avatar" />}
      banner={
        state.revoked ? (
          // §8.5: a revoked device lands here and is told WHY, in danger, before it retries.
          <Banner
            variant="danger"
            message={t('auth.revoked.body')}
            testID="enroll-revoked-banner"
          />
        ) : undefined
      }
      testID="enrollment-screen"
    >
      <Text style={styles.progress} testID="enroll-progress">
        {`${stepNumber}/${STEPS.length}`}
      </Text>

      {state.step === 'credentials' ? <CredentialsStep {...props} /> : null}
      {state.step === 'confirm' ? <ConfirmStep {...props} /> : null}
      {state.step === 'done' ? <DoneStep {...props} /> : null}

      {discardPrompt ? (
        <ConfirmSheet
          title={t('core.action.cancel')}
          message={t('auth.enroll.instruction')}
          confirmLabel={t('core.action.confirm')}
          onConfirm={onConfirmDiscard}
          cancelLabel={t('core.action.cancel')}
          onCancel={onCancelDiscard}
          testID="enroll-discard-sheet"
        />
      ) : null}
    </AppShell>
  );
}

function CredentialsStep({ state, onChange, onLogin }: EnrollmentScreenProps): React.JSX.Element {
  const invalid = credentialsError(state);
  return (
    <View testID="enroll-step-credentials">
      <Text style={styles.instruction}>{t('auth.enroll.instruction')}</Text>
      <TextInput
        label={t('auth.enroll.identifierField')}
        value={state.loginIdentifier}
        onChangeText={(loginIdentifier) => onChange({ loginIdentifier })}
        disabled={state.busy}
        autoFocus
        testID="enroll-identifier"
        {...(invalid === 'identifier' && state.loginIdentifier.length > 0
          ? { errorMessage: t('core.errors.VALIDATION_FAILED') }
          : {})}
      />
      <TextInput
        label={t('auth.enroll.passwordField')}
        value={state.password}
        onChangeText={(password) => onChange({ password })}
        secureTextEntry
        disabled={state.busy}
        testID="enroll-password"
        {...(invalid === 'password' && state.password.length > 0
          ? { errorMessage: t('core.errors.VALIDATION_FAILED') }
          : {})}
      />
      <Failure state={state} />
      <Button
        label={t('auth.enroll.submit')}
        onPress={onLogin}
        disabled={!canSubmitCredentials(state)}
        busy={state.busy}
        testID="enroll-submit"
      />
    </View>
  );
}

function ConfirmStep({ state, onChange, onEnroll }: EnrollmentScreenProps): React.JSX.Element {
  const summary = bindingSummary(state);
  return (
    <View testID="enroll-step-confirm">
      {/* The binding, first and biggest — this is what the user is here to CHECK. */}
      {summary !== null ? (
        <Card testID="enroll-binding-summary">
          <Text style={styles.bindingLabel}>{t('auth.enroll.title')}</Text>
          <Text style={styles.bindingValue} testID="enroll-tenant-name">
            {summary.tenantName}
          </Text>
          <Text style={styles.bindingValue} testID="enroll-store-name">
            {summary.storeName}
          </Text>
        </Card>
      ) : null}

      {(state.login?.stores ?? []).map((store) => (
        <ListRow
          key={store.id}
          primaryText={store.name}
          onPress={() => onChange({ selectedStoreId: store.id, confirmed: false })}
          testID={`enroll-store-${store.id}`}
        />
      ))}

      <TextInput
        label={t('auth.enroll.identifierField')}
        value={state.deviceName}
        onChangeText={(deviceName) => onChange({ deviceName })}
        disabled={state.busy}
        testID="enroll-device-name"
        {...(deviceNameError(state) !== null && state.deviceName.length > 0
          ? { errorMessage: t('core.errors.VALIDATION_FAILED') }
          : {})}
      />

      <Button
        label={t('core.action.confirm')}
        variant={state.confirmed ? 'primary' : 'secondary'}
        onPress={() => onChange({ confirmed: !state.confirmed })}
        disabled={state.selectedStoreId === null}
        testID="enroll-confirm-toggle"
      />

      <Failure state={state} />

      <Button
        label={t('auth.enroll.submit')}
        onPress={onEnroll}
        disabled={!canSubmitConfirm(state)}
        busy={state.busy}
        testID="enroll-bind"
      />
    </View>
  );
}

function DoneStep({ onFinish }: EnrollmentScreenProps): React.JSX.Element {
  return (
    <View testID="enroll-step-done">
      <Text style={styles.done} testID="enroll-success">
        {t('auth.enroll.success')}
      </Text>
      {/* §4.4: enrollment logs nobody in. The next stop is the switcher, where the enrolling owner
          sets their own PIN like everyone else (§6.6). */}
      <Button label={t('auth.switcher.title')} onPress={onFinish} testID="enroll-finish" />
    </View>
  );
}

/** The one inline failure slot, always directly under the action that failed (§3.7). */
function Failure({ state }: { readonly state: EnrollmentState }): React.JSX.Element | null {
  if (state.failure === null) return null;
  const key = failureKey(state.failure);
  return (
    <Text style={styles.failure} testID={`enroll-failure-${state.failure.kind}`}>
      {state.failure.kind === 'rateLimited'
        ? t('core.errors.RATE_LIMITED')
        : key === 'auth.enroll.needsConnection'
          ? t('auth.enroll.needsConnection')
          : key === 'core.errors.PERMISSION_DENIED'
            ? t('core.errors.PERMISSION_DENIED')
            : t('core.errors.NOT_AUTHENTICATED')}
    </Text>
  );
}

function noop(): void {
  // The enrollment header's SyncChip is inert: there is no device identity yet, so there is no sync
  // to inspect and no Sync Status screen to open. It renders `offline` because that is true.
}

const styles = StyleSheet.create({
  progress: { ...type.caption, color: color.textMuted, marginBottom: space.sm },
  instruction: { ...type.bodySm, color: color.textMuted, marginBottom: space.lg },
  bindingLabel: { ...type.caption, color: color.textMuted },
  bindingValue: { ...type.title, color: color.text },
  failure: { ...type.bodySm, color: color.danger, marginVertical: space.md },
  done: { ...type.title, color: color.success, marginBottom: space.xl },
});
