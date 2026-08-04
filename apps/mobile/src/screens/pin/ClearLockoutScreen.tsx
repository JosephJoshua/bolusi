/**
 * Owner "unlock a PIN" screen (api/02-auth §6.5.1; design-system §5/§8.3). Renders
 * `clear-lockout.model.ts`: the model decides the list state (and gates on the permission) and maps
 * the flow's outcome; core's `clearPinLockoutFlow` enforces the permission, the locked precondition,
 * and the counter reset. This component maps the simple model states to `<List>`'s §5 states, runs the
 * injected flow, and requires an explicit confirm before it fires.
 *
 * The list offers ONLY locked users (the model filters), and an empty list is the reassuring "no one
 * is locked out" case — not an error, not a denial. A caller WITHOUT `auth.pin_unlock` gets the
 * Unauthorized state instead, so a non-owner never even learns who is locked.
 */
import { t } from '@bolusi/i18n';
import { AppShell, ConfirmSheet, List } from '@bolusi/ui';
import { useEffect, useReducer } from 'react';
import { View } from 'react-native';

import {
  CLEAR_IDLE,
  clearActionReducer,
  clearListState,
  clearLockoutOutcome,
} from './clear-lockout.model.js';
import { ownerListToListState } from './owner-list-view.js';
import type { PinTargetUser } from './pin-target.js';
import { PinResultPanel } from './PinResultPanel.js';
import { PinTargetRow } from './PinTargetRow.js';

export interface ClearLockoutScreenProps {
  /** Does the acting user hold `auth.pin_unlock`? Drives the Unauthorized state. */
  readonly canUnlock: boolean;
  readonly loading: boolean;
  /** A DomainError code if the directory read failed, else null. */
  readonly error: string | null;
  /** The device directory with each user's caller-derived `lockedOut` flag. */
  readonly users: readonly PinTargetUser[];
  /** Run `auth.clearPinLockout` for the target. Resolves on success; REJECTS with a DomainError. */
  readonly onClearLockout: (targetUserId: string) => Promise<void>;
  /** Re-read the directory after an error. Falls back to closing when not supplied. */
  readonly onReload?: (() => void) | undefined;
  readonly onClose: () => void;
}

export function ClearLockoutScreen({
  canUnlock,
  loading,
  error,
  users,
  onClearLockout,
  onReload,
  onClose,
}: ClearLockoutScreenProps): React.JSX.Element {
  const [action, dispatch] = useReducer(clearActionReducer, CLEAR_IDLE);
  const list = clearListState({ canUnlock, loading, error, users });

  useEffect(() => {
    if (action.kind !== 'submitting') return;
    let cancelled = false;
    void onClearLockout(action.target.id).then(
      () => {
        if (!cancelled) dispatch({ kind: 'settled', result: { ok: true } });
      },
      (settleError: unknown) => {
        if (!cancelled) dispatch({ kind: 'settled', result: clearLockoutOutcome(settleError) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [action, onClearLockout]);

  return (
    <AppShell
      title={t('auth.pin.unlock.title')}
      titleVariant="detail"
      onBack={onClose}
      backLabel={t('core.action.back')}
      syncChip={null}
      avatar={<View testID="clear-lockout-no-avatar" />}
      testID="clear-lockout-screen"
    >
      {action.kind === 'done' ? (
        <PinResultPanel
          tone="success"
          chipLabel={t('core.action.ok')}
          message={t('auth.pin.unlock.done', { name: action.target.name })}
          actionLabel={t('core.action.ok')}
          onAction={onClose}
          testID="clear-lockout-done"
        />
      ) : action.kind === 'failed' ? (
        <PinResultPanel
          tone="neutral"
          message={
            action.reason === 'notLocked'
              ? t('auth.pin.unlock.notLocked', { name: action.target.name })
              : t('core.errors.UNEXPECTED')
          }
          actionLabel={t('core.action.back')}
          onAction={() => dispatch({ kind: 'dismiss' })}
          testID="clear-lockout-failed"
        />
      ) : (
        <List
          state={ownerListToListState(list, {
            emptyTitle: t('auth.pin.unlock.noneLocked'),
            onBack: onClose,
            onReload: onReload ?? onClose,
          })}
          renderRow={(user) => (
            <PinTargetRow
              user={user}
              onPress={() => dispatch({ kind: 'pick', target: user })}
              testID={`clear-lockout-target-${user.id}`}
            />
          )}
          keyExtractor={(user) => user.id}
          testID="clear-lockout-list"
        />
      )}

      {action.kind === 'confirming' ? (
        <ConfirmSheet
          title={t('auth.pin.unlock.title')}
          message={t('auth.pin.unlock.confirm', { name: action.target.name })}
          confirmLabel={t('core.action.confirm')}
          onConfirm={() => dispatch({ kind: 'confirm' })}
          cancelLabel={t('core.action.cancel')}
          onCancel={() => dispatch({ kind: 'cancel' })}
          testID="clear-lockout-confirm"
        />
      ) : null}
    </AppShell>
  );
}
