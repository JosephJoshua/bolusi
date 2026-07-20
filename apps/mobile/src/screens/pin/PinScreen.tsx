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
import { formatDuration, t } from '@bolusi/i18n';
import {
  AppShell,
  Avatar,
  Button,
  PinPad,
  SyncChip,
  color,
  space,
  type,
  type SyncChipState,
} from '@bolusi/ui';
import { StyleSheet, Text, View } from 'react-native';

import { initialsOf } from '../switcher/model.js';

import {
  attemptsLeft,
  PIN_MESSAGE_KEY,
  pinPadState,
  pinView,
  showsForgotAffordance,
  type LastAttempt,
  type PinView,
} from './model.js';
import type { PinAttemptRow } from '@bolusi/core';

export interface PinScreenProps {
  readonly userId: string;
  readonly userName: string;
  /** Task 14's persisted `pin_attempt_state` row. Null ⇒ a clean slate. */
  readonly row: PinAttemptRow | null;
  /** Injected — the caller owns the tick. See the header. */
  readonly now: number;
  readonly lastAttempt: LastAttempt;
  /**
   * Fires on the 6th digit. Gated by ONE thing: `PinPad`'s `state` — when `pinPadState(view)` is
   * `'locked'` (i.e. `delayed` or `lockedOut`), the pad disables its keys and never reaches
   * `onComplete`. Nothing in this screen re-checks it; the gate is the prop passed at the `<PinPad>`
   * below. This is an AFFORDANCE, not a security boundary: the enforcement is 14's
   * `assertAttemptAllowed` (`core/src/auth/lockout.ts`), which `verifyPin` calls before the KDF and
   * which throws regardless of what the UI renders. Both run on-device — PIN auth is offline
   * (api/02-auth §6.5), so there is no server in this path.
   */
  readonly onSubmit: (pin: string) => void;
  readonly onSwitchUser: () => void;
  readonly syncChip: SyncChipState;
  readonly onOpenSync: () => void;
}

export function PinScreen({
  userId,
  userName,
  row,
  now,
  lastAttempt,
  onSubmit,
  onSwitchUser,
  syncChip,
  onOpenSync,
}: PinScreenProps): React.JSX.Element {
  const view = pinView(row, now, lastAttempt);

  return (
    <AppShell
      title={t('auth.pin.title')}
      titleVariant="detail"
      onBack={onSwitchUser}
      backLabel={t('core.action.back')}
      syncChip={
        <SyncChip
          state={syncChip}
          accessibilityLabel={t('sync.status.lastSynced', { relative: '' })}
          onPress={onOpenSync}
        />
      }
      avatar={<View testID="pin-no-avatar" />}
      testID="pin-screen"
    >
      <View style={styles.identity} testID="pin-identity">
        <Avatar userId={userId} initials={initialsOf(userName)} size="header" />
        <Text style={styles.name} numberOfLines={1} testID="pin-user-name">
          {userName}
        </Text>
      </View>

      <PinPad
        onComplete={onSubmit}
        state={pinPadState(view)}
        message={messageFor(view)}
        entryLabel={t('auth.pin.title')}
        backspaceLabel={t('core.action.delete')}
        testID="pin-pad"
      />

      {showsForgotAffordance(view) ? (
        // §8.3 / api/02-auth §6.5: the ONLY recovery is the store owner, and it works offline.
        // Rendered as text rather than a button because there is nothing for the app to do — the
        // action is a conversation, and a button that did nothing would be worse than a sentence.
        <Text style={styles.forgot} testID="pin-forgot">
          {t('auth.pin.forgot')}
        </Text>
      ) : null}

      <Button
        label={t('auth.switcher.title')}
        variant="secondary"
        onPress={onSwitchUser}
        testID="pin-switch-user"
      />
    </AppShell>
  );
}

/**
 * The already-localized message for the pad's message slot. `PinPad` never formats time (its own
 * contract), so the countdown is formatted here — through `@bolusi/i18n`'s `formatDuration`, which
 * is the single formatting authority (07-i18n §5).
 *
 * THE MESSAGE KEY IS READ FROM `PIN_MESSAGE_KEY` (model.ts), NOT RESTATED HERE. There is ONE
 * view→key mapping (§2.8); this function only supplies each arm's PARAMS, which genuinely differ.
 * That is what makes `model.test.ts`'s `PIN_MESSAGE_KEY` assertions load-bearing rather than a decoy
 * (task 65): break the map's `delayed`/`lockedOut` slot and both this screen AND those tests change.
 * Two arms are not a plain lookup and stay explicit: `wrong` appends a SECOND key
 * (`auth.pin.attemptsLeft`) the one-slot-per-state map has no room for, and `entry`'s `null` slot
 * renders no message at all.
 */
function messageFor(view: PinView): string | undefined {
  switch (view.kind) {
    case 'entry':
      return undefined;
    case 'wrong':
      // Two sentences, deliberately: what happened, then what it costs. `attemptsLeft` is what turns
      // "wrong PIN" from a nag into information — it is the only warning a user gets before a lock
      // that only the owner can undo.
      return `${t(PIN_MESSAGE_KEY[view.kind])} ${t('auth.pin.attemptsLeft', { count: view.attemptsLeft })}`;
    case 'delayed':
      return t(PIN_MESSAGE_KEY[view.kind], { duration: formatDuration(view.remainingMs) });
    case 'lockedOut':
      return t(PIN_MESSAGE_KEY[view.kind]);
  }
}

/** Re-exported for the screen's test — the value the message renders for a wrong attempt. */
export { attemptsLeft };

const styles = StyleSheet.create({
  identity: {
    alignItems: 'center',
    gap: space.sm,
    marginBottom: space.xl,
  },
  name: {
    ...type.heading,
    color: color.text,
  },
  forgot: {
    ...type.bodySm,
    color: color.textMuted,
    marginTop: space.lg,
    textAlign: 'center',
  },
});
