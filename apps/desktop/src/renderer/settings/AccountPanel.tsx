// "Akun": who is signed in and their own PIN. Changing it asks for the current PIN, then the new
// one twice, through the phone's change-PIN model: a wrong current PIN counts towards the lockout
// exactly as at sign-in, and only a confirmed new PIN is ever saved.
import { t } from '@bolusi/i18n';
import {
  CHANGE_PIN_START,
  changeFeedbackKey,
  changePadState,
  changePinFailure,
  changePinReducer,
  changePromptKey,
  type ChangePinPhase,
} from '@bolusi/device/models/pin/change-pin.model';
import { Avatar, Button, Card, Dialog, PinPad, SettingsPanel } from '@bolusi/ui-web';
import { clsx } from 'clsx';
import { CircleCheck, KeyRound } from 'lucide-react';
import { useEffect, useReducer, useRef, useState } from 'react';

import type { CounterPerson } from '../Counter.js';

export function AccountPanel({
  person,
  changePin,
}: {
  readonly person: CounterPerson;
  readonly changePin: ((currentPin: string, newPin: string) => Promise<void>) | undefined;
}): React.JSX.Element {
  const [changing, setChanging] = useState(false);
  return (
    <SettingsPanel title={t('auth.pc.settings.account')} testId="desktop.settings.account">
      <Card>
        <div className="flex items-center gap-4" data-testid="desktop.settings.account.who">
          <Avatar userId={person.userId} name={person.name} size={56} />
          <div className="flex min-w-0 flex-col">
            <p className="break-words text-heading font-semibold text-text">{person.name}</p>
            {person.role === '' ? null : (
              <p className="break-words text-body text-text-muted">{person.role}</p>
            )}
          </div>
        </div>
      </Card>
      {changePin === undefined ? null : (
        <Card>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-surface-alt text-text-muted">
                <KeyRound size={18} aria-hidden />
              </span>
              <div className="flex min-w-0 flex-col">
                <p className="text-body font-semibold text-text">{t('auth.pin.change.title')}</p>
                <p className="text-small text-text-muted">{t('auth.pc.settings.pinSummary')}</p>
              </div>
            </div>
            <Button
              label={t('auth.pin.change.title')}
              onClick={() => setChanging(true)}
              data-testid="desktop.settings.changePin"
            />
          </div>
        </Card>
      )}
      {changing && changePin !== undefined ? (
        <ChangePinDialog person={person} changePin={changePin} onClose={() => setChanging(false)} />
      ) : null}
    </SettingsPanel>
  );
}

function ChangePinDialog({
  person,
  changePin,
  onClose,
}: {
  readonly person: CounterPerson;
  readonly changePin: (currentPin: string, newPin: string) => Promise<void>;
  readonly onClose: () => void;
}): React.JSX.Element {
  const [phase, dispatch] = useReducer(changePinReducer, CHANGE_PIN_START);
  // The latest call, so a re-render while saving never cancels and reruns the change.
  const change = useRef(changePin);
  change.current = changePin;

  useEffect(() => {
    if (phase.kind !== 'submitting') return;
    let cancelled = false;
    void change.current(phase.currentPin, phase.newPin).then(
      () => {
        if (!cancelled) dispatch({ kind: 'settled', result: { ok: true } });
      },
      (error: unknown) => {
        if (!cancelled) dispatch({ kind: 'settled', result: changePinFailure(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [phase]);

  const done = phase.kind === 'done';
  const submitting = phase.kind === 'submitting';
  const prompt = changePromptKey(phase);
  const feedback = changeFeedbackKey(phase);
  const padState = submitting ? 'busy' : changePadState(phase);
  return (
    <Dialog
      open
      // Leaving while it saves would hide whether the PIN changed.
      onRequestClose={() => (submitting ? undefined : onClose())}
      title={t('auth.pin.change.title')}
      closeLabel={t('core.action.close')}
      size="sm"
      testId="desktop.changePin"
      footer={
        done ? (
          <Button
            label={t('auth.pin.staff.finish')}
            variant="primary"
            onClick={onClose}
            autoFocus
            data-testid="desktop.changePin.finish"
          />
        ) : undefined
      }
    >
      {done ? (
        <div
          className="flex flex-col items-center gap-2 py-4 text-center"
          data-testid="desktop.changePin.done"
        >
          <CircleCheck size={40} strokeWidth={1.5} aria-hidden className="text-success" />
          <p className="text-heading font-semibold text-text">{t('auth.pin.change.done')}</p>
          <p className="text-body text-text-muted">{t('auth.pin.change.doneBody')}</p>
        </div>
      ) : (
        <PinSteps
          person={person}
          prompt={t(prompt ?? 'auth.pin.setup.repeat')}
          message={submitting ? t('auth.pin.saving') : feedback === null ? undefined : t(feedback)}
          danger={padState === 'error' || padState === 'locked'}
          padState={padState}
          padKey={padKey(phase)}
          onComplete={(pin) => {
            if (phase.kind === 'current') dispatch({ kind: 'enteredCurrent', pin });
            else if (phase.kind === 'new') dispatch({ kind: 'enteredNew', pin });
          }}
          testId="desktop.changePin"
        />
      )}
    </Dialog>
  );
}

/** A fresh pad for each of current, new and repeat, so digits never carry over between them. */
function padKey(phase: ChangePinPhase): string {
  if (phase.kind === 'new') {
    return `new-${phase.entry.kind}-${String(phase.entry.kind === 'first' && phase.entry.afterMismatch)}`;
  }
  if (phase.kind === 'current') return `current-${phase.feedback}`;
  return phase.kind;
}

/** Whose PIN it is, the question, the pad and the line under it: one PIN step in a dialog. */
export function PinSteps({
  person,
  prompt,
  message,
  danger,
  padState,
  padKey: key,
  onComplete,
  testId,
}: {
  readonly person: { readonly userId: string; readonly name: string };
  readonly prompt: string;
  readonly message: string | undefined;
  readonly danger: boolean;
  readonly padState: 'entry' | 'error' | 'locked' | 'busy';
  readonly padKey: string;
  readonly onComplete: (pin: string) => void;
  readonly testId: string;
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-4">
      <div className="flex flex-col items-center gap-2 text-center">
        <Avatar userId={person.userId} name={person.name} size={40} />
        <p className="break-words text-body font-semibold text-text">{person.name}</p>
      </div>
      <p className="text-heading font-semibold text-text" data-testid={`${testId}.prompt`}>
        {prompt}
      </p>
      <PinPad
        key={key}
        state={padState}
        onComplete={onComplete}
        label={prompt}
        deleteLabel={t('core.action.delete')}
        testId={`${testId}.pad`}
      />
      {/* The line keeps its height, so the pad does not jump as messages come and go. */}
      <p
        role={danger ? 'alert' : undefined}
        data-testid={`${testId}.message`}
        className={clsx(
          'min-h-[44px] text-center text-body',
          danger ? 'text-danger' : 'text-text-muted',
        )}
      >
        {message ?? ''}
      </p>
    </div>
  );
}
