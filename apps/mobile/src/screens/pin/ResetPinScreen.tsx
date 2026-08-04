/**
 * Owner PIN-reset screen (api/02-auth §6.6; design-system §5/§8.3). Renders `reset-pin.model.ts`: the
 * model gates the list on the permission, drives the pick → hand-over → enter → submit machine, and
 * maps the flow's outcome; core's `resetPin` enforces the permission, the directory restriction, and
 * the privileged-target rule. This component wires the `<List>` §5 states, the PIN pad, and the
 * injected flow.
 *
 * THE OWNER NEVER TYPES THE PIN. Between choosing a target and the pad, the screen shows a hand-over
 * step (`auth.pin.reset.handOver`) telling the owner to give the device to the target, who types their
 * own new PIN — the §6.6 property that the owner never learns it. The pad is remounted per sub-step so
 * no digits bleed between the new-PIN and repeat entries.
 */
import { t } from '@bolusi/i18n';
import { AppShell, Button, List, PinPad, color, space, type } from '@bolusi/ui';
import { useEffect, useReducer } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { newPinMessageKey } from './new-pin.js';
import { ownerListToListState } from './owner-list-view.js';
import type { PinTargetUser } from './pin-target.js';
import { PinResultPanel } from './PinResultPanel.js';
import { PinTargetRow } from './PinTargetRow.js';
import { RESET_LIST, resetListState, resetOutcome, resetPinReducer } from './reset-pin.model.js';

export interface ResetPinScreenProps {
  /** Does the acting user hold `auth.user_reset_pin`? Drives the Unauthorized state. */
  readonly canReset: boolean;
  readonly loading: boolean;
  /** A DomainError code if the directory read failed, else null. */
  readonly error: string | null;
  /** The device directory (each user's `lockedOut` flag is unused here but shared with unlock). */
  readonly users: readonly PinTargetUser[];
  /** The acting owner, excluded from the target list. */
  readonly actorUserId: string;
  /** Run `auth.resetPin` for the target with the target-typed PIN. Resolves ok; REJECTS DomainError. */
  readonly onResetPin: (targetUserId: string, newPin: string) => Promise<void>;
  /** Re-read the directory after an error. Falls back to closing when not supplied. */
  readonly onReload?: (() => void) | undefined;
  readonly onClose: () => void;
}

export function ResetPinScreen({
  canReset,
  loading,
  error,
  users,
  actorUserId,
  onResetPin,
  onReload,
  onClose,
}: ResetPinScreenProps): React.JSX.Element {
  const [phase, dispatch] = useReducer(resetPinReducer, RESET_LIST);
  const list = resetListState({ canReset, loading, error, users, actorUserId });

  useEffect(() => {
    if (phase.kind !== 'submitting') return;
    let cancelled = false;
    void onResetPin(phase.target.id, phase.newPin).then(
      () => {
        if (!cancelled) dispatch({ kind: 'settled', result: { ok: true } });
      },
      (settleError: unknown) => {
        if (!cancelled) dispatch({ kind: 'settled', result: resetOutcome(settleError) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [phase, onResetPin]);

  return (
    <AppShell
      title={t('auth.pin.reset.title')}
      titleVariant="detail"
      onBack={onClose}
      backLabel={t('core.action.back')}
      syncChip={null}
      avatar={<View testID="reset-pin-no-avatar" />}
      testID="reset-pin-screen"
    >
      {phase.kind === 'list' ? (
        <List
          state={ownerListToListState(list, {
            emptyTitle: t('auth.pin.reset.noUsers'),
            onBack: onClose,
            onReload: onReload ?? onClose,
          })}
          renderRow={(user) => (
            <PinTargetRow
              user={user}
              onPress={() => dispatch({ kind: 'pick', target: user })}
              testID={`reset-pin-target-${user.id}`}
            />
          )}
          keyExtractor={(user) => user.id}
          testID="reset-pin-list"
        />
      ) : phase.kind === 'handOver' ? (
        <View style={styles.handOver} testID="reset-pin-handover">
          <Text style={styles.handOverText}>
            {t('auth.pin.reset.handOver', { name: phase.target.name })}
          </Text>
          <Button
            label={t('core.action.confirm')}
            variant="primary"
            onPress={() => dispatch({ kind: 'proceed' })}
            testID="reset-pin-proceed"
          />
          <Button
            label={t('core.action.cancel')}
            variant="secondary"
            onPress={() => dispatch({ kind: 'cancel' })}
            testID="reset-pin-handover-cancel"
          />
        </View>
      ) : phase.kind === 'entering' ? (
        <PinPad
          key={`entering-${phase.entry.kind}`}
          onComplete={(pin) => dispatch({ kind: 'enteredPin', pin })}
          state={phase.entry.kind === 'first' && phase.entry.afterMismatch ? 'error' : 'entry'}
          message={messageForEntry(phase.entry)}
          entryLabel={t('auth.pin.reset.title')}
          backspaceLabel={t('core.action.delete')}
          testID="reset-pin-pad"
        />
      ) : phase.kind === 'submitting' ? (
        // The reset runs locally and offline (§6.6) — near-instant — so this is a single frame: the
        // just-completed pad, frozen, before the outcome panel. No spinner for a local write (§4).
        <PinPad
          key="reset-submitting"
          onComplete={() => undefined}
          state="locked"
          entryLabel={t('auth.pin.reset.title')}
          backspaceLabel={t('core.action.delete')}
          testID="reset-pin-pad-submitting"
        />
      ) : phase.kind === 'done' ? (
        <PinResultPanel
          tone="success"
          chipLabel={t('core.action.ok')}
          message={t('auth.pin.reset.done', { name: phase.target.name })}
          actionLabel={t('core.action.ok')}
          onAction={onClose}
          testID="reset-pin-done"
        />
      ) : (
        <PinResultPanel
          tone="neutral"
          message={
            phase.reason === 'denied' ? t('auth.pin.reset.denied') : t('core.errors.UNEXPECTED')
          }
          actionLabel={t('core.action.back')}
          onAction={() => dispatch({ kind: 'dismiss' })}
          testID="reset-pin-failed"
        />
      )}
    </AppShell>
  );
}

/** The already-localized pad message while the target enters their new PIN. */
function messageForEntry(entry: Parameters<typeof newPinMessageKey>[0]): string | undefined {
  const key = newPinMessageKey(entry);
  return key === null ? undefined : t(key);
}

const styles = StyleSheet.create({
  handOver: {
    alignItems: 'center',
    gap: space.lg,
    marginTop: space.xl,
  },
  handOverText: {
    ...type.body,
    color: color.text,
    textAlign: 'center',
  },
});
