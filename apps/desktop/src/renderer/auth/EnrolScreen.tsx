// Registering this PC to a store, once: the owner signs in, picks the store and names the PC. The
// same steps and rules as the phone's wizard (the shared enrolment model); only the screens are
// the PC's, and the owner's sign-in token stays in the core.
import { t } from '@bolusi/i18n';
import {
  afterLogin,
  bindingSummary,
  canSubmitConfirm,
  canSubmitCredentials,
  chosenStoreId,
  classifyFailure,
  confirmMissing,
  failureKey,
  initialEnrollmentState,
  needsDiscardConfirm,
  type EnrollmentState,
  type LoginResult,
} from '@bolusi/device/models/enrollment/model';
import { Banner, Button, ChoiceList, ConfirmDialog, SecretField, TextField } from '@bolusi/ui-web';
import { CircleCheck } from 'lucide-react';
import { useState } from 'react';

import { AuthHeading, AuthLayout } from './AuthLayout.js';

export interface EnrolCalls {
  login(request: { loginIdentifier: string; password: string }): Promise<LoginResult>;
  enroll(request: { storeId: string; deviceName: string }): Promise<void>;
  finish(): void;
}

export function EnrolScreen({
  revoked,
  calls,
  onCancel,
}: {
  /** The server blocked this PC: say so above the sign-in. */
  readonly revoked: boolean;
  readonly calls: EnrolCalls;
  /** Present when registering again was asked for from the people list, which it returns to. */
  readonly onCancel?: (() => void) | undefined;
}): React.JSX.Element {
  const [state, setState] = useState<EnrollmentState>(() => initialEnrollmentState(revoked));
  const [discarding, setDiscarding] = useState(false);
  const patch = (next: Partial<EnrollmentState>): void => setState((s) => ({ ...s, ...next }));

  const submitCredentials = async (): Promise<void> => {
    if (!canSubmitCredentials(state)) return;
    patch({ busy: true, failure: null });
    try {
      const login = await calls.login({
        loginIdentifier: state.loginIdentifier.trim(),
        password: state.password,
      });
      // The password is not kept once it has done its job.
      setState((s) => ({ ...afterLogin(s, login), password: '' }));
    } catch (error) {
      patch({ busy: false, failure: classifyFailure(error) });
    }
  };

  const submitConfirm = async (): Promise<void> => {
    const storeId = chosenStoreId(state);
    if (!canSubmitConfirm(state) || storeId === null) return;
    patch({ busy: true, failure: null });
    try {
      await calls.enroll({ storeId, deviceName: state.deviceName.trim() });
      patch({ busy: false, step: 'done' });
    } catch (error) {
      patch({ busy: false, failure: classifyFailure(error) });
    }
  };

  const back = (): void => {
    if (state.step === 'confirm') {
      setState({ ...initialEnrollmentState(revoked), loginIdentifier: state.loginIdentifier });
      return;
    }
    if (needsDiscardConfirm(state)) setDiscarding(true);
    else onCancel?.();
  };

  const failure =
    state.failure === null ? null : (
      <Banner tone="danger" message={t(failureKey(state.failure) as never)} className="mb-4" />
    );

  if (state.step === 'done') {
    const summary = bindingSummary(state);
    return (
      <AuthLayout testId="enrol.done">
        <div className="flex flex-col items-center text-center">
          <CircleCheck size={48} strokeWidth={1.5} aria-hidden className="mb-4 text-success" />
          <AuthHeading title={t('auth.enroll.success')} align="center" />
          {summary === null ? null : (
            <div className="mb-6 w-full rounded-sm bg-surface-alt px-4 py-3">
              <p className="text-small text-text-muted">{t('auth.enroll.successStore')}</p>
              <p className="break-words text-heading font-semibold text-text">
                {summary.storeName}
              </p>
            </div>
          )}
          <p className="mb-6 text-body text-text-muted">{t('auth.enroll.successNext')}</p>
          <Button
            label={t('auth.enroll.finish')}
            variant="primary"
            size="lg"
            className="w-full"
            onClick={() => calls.finish()}
            data-testid="enrol.finish"
            autoFocus
          />
        </div>
      </AuthLayout>
    );
  }

  if (state.step === 'confirm' && state.login !== null) {
    const summary = bindingSummary(state);
    const missing = confirmMissing(state);
    const stores = state.login.stores;
    return (
      <AuthLayout testId="enrol.confirm">
        <AuthHeading
          title={t('auth.enroll.nameTitle')}
          lead={t('auth.enroll.account', { tenant: state.login.tenantName })}
        />
        {failure}
        <form
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            void submitConfirm();
          }}
        >
          {stores.length === 1 ? (
            <div className="rounded-sm bg-surface-alt px-4 py-3" data-testid="enrol.store">
              <p className="text-small text-text-muted">{t('auth.enroll.storeLabel')}</p>
              <p className="break-words text-heading font-semibold text-text">{stores[0]!.name}</p>
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              <p className="text-small font-semibold text-text">{t('auth.enroll.storeTitle')}</p>
              <ChoiceList
                label={t('auth.enroll.storeTitle')}
                options={stores.map((store) => ({ value: store.id, label: store.name }))}
                value={state.selectedStoreId}
                onChange={(selectedStoreId) => patch({ selectedStoreId, failure: null })}
                testId="enrol.stores"
              />
            </div>
          )}
          <TextField
            label={t('auth.pc.deviceNameField')}
            placeholder={t('auth.pc.deviceNamePlaceholder')}
            value={state.deviceName}
            maxLength={64}
            onChange={(event) => patch({ deviceName: event.target.value })}
            disabled={state.busy}
            data-testid="enrol.deviceName"
          />
          <div className="flex flex-col gap-2">
            {missing === null || state.busy ? null : (
              <p className="text-small text-text-muted" data-testid="enrol.missing">
                {t(missing === 'store' ? 'auth.enroll.pickStoreFirst' : 'auth.pc.nameDeviceFirst')}
              </p>
            )}
            <Button
              type="submit"
              label={
                summary === null
                  ? t('auth.enroll.bindWithoutStore')
                  : t('auth.enroll.bind', { store: summary.storeName })
              }
              variant="primary"
              size="lg"
              busy={state.busy}
              disabled={!canSubmitConfirm(state)}
              className="w-full"
              data-testid="enrol.bind"
            />
            <Button
              label={t('core.action.back')}
              variant="text"
              onClick={back}
              disabled={state.busy}
              className="self-center"
              data-testid="enrol.back"
            />
          </div>
        </form>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout testId="enrol.credentials">
      <AuthHeading title={t('auth.pc.enrollTitle')} lead={t('auth.pc.instruction')} />
      {state.revoked ? (
        <Banner tone="danger" message={t('auth.revoked.body')} className="mb-4" />
      ) : null}
      {failure}
      <form
        className="flex flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          void submitCredentials();
        }}
      >
        <div className="flex flex-col gap-4">
          <p className="text-heading font-semibold text-text">
            {t('auth.enroll.credentialsTitle')}
          </p>
          <TextField
            label={t('auth.enroll.identifierField')}
            value={state.loginIdentifier}
            autoComplete="username"
            maxLength={64}
            onChange={(event) => patch({ loginIdentifier: event.target.value })}
            disabled={state.busy}
            data-testid="enrol.identifier"
          />
          <SecretField
            label={t('auth.enroll.passwordField')}
            showLabel={t('auth.pc.showPassword')}
            hideLabel={t('auth.pc.hidePassword')}
            value={state.password}
            maxLength={128}
            onChange={(event) => patch({ password: event.target.value })}
            disabled={state.busy}
            data-testid="enrol.password"
          />
        </div>
        <div className="flex flex-col gap-2">
          <Button
            type="submit"
            label={t('auth.enroll.submit')}
            variant="primary"
            size="lg"
            busy={state.busy}
            disabled={!canSubmitCredentials(state)}
            className="w-full"
            data-testid="enrol.submit"
          />
          {onCancel === undefined ? null : (
            <Button
              label={t('core.action.back')}
              variant="text"
              onClick={back}
              disabled={state.busy}
              className="self-center"
              data-testid="enrol.cancel"
            />
          )}
        </div>
      </form>
      <ConfirmDialog
        open={discarding}
        closeLabel={t('core.action.close')}
        destructive
        title={t('auth.enroll.discardTitle')}
        message={t('auth.enroll.discardMessage')}
        confirmLabel={t('auth.enroll.discard')}
        cancelLabel={t('auth.enroll.keepEditing')}
        onConfirm={() => {
          setDiscarding(false);
          onCancel?.();
        }}
        onCancel={() => setDiscarding(false)}
      />
    </AuthLayout>
  );
}
