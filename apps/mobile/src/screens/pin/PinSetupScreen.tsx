/**
 * First PIN (api/02-auth §6.6) for the owner who just set up this phone and has no PIN yet. Staff
 * never come here: an owner makes their first PIN from Settings, so a coworker holding the phone
 * cannot claim an account that has none. Core enforces this (`setFirstPin` only accepts the
 * enrolling owner, and only while the server has no PIN for them).
 *
 * Make a PIN, repeat it, and they are signed in with it. The repeat uses the same sub-flow as Change
 * PIN (`new-pin.ts`), so a mismatch starts over the same way everywhere.
 */
import { t } from '@bolusi/i18n';
import { AppShell, SyncChip, type SyncChipState } from '@bolusi/ui';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { useLatestCallback } from '../../hooks/useLatestCallback.js';
import { syncChipAccessibilityLabels } from '../sync-status/chip-a11y.js';

import {
  advanceNewPin,
  NEW_PIN_START,
  newPinFeedbackKey,
  newPinPadState,
  newPinPromptKey,
  type NewPinEntry,
} from '@bolusi/device/models/pin/new-pin';
import { PinEntry } from './PinEntry.js';

export interface PinSetupScreenProps {
  readonly userId: string;
  readonly userName: string;
  readonly roleKeys?: readonly string[] | undefined;
  /** Store the first PIN. Resolves once stored; REJECTS with the flow's DomainError. */
  readonly onSetFirstPin: (userId: string, pin: string) => Promise<void>;
  /** Sign in with the PIN just made. */
  readonly onSignIn: (pin: string) => void;
  readonly onBack: () => void;
  readonly syncChip: SyncChipState;
  readonly pendingCount: number;
  readonly onOpenSync: () => void;
}

type SetupPhase =
  | { readonly kind: 'entering'; readonly entry: NewPinEntry; readonly failed: boolean }
  | { readonly kind: 'saving'; readonly pin: string };

export function PinSetupScreen({
  userId,
  userName,
  roleKeys,
  onSetFirstPin,
  onSignIn,
  onBack,
  syncChip,
  pendingCount,
  onOpenSync,
}: PinSetupScreenProps): React.JSX.Element {
  const [phase, setPhase] = useState<SetupPhase>({
    kind: 'entering',
    entry: NEW_PIN_START,
    failed: false,
  });

  // Stable wrappers: the parent passes fresh arrows on every render, and a background re-render while
  // the PIN is being saved must not cancel the save and start a second one.
  const setFirstPin = useLatestCallback(onSetFirstPin);
  const signIn = useLatestCallback(onSignIn);
  useEffect(() => {
    if (phase.kind !== 'saving') return undefined;
    let cancelled = false;
    void setFirstPin(userId, phase.pin).then(
      () => {
        if (!cancelled) signIn(phase.pin);
      },
      () => {
        if (!cancelled) setPhase({ kind: 'entering', entry: NEW_PIN_START, failed: true });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [phase, setFirstPin, signIn, userId]);

  const entry = phase.kind === 'entering' ? phase.entry : null;
  const failed = phase.kind === 'entering' && phase.failed;
  const feedback = entry === null ? null : newPinFeedbackKey(entry);

  return (
    <AppShell
      scrollable
      title={t('auth.pin.setup.screenTitle')}
      titleVariant="detail"
      onBack={onBack}
      backLabel={t('core.account.switchUser')}
      syncChip={
        <SyncChip
          state={syncChip}
          pendingCount={pendingCount}
          accessibilityLabels={syncChipAccessibilityLabels({ pendingCount })}
          onPress={onOpenSync}
        />
      }
      avatar={<View testID="pin-setup-no-avatar" />}
      testID="pin-setup-screen"
    >
      <PinEntry
        person={{ id: userId, name: userName, roleKeys }}
        busyLabel={phase.kind === 'saving' ? t('auth.pin.saving') : undefined}
        prompt={t(entry === null ? 'auth.pin.setup.repeat' : newPinPromptKey(entry))}
        message={failed ? t('auth.pin.setup.failed') : feedback === null ? undefined : t(feedback)}
        state={entry === null ? 'locked' : failed ? 'error' : newPinPadState(entry)}
        onComplete={(pin) => {
          if (phase.kind !== 'entering') return;
          const next = advanceNewPin(phase.entry, pin);
          setPhase(
            next.kind === 'matched'
              ? { kind: 'saving', pin: next.pin }
              : { kind: 'entering', entry: next, failed: false },
          );
        }}
        padKey={entry === null ? 'saving' : `${entry.kind}-${newPinPadState(entry)}`}
        backspaceLabel={t('core.action.delete')}
        testID="pin-setup"
      />
    </AppShell>
  );
}
