/**
 * Device Enrollment wizard (design-system §8.5/§3.10). Renders `model.ts`; the reasoning is there.
 *
 * Built like the other guided flows (intake): a `StepHeader` with "1 dari 3" and the step's title,
 * the body, and ONE primary action fixed at the bottom. What is particular to this screen:
 *
 *  - STEP 2 IS A CHOICE, AND THE BUTTON NAMES IT. The stores are a list whose chosen row is checked,
 *    and the primary button reads "Daftarkan ke Toko Utama". Wrong-store enrollment is the error
 *    §8.5 designs against; a button that says the store out loud is the confirmation, so there is
 *    no separate "Ya, lanjutkan" toggle competing with it (first Android QA run found the toggle
 *    plus a "Masuk" button confusing).
 *
 *  - A REFUSAL GOES IN THE FIXED BANNER SLOT, never a toast (§3.7: toasts vanish before slow
 *    readers finish, and this reader is nervous), and it stays visible wherever the form scrolled.
 *
 *  - NO SYNC CHIP. There is no device identity yet, so there is no sync to report on; a permanent
 *    "offline" cloud here only said something false and alarming.
 */
import { t, translateErrorCode, translateOpType, type TranslationKey } from '@bolusi/i18n';
import {
  AppShell,
  Banner,
  Button,
  ChipRow,
  ConfirmSheet,
  Icon,
  ListRow,
  StepHeader,
  TextInput,
  ToggleChip,
  border,
  color,
  radius,
  size,
  space,
  type,
  Text,
} from '@bolusi/ui';
import { StyleSheet, View } from 'react-native';

import {
  PASSWORD_MIN,
  bindingSummary,
  canSubmitConfirm,
  canSubmitCredentials,
  chosenPersonalUserId,
  confirmMissing,
  credentialsError,
  failureKey,
  personalChoices,
  type EnrollmentFailure,
  type EnrollmentState,
} from '@bolusi/device/models/enrollment/model';
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

/** The steps, counted "1 dari 3". Ordered so the index is the step's position. */
const STEPS = ['credentials', 'confirm', 'done'] as const;

export function EnrollmentScreen(props: EnrollmentScreenProps): React.JSX.Element {
  const { state, discardPrompt, onConfirmDiscard, onCancelDiscard } = props;
  const stepNumber = STEPS.indexOf(state.step) + 1;

  return (
    <AppShell
      // A tenant with several stores overflows a small viewport (task 206).
      scrollable
      title={t('auth.enroll.title')}
      syncChip={null}
      avatar={<View testID="enroll-no-avatar" />}
      banner={<EnrollBanner state={state} />}
      bottomAction={<BottomAction {...props} />}
      testID="enrollment-screen"
      // OVERLAY slot, not children: this screen is `scrollable`, and inside a ScrollView the sheet's
      // absolute box spans the scrollable height, dropping its buttons below the viewport on a long
      // form (found by a QA sweep of tasks 205+206 together).
      overlay={
        discardPrompt ? (
          <ConfirmSheet
            title={t('auth.enroll.discardTitle')}
            message={t('auth.enroll.discardMessage')}
            confirmLabel={t('auth.enroll.discard')}
            onConfirm={onConfirmDiscard}
            cancelLabel={t('auth.enroll.keepEditing')}
            onCancel={onCancelDiscard}
            testID="enroll-discard-sheet"
          />
        ) : null
      }
    >
      {state.step === 'done' ? null : (
        <StepHeader
          step={stepNumber}
          total={STEPS.length}
          progressLabel={t('auth.enroll.progress', { step: stepNumber, total: STEPS.length })}
          title={
            state.step === 'credentials'
              ? t('auth.enroll.credentialsTitle')
              : (state.login?.stores.length ?? 0) === 1
                ? t('auth.enroll.nameTitle')
                : t('auth.enroll.storeTitle')
          }
          testID="enroll-progress"
        />
      )}

      {state.step === 'credentials' ? <CredentialsStep {...props} /> : null}
      {state.step === 'confirm' ? <ConfirmStep {...props} /> : null}
      {state.step === 'done' ? <DoneStep {...props} /> : null}
    </AppShell>
  );
}

function CredentialsStep({ state, onChange }: EnrollmentScreenProps): React.JSX.Element {
  return (
    <View testID="enroll-step-credentials">
      <Text style={styles.lead}>{t('auth.enroll.instruction')}</Text>
      <TextInput
        label={t('auth.enroll.identifierField')}
        value={state.loginIdentifier}
        onChangeText={(loginIdentifier) => onChange({ loginIdentifier })}
        disabled={state.busy}
        autoCorrect={false}
        autoCapitalize="none"
        testID="enroll-identifier"
      />
      <View style={styles.gap}>
        <TextInput
          label={t('auth.enroll.passwordField')}
          value={state.password}
          onChangeText={(password) => onChange({ password })}
          secureTextEntry
          autoCorrect={false}
          autoCapitalize="none"
          disabled={state.busy}
          testID="enroll-password"
        />
      </View>
    </View>
  );
}

function ConfirmStep({ state, onChange }: EnrollmentScreenProps): React.JSX.Element {
  const stores = state.login?.stores ?? [];
  return (
    <View testID="enroll-step-confirm">
      {state.login === null ? null : (
        <Text style={styles.lead} testID="enroll-tenant-name">
          {t('auth.enroll.account', { tenant: state.login.tenantName })}
        </Text>
      )}
      {stores.length === 1 && stores[0] !== undefined ? (
        // One store: nothing to choose, so it is stated, not offered as a one-row list. The login
        // already preselected it (App.tsx runLogin), and the button names it again.
        <View style={styles.onlyStore} testID={`enroll-store-${stores[0].id}`}>
          <Text style={styles.onlyStoreLabel}>{t('auth.enroll.storeLabel')}</Text>
          <Text style={styles.onlyStoreName}>{stores[0].name}</Text>
        </View>
      ) : (
        // Edge to edge, like every list; the chosen store is checked (§6.3: never colour alone).
        <View style={styles.stores} accessibilityRole="radiogroup">
          {stores.map((store) => (
            <ListRow
              key={store.id}
              primaryText={store.name}
              selected={store.id === state.selectedStoreId}
              // Inert while binding: a tap mid-request would rename the button and the done step
              // to a store the phone was not bound to (§8.5's wrong-store error, by another route).
              onPress={state.busy ? undefined : () => onChange({ selectedStoreId: store.id })}
              testID={`enroll-store-${store.id}`}
            />
          ))}
        </View>
      )}
      <PhoneOwner state={state} onChange={onChange} />
      <View style={styles.section}>
        <TextInput
          label={t('auth.enroll.deviceNameField')}
          placeholder={t('auth.enroll.deviceNamePlaceholder')}
          value={state.deviceName}
          onChangeText={(deviceName) => onChange({ deviceName })}
          disabled={state.busy}
          autoCorrect={false}
          testID="enroll-device-name"
        />
      </View>
      <UnsyncedChanges state={state} />
    </View>
  );
}

/**
 * Whose phone this is (permission-scoped sync). The store's (the default) is shared: everyone at the
 * store signs in, and it holds staff-level data. Someone's own phone holds what they may see, owner
 * costs included, and only they sign in. Hidden when the server offers nobody (an older server).
 */
function PhoneOwner({
  state,
  onChange,
}: Pick<EnrollmentScreenProps, 'state' | 'onChange'>): React.JSX.Element | null {
  const people = personalChoices(state);
  if (people.length === 0) return null;
  const chosen = chosenPersonalUserId(state);
  const self = state.login?.user.id;
  const pick = (personalUserId: string | null) =>
    state.busy ? () => undefined : () => onChange({ personalUserId });
  const chosenName = people.find((person) => person.id === chosen)?.name;
  const hint =
    chosen === null
      ? t('auth.enroll.ownerSharedHint')
      : chosen === self
        ? t('auth.enroll.ownerSelfHint')
        : t('auth.enroll.ownerPersonHint', { name: chosenName ?? '' });
  return (
    <View style={styles.section} testID="enroll-owner">
      <Text style={styles.fieldLabel}>{t('auth.enroll.ownerField')}</Text>
      <ChipRow testID="enroll-owner-chips">
        <ToggleChip
          label={t('auth.enroll.ownerShared')}
          selected={chosen === null}
          onToggle={pick(null)}
          testID="enroll-owner-shared"
        />
        {people.map((person) => (
          <ToggleChip
            key={person.id}
            label={person.id === self ? t('auth.enroll.ownerSelf') : person.name}
            selected={chosen === person.id}
            // Tapping the picked one again goes back to the store's.
            onToggle={pick(chosen === person.id ? null : person.id)}
            testID={`enroll-owner-${person.id}`}
          />
        ))}
      </ChipRow>
      <Text style={styles.fieldHint} testID="enroll-owner-hint">
        {hint}
      </Text>
    </View>
  );
}

/**
 * A phone enrolled again still holds what never reached the server. The owner sees whose changes
 * they are just above the button that binds the phone: pressing it carries them over (core
 * auth/carry-over.ts), each still credited to whoever made it.
 */
function UnsyncedChanges({ state }: { readonly state: EnrollmentState }): React.JSX.Element | null {
  const authors = state.phone?.unsynced ?? [];
  if (authors.length === 0) return null;
  return (
    <View style={styles.section} testID="enroll-unsynced">
      <Text style={styles.sectionTitle}>{t('auth.enroll.unsyncedTitle')}</Text>
      <Text style={styles.sectionText}>{t('auth.enroll.unsyncedBody')}</Text>
      <View style={styles.stores}>
        {authors.map((author) => (
          <ListRow
            key={author.userId}
            primaryText={author.name ?? t('auth.enroll.formerStaff')}
            secondaryText={author.types.map((opType) => translateOpType(opType)).join(', ')}
            trailing={
              <Text style={styles.count}>
                {t('auth.enroll.unsyncedCount', { count: author.count })}
              </Text>
            }
            testID={`enroll-unsynced-${author.userId}`}
          />
        ))}
      </View>
    </View>
  );
}

function DoneStep({ state }: EnrollmentScreenProps): React.JSX.Element {
  const summary = bindingSummary(state);
  return (
    <View style={styles.done} testID="enroll-step-done">
      <Icon name="success" size={size.iconState} color={color.success} />
      <Text style={styles.doneTitle} testID="enroll-success">
        {t('auth.enroll.success')}
      </Text>
      {summary === null ? null : (
        // The store name gets its own line, so a long one never breaks mid-sentence.
        <>
          <Text style={styles.doneStoreLabel}>{t('auth.enroll.successStore')}</Text>
          <Text style={styles.doneStore} testID="enroll-store-name">
            {summary.storeName}
          </Text>
        </>
      )}
      {/* §4.4: enrollment logs nobody in. Next is the switcher, where the enrolling owner makes
          their own PIN if they have none yet; everyone else gets theirs from an owner (§6.6). A
          personal phone has only its person to pick, so it just says to sign in. */}
      <Text style={styles.doneNext}>
        {t(
          state.personalUserId === null
            ? 'auth.enroll.successNext'
            : 'auth.enroll.successNextPersonal',
        )}
      </Text>
    </View>
  );
}

/**
 * The step's one action, with what it is still waiting for said above it while disabled (the
 * same pattern as the repair flows' `primaryHint`).
 */
function BottomAction({
  state,
  onLogin,
  onEnroll,
  onFinish,
}: EnrollmentScreenProps): React.JSX.Element {
  if (state.step === 'done') {
    return <Button label={t('auth.enroll.finish')} onPress={onFinish} testID="enroll-finish" />;
  }
  if (state.step === 'credentials') {
    const tooShort =
      credentialsError(state) === 'password' &&
      state.password.length > 0 &&
      state.password.length < PASSWORD_MIN;
    return (
      <View>
        {tooShort ? (
          <Text style={styles.hint} testID="enroll-hint">
            {t('auth.enroll.passwordTooShort', { min: PASSWORD_MIN })}
          </Text>
        ) : null}
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
  const summary = bindingSummary(state);
  const missing = confirmMissing(state);
  return (
    <View>
      {missing === null || state.busy ? null : (
        <Text style={styles.hint} testID="enroll-hint">
          {missing === 'store' ? t('auth.enroll.pickStoreFirst') : t('auth.enroll.nameDeviceFirst')}
        </Text>
      )}
      <Button
        label={
          summary === null
            ? t('auth.enroll.bindWithoutStore')
            : t('auth.enroll.bind', { store: summary.storeName })
        }
        onPress={onEnroll}
        disabled={!canSubmitConfirm(state)}
        busy={state.busy}
        testID="enroll-bind"
      />
    </View>
  );
}

/** The revoked notice (§8.5: told WHY, in danger, before retrying) outranks a failed attempt. */
function EnrollBanner({ state }: { readonly state: EnrollmentState }): React.JSX.Element | null {
  if (state.revoked && state.failure === null) {
    return (
      <Banner variant="danger" message={t('auth.revoked.body')} testID="enroll-revoked-banner" />
    );
  }
  if (state.failure === null) return null;
  return (
    <Banner
      variant="danger"
      message={failureMessage(state.failure)}
      testID={`enroll-failure-${state.failure.kind}`}
    />
  );
}

/**
 * What went wrong, said as the one thing the person can do about it. The keys come from the model's
 * buckets (`failureKey`); `rejection-keys.test.ts` proves each exists in every catalog, which is
 * what makes the cast safe. An unexpected code goes through the error-code translator's fallback.
 */
function failureMessage(failure: EnrollmentFailure): string {
  return failure.kind === 'unexpected'
    ? translateErrorCode(failure.code)
    : t(failureKey(failure) as TranslationKey);
}

const styles = StyleSheet.create({
  lead: { ...type.bodySm, color: color.textMuted, marginTop: space.sm, marginBottom: space.xl },
  gap: { marginTop: space.md },
  stores: {
    marginHorizontal: -space.lg,
    borderTopWidth: border.hairline,
    borderTopColor: color.border,
  },
  section: { marginTop: space.xl },
  sectionTitle: { ...type.bodyBold, color: color.text },
  sectionText: {
    ...type.bodySm,
    color: color.textMuted,
    marginTop: space.xs,
    marginBottom: space.md,
  },
  count: { ...type.bodySm, fontWeight: '600', color: color.text },
  fieldLabel: { ...type.caption, color: color.textMuted, marginBottom: space.xs },
  fieldHint: { ...type.bodySm, color: color.textMuted, marginTop: space.sm },
  onlyStore: {
    backgroundColor: color.surfaceAlt,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  onlyStoreLabel: { ...type.caption, color: color.textMuted },
  onlyStoreName: { ...type.bodyBold, color: color.text },
  hint: { ...type.bodySm, color: color.textMuted, marginBottom: space.sm, textAlign: 'center' },
  done: { alignItems: 'center', paddingTop: space['3xl'], paddingHorizontal: space.lg },
  doneTitle: { ...type.title, color: color.text, marginTop: space.lg, textAlign: 'center' },
  doneStoreLabel: {
    ...type.bodySm,
    color: color.textMuted,
    marginTop: space.sm,
    textAlign: 'center',
  },
  doneStore: { ...type.bodyBold, color: color.text, textAlign: 'center' },
  doneNext: { ...type.bodySm, color: color.textMuted, marginTop: space.lg, textAlign: 'center' },
});
