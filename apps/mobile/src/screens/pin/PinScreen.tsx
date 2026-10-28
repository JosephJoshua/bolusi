/**
 * PIN pad screen (design-system §8.3). Renders `model.ts`'s view of task 14's machine.
 *
 * The design reasoning lives in `model.ts`; what is visible here is the shape §8.3 asks for and one
 * decision worth stating:
 *
 * THE COUNTDOWN IS DRIVEN BY A PROP, NOT BY A TIMER IN THIS COMPONENT. `now` comes from the caller,
 * which owns the tick. That keeps the screen a pure function of (row, now) — so every lockout state
 * is reachable in a test without a real clock (T-6) — and it means the countdown and the gate read
 * the SAME `now`. A component with its own `setInterval` would eventually render "Tunggu 0 detik"
 * next to keys that are still dead, because the display clock and the decision clock would be two
 * different clocks.
 *
 * The identity block on top (avatar + name) is §8.3's "confirms WHO is entering" — on a shared
 * counter the commonest error is typing your own PIN into a colleague's account, which costs THEM an
 * attempt against a lockout they did not earn.
 */
import { t } from '@bolusi/i18n';
import {
  AppShell,
  Button,
  OutcomeState,
  Sheet,
  SyncChip,
  TextButton,
  color,
  space,
  type,
  type SyncChipState,
} from '@bolusi/ui';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { syncChipAccessibilityLabels } from '../sync-status/chip-a11y.js';

import {
  attemptsLeft,
  PIN_MESSAGE_KEY,
  pinMessage,
  pinPadState,
  pinView,
  type LastAttempt,
} from '@bolusi/device/models/pin/model';
import { PinEntry, PinPerson } from './PinEntry.js';
import type { PinAttemptRow } from '@bolusi/core';

export interface PinScreenProps {
  readonly userId: string;
  readonly userName: string;
  /** Top-privilege role keys, shown under the name. */
  readonly roleKeys?: readonly string[] | undefined;
  /**
   * This device has no PIN for them yet, and they are not the owner who enrolled it: an owner makes
   * it from "PIN karyawan" (api/02-auth §6.6). No pad, just who can help.
   */
  readonly needsFirstPin?: boolean | undefined;
  /** Task 14's persisted `pin_attempt_state` row. Null ⇒ a clean slate. */
  readonly row: PinAttemptRow | null;
  /** Injected — the caller owns the tick. See the header. */
  readonly now: number;
  readonly lastAttempt: LastAttempt;
  /**
   * Fires on the 6th digit. Gated by ONE thing: `PinPad`'s `state` — when `pinPadState(view)` is
   * `'locked'` (i.e. `delayed`), the pad disables its keys and never reaches `onComplete`, and on
   * `lockedOut` the pad is not rendered at all. This is an AFFORDANCE, not a security boundary: the
   * enforcement is 14's `assertAttemptAllowed` (`core/src/auth/lockout.ts`), which `verifyPin` calls
   * before the KDF and which throws regardless of what the UI renders.
   */
  readonly onSubmit: (pin: string) => void;
  readonly onSwitchUser: () => void;
  readonly syncChip: SyncChipState;
  /** Count of unsent `local` ops — the `pending` chip shows it and its a11y label announces it. */
  readonly pendingCount: number;
  readonly onOpenSync: () => void;
}

export function PinScreen({
  userId,
  userName,
  roleKeys,
  needsFirstPin = false,
  row,
  now,
  lastAttempt,
  onSubmit,
  onSwitchUser,
  syncChip,
  pendingCount,
  onOpenSync,
}: PinScreenProps): React.JSX.Element {
  const view = pinView(row, now, lastAttempt);
  const [forgotOpen, setForgotOpen] = useState(false);
  // A hard lock has nothing to type into: the pad gives way to who can open it (api/02-auth §6.5).
  const lockedOut = view.kind === 'lockedOut';
  // Either way there is nothing to type: the pad gives way to who can help.
  const blocked = lockedOut || needsFirstPin;

  return (
    <AppShell
      // Plain views, no List — safe to scroll when the content outgrows the viewport (task 206).
      scrollable
      title={t('auth.pin.signIn')}
      titleVariant="detail"
      onBack={onSwitchUser}
      backLabel={t('core.account.switchUser')}
      syncChip={
        <SyncChip
          state={syncChip}
          pendingCount={pendingCount}
          accessibilityLabels={syncChipAccessibilityLabels({ pendingCount })}
          onPress={onOpenSync}
        />
      }
      avatar={<View testID="pin-no-avatar" />}
      bottomAction={
        blocked ? (
          // The owner signs in on this phone and opens the PIN from Settings, so switching user is
          // the way forward, not a dead end.
          <Button
            label={t('core.account.switchUser')}
            onPress={onSwitchUser}
            testID="pin-switch-user"
          />
        ) : undefined
      }
      overlay={
        forgotOpen ? (
          <Sheet
            title={t('auth.pin.forgotTitle')}
            closeLabel={t('core.action.close')}
            onClose={() => setForgotOpen(false)}
            testID="pin-forgot-sheet"
          >
            <Text style={styles.sheetText}>{t('auth.pin.forgot')}</Text>
          </Sheet>
        ) : null
      }
      testID="pin-screen"
    >
      {blocked ? (
        <View testID={needsFirstPin ? 'pin-needs-first' : 'pin-locked-out'}>
          <View style={styles.lockedPerson}>
            <PinPerson person={{ id: userId, name: userName, roleKeys }} testID="pin-person" />
          </View>
          {needsFirstPin ? (
            <OutcomeState
              tone="neutral"
              icon="pin"
              title={t('auth.pin.noPinTitle')}
              message={t('auth.pin.noPinBody')}
            />
          ) : (
            <OutcomeState
              tone="warning"
              icon="lock"
              title={t('auth.pin.lockedOutTitle')}
              message={t(PIN_MESSAGE_KEY.lockedOut)}
            />
          )}
        </View>
      ) : (
        <PinEntry
          person={{ id: userId, name: userName, roleKeys }}
          prompt={t('auth.pin.title')}
          message={pinMessage(view)}
          state={pinPadState(view)}
          onComplete={onSubmit}
          backspaceLabel={t('core.action.delete')}
          footer={
            <TextButton
              label={t('auth.pin.forgotTitle')}
              onPress={() => setForgotOpen(true)}
              testID="pin-forgot"
            />
          }
          testID="pin"
        />
      )}
    </AppShell>
  );
}

/** Re-exported for the screen's test — the value the message renders for a wrong attempt. */
export { attemptsLeft };

const styles = StyleSheet.create({
  sheetText: { ...type.body, color: color.text, paddingBottom: space.lg },
  lockedPerson: { paddingTop: space.lg },
});
