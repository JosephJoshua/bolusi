// Signing in with a PIN, and the two cases where there is nothing to type yet: a PIN locked after
// too many wrong tries, and someone who has no PIN on this PC. The owner who registered the PC
// makes their own first PIN here. What the pad shows comes from the phone's PIN models, so the
// lockout rules read the same on both.
import type { PinAttemptRow } from '@bolusi/core';
import { t, translateRoleKey } from '@bolusi/i18n';
import {
  pinMessage,
  pinPadState,
  pinView,
  type LastAttempt,
} from '@bolusi/device/models/pin/model';
import {
  advanceNewPin,
  NEW_PIN_START,
  newPinFeedbackKey,
  newPinPadState,
  newPinPromptKey,
  type NewPinEntry,
} from '@bolusi/device/models/pin/new-pin';
import type { SwitcherUser } from '@bolusi/device/models/switcher/model';
import { Avatar, Button, PinPad } from '@bolusi/ui-web';
import { clsx } from 'clsx';
import { KeyRound, Lock } from 'lucide-react';
import { useEffect, useState } from 'react';

import { AuthLayout } from './AuthLayout.js';

/** What a PIN submission came to, as the screen needs it. */
export type PinSubmitResult = 'opened' | 'wrong' | 'gated' | 'needsFirstPin' | 'failed';

/** Re-render every second while a lockout counts down. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [ticking]);
  return ticking ? now : Date.now();
}

function Person({ user }: { readonly user: SwitcherUser }): React.JSX.Element {
  const role = user.roleKeys.map((key) => translateRoleKey(key)).join(', ');
  return (
    <div className="mb-6 flex flex-col items-center gap-2 text-center" data-testid="pin.person">
      <Avatar userId={user.id} name={user.name} size={56} />
      <p className="break-words text-heading font-semibold text-text">{user.name}</p>
      {role === '' ? null : <p className="-mt-1 text-small text-text-muted">{role}</p>}
    </div>
  );
}

function Message({
  text,
  tone,
  testId,
}: {
  readonly text: string | undefined;
  readonly tone: 'muted' | 'danger';
  readonly testId: string;
}): React.JSX.Element {
  // The line keeps its height when empty, so the pad does not jump as messages come and go.
  return (
    <p
      role={tone === 'danger' ? 'alert' : undefined}
      data-testid={testId}
      className={clsx(
        'min-h-[44px] text-center text-body',
        tone === 'danger' ? 'text-danger' : 'text-text-muted',
      )}
    >
      {text ?? ''}
    </p>
  );
}

export function PinScreen({
  storeName,
  user,
  row,
  onSubmit,
  onSwitchUser,
}: {
  readonly storeName: string | null;
  readonly user: SwitcherUser;
  readonly row: PinAttemptRow | null;
  readonly onSubmit: (pin: string) => Promise<PinSubmitResult>;
  readonly onSwitchUser: () => void;
}): React.JSX.Element {
  const [last, setLast] = useState<LastAttempt>('none');
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [forgotOpen, setForgotOpen] = useState(false);
  const delayed = row?.notBefore !== null && row?.notBefore !== undefined;
  const now = useNow(delayed);
  const view = pinView(row, now, last);
  const switchUser = (
    <Button
      label={t('auth.pc.otherPerson')}
      variant="text"
      onClick={onSwitchUser}
      className="self-center"
      data-testid="pin.switch"
    />
  );

  if (view.kind === 'lockedOut' || user.needsFirstPin) {
    const lockedOut = view.kind === 'lockedOut';
    const Icon = lockedOut ? Lock : KeyRound;
    return (
      <AuthLayout storeName={storeName} testId={lockedOut ? 'pin.lockedOut' : 'pin.noPin'}>
        <Person user={user} />
        <div className="mb-6 flex flex-col items-center gap-2 rounded-sm bg-surface-alt px-6 py-5 text-center">
          <Icon size={28} strokeWidth={1.75} aria-hidden className="text-text-muted" />
          <p className="text-heading font-semibold text-text">
            {t(lockedOut ? 'auth.pin.lockedOutTitle' : 'auth.pin.noPinTitle')}
          </p>
          <p className="text-body text-text-muted">
            {lockedOut ? pinMessage(view) : t('auth.pin.noPinBody')}
          </p>
        </div>
        <div className="flex flex-col">{switchUser}</div>
      </AuthLayout>
    );
  }

  const submit = async (pin: string): Promise<void> => {
    setBusy(true);
    setFailed(false);
    const result = await onSubmit(pin).catch((): PinSubmitResult => 'failed');
    setBusy(false);
    if (result === 'wrong') {
      setLast('wrong');
      setAttempt((n) => n + 1);
    } else if (result === 'failed') {
      setFailed(true);
    } else {
      setLast('none');
    }
  };

  const padState = busy ? 'busy' : pinPadState(view);
  const message = failed ? t('core.errors.UNEXPECTED') : pinMessage(view);
  return (
    <AuthLayout storeName={storeName} testId="pin">
      <Person user={user} />
      <h1 className="mb-4 text-center text-title font-bold text-text">{t('auth.pin.title')}</h1>
      <PinPad
        key={attempt}
        state={padState}
        onComplete={(pin) => void submit(pin)}
        label={t('auth.pin.title')}
        deleteLabel={t('core.action.delete')}
        testId="pin.pad"
      />
      <div className="mt-4 flex flex-col gap-2">
        <Message
          text={message}
          tone={view.kind === 'entry' && !failed ? 'muted' : 'danger'}
          testId="pin.message"
        />
        <div className="flex items-center justify-center gap-2">
          {switchUser}
          <Button
            label={t('auth.pin.forgotTitle')}
            variant="text"
            aria-expanded={forgotOpen}
            onClick={() => setForgotOpen((open) => !open)}
            data-testid="pin.forgot"
          />
        </div>
        {forgotOpen ? (
          <p
            className="rounded-sm bg-surface-alt px-4 py-3 text-center text-body text-text"
            data-testid="pin.forgot.text"
          >
            {t('auth.pin.forgot')}
          </p>
        ) : null}
      </div>
    </AuthLayout>
  );
}

/** The owner who registered this PC makes their own first PIN: type it, repeat it, then in. */
export function FirstPinScreen({
  storeName,
  user,
  onSave,
  onSwitchUser,
}: {
  readonly storeName: string | null;
  readonly user: SwitcherUser;
  readonly onSave: (pin: string) => Promise<void>;
  readonly onSwitchUser: () => void;
}): React.JSX.Element {
  const [entry, setEntry] = useState<NewPinEntry>(NEW_PIN_START);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  const complete = (pin: string): void => {
    const next = advanceNewPin(entry, pin);
    setFailed(false);
    if (next.kind !== 'matched') {
      setEntry(next);
      return;
    }
    setSaving(true);
    onSave(next.pin).catch(() => {
      setSaving(false);
      setFailed(true);
      setEntry(NEW_PIN_START);
    });
  };

  const feedback = newPinFeedbackKey(entry);
  return (
    <AuthLayout storeName={storeName} testId="pin.setup">
      <Person user={user} />
      <h1 className="mb-4 text-center text-title font-bold text-text">
        {t(newPinPromptKey(entry))}
      </h1>
      <PinPad
        key={entry.kind === 'first' ? (entry.problem ?? entry.kind) : entry.kind}
        state={saving ? 'busy' : newPinPadState(entry)}
        onComplete={complete}
        label={t(newPinPromptKey(entry))}
        deleteLabel={t('core.action.delete')}
        testId="pin.setup.pad"
      />
      <div className="mt-4 flex flex-col gap-2">
        <Message
          text={
            failed
              ? t('auth.pin.setup.failed')
              : saving
                ? t('auth.pin.saving')
                : feedback === null
                  ? undefined
                  : t(feedback)
          }
          tone={failed || newPinPadState(entry) === 'error' ? 'danger' : 'muted'}
          testId="pin.setup.message"
        />
        <Button
          label={t('auth.pc.otherPerson')}
          variant="text"
          onClick={onSwitchUser}
          disabled={saving}
          className="self-center"
          data-testid="pin.setup.switch"
        />
      </div>
    </AuthLayout>
  );
}
