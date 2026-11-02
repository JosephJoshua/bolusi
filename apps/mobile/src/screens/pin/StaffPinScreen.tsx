/**
 * "PIN karyawan" — the owner's one place for a colleague's PIN (api/02-auth §6.5.1, §6.6). Pick the
 * person, see whether their PIN is locked, then unlock it or have them make a new one.
 *
 * It replaces two separate owner screens (unlock, reset) that each opened on a bare list: the owner
 * thinks "Budi can't sign in", not "which of two PIN tools do I need", so the person comes first
 * and the page offers what fits (`staffPinActions`).
 *
 * THE OWNER NEVER TYPES THE NEW PIN. A reset first asks the owner to hand the phone over; the
 * colleague types their own PIN, so the owner never learns it (§6.6). Core enforces both
 * permissions, the locked precondition and the privileged-target rule; this screen only offers.
 */
import { t } from '@bolusi/i18n';
import {
  AppShell,
  Button,
  Chip,
  ConfirmSheet,
  List,
  OutcomeState,
  SearchField,
  TextButton,
  color,
  space,
  type,
  Text,
} from '@bolusi/ui';
import { useEffect, useMemo, useReducer, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useLatestCallback } from '../../hooks/useLatestCallback.js';
import type { SurfaceNav } from '../../navigation/surface.js';
import { filterUsers, SWITCHER_SEARCH_MIN } from '@bolusi/device/models/switcher/model';
import { UserRow } from '../switcher/UserRow.js';

import {
  CLEAR_IDLE,
  clearActionReducer,
  clearLockoutOutcome,
} from '@bolusi/device/models/pin/clear-lockout.model';
import { ownerListToListState } from './owner-list-view.js';
import type { PinTargetUser } from '@bolusi/device/models/pin/pin-target';
import { PinPerson } from './PinEntry.js';
import {
  RESET_LIST,
  resetOutcome,
  resetPinReducer,
} from '@bolusi/device/models/pin/reset-pin.model';
import { StaffPinNewPin } from './StaffPinNewPin.js';
import {
  staffListState,
  staffPinActions,
  staffPinBodyKey,
} from '@bolusi/device/models/pin/staff-pin.model';

export interface StaffPinScreenProps {
  /** Does the acting user hold `auth.pin_unlock`? */
  readonly canUnlock: boolean;
  /** Does the acting user hold `auth.user_reset_pin`? */
  readonly canReset: boolean;
  readonly loading: boolean;
  /** A DomainError code if the directory read failed, else null. */
  readonly error: string | null;
  /** The device directory, each with a caller-derived `lockedOut` flag. */
  readonly users: readonly PinTargetUser[];
  /** The acting owner, left out of the list. */
  readonly actorUserId: string;
  /** Run `auth.clearPinLockout`. Resolves on success; REJECTS with the flow's DomainError. */
  readonly onClearLockout: (targetUserId: string) => Promise<void>;
  /** Run `auth.resetPin` with the PIN the colleague typed. Resolves ok; REJECTS DomainError. */
  readonly onResetPin: (targetUserId: string, newPin: string) => Promise<void>;
  /** Re-read the directory (after an error, and after a change so the marks are current). */
  readonly onReload: () => void;
  readonly onClose: () => void;
  /**
   * Open straight at this person's hand-over for a new PIN, as "Karyawan" does right after adding
   * someone. Leaving that hand-over, or finishing it, then closes the screen (back to whoever opened
   * it) instead of showing the list.
   */
  readonly startWith?: string | null | undefined;
  /** Publishes this screen's own back, so Android's back button steps back inside the flow. */
  readonly onRegisterSurfaceNav?: ((nav: SurfaceNav | null) => void) | undefined;
}

export function StaffPinScreen({
  canUnlock,
  canReset,
  loading,
  error,
  users,
  actorUserId,
  onClearLockout,
  onResetPin,
  onReload,
  onClose,
  startWith = null,
  onRegisterSurfaceNav,
}: StaffPinScreenProps): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [unlock, dispatchUnlock] = useReducer(clearActionReducer, CLEAR_IDLE);
  const [reset, dispatchReset] = useReducer(resetPinReducer, RESET_LIST);
  // Stable wrappers so a parent re-render mid-save never cancels and reruns a submit.
  const clearLockout = useLatestCallback(onClearLockout);
  const resetPin = useLatestCallback(onResetPin);

  // Opened for one person: go to their hand-over as soon as the list has them, once.
  const [started, setStarted] = useState(false);
  useEffect(() => {
    if (startWith === null || started || loading) return;
    setStarted(true);
    const target = users.find((user) => user.id === startWith);
    if (target === undefined || !canReset) return;
    setSelectedId(target.id);
    dispatchReset({ kind: 'pick', target });
  }, [startWith, started, loading, users, canReset]);

  useEffect(() => {
    if (unlock.kind !== 'submitting') return undefined;
    let cancelled = false;
    void clearLockout(unlock.target.id).then(
      () => {
        if (!cancelled) dispatchUnlock({ kind: 'settled', result: { ok: true } });
      },
      (settleError: unknown) => {
        if (!cancelled)
          dispatchUnlock({ kind: 'settled', result: clearLockoutOutcome(settleError) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [unlock, clearLockout]);

  useEffect(() => {
    if (reset.kind !== 'submitting') return undefined;
    let cancelled = false;
    void resetPin(reset.target.id, reset.newPin).then(
      () => {
        if (!cancelled) dispatchReset({ kind: 'settled', result: { ok: true } });
      },
      (settleError: unknown) => {
        if (!cancelled) dispatchReset({ kind: 'settled', result: resetOutcome(settleError) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [reset, resetPin]);

  const list = useMemo(
    () => staffListState({ canUnlock, canReset, loading, error, users, actorUserId }),
    [canUnlock, canReset, loading, error, users, actorUserId],
  );
  const searchable = list.kind === 'ready' && list.targets.length >= SWITCHER_SEARCH_MIN;
  const shown = useMemo(
    () =>
      list.kind === 'ready' && searchable
        ? { kind: 'ready' as const, targets: filterUsers(list.targets, query) }
        : list,
    [list, searchable, query],
  );
  const selected = users.find((user) => user.id === selectedId) ?? null;

  /** Back to the list after a change, with the marks re-read. */
  const finish = (): void => {
    if (startWith !== null) {
      onClose();
      return;
    }
    dispatchUnlock({ kind: 'dismiss' });
    dispatchReset({ kind: 'dismiss' });
    setSelectedId(null);
    onReload();
  };

  /** One step back, wherever the owner is; the header arrow and Android's back both run it. */
  const back = (): void => {
    if (reset.kind === 'submitting' || unlock.kind === 'submitting') return;
    if (startWith !== null && (reset.kind === 'handOver' || reset.kind === 'entering')) onClose();
    else if (reset.kind === 'handOver' || reset.kind === 'entering')
      dispatchReset({ kind: 'cancel' });
    else if (reset.kind !== 'list' || unlock.kind === 'done' || unlock.kind === 'failed') finish();
    else if (unlock.kind === 'confirming') dispatchUnlock({ kind: 'cancel' });
    else if (selectedId !== null) setSelectedId(null);
    else onClose();
  };
  const latestBack = useLatestCallback(back);
  useEffect(() => {
    if (onRegisterSurfaceNav === undefined) return undefined;
    onRegisterSurfaceNav({
      handleBack: () => {
        latestBack();
        return true;
      },
      requestLeave: (proceed) => proceed(),
    });
    return () => onRegisterSurfaceNav(null);
  }, [onRegisterSurfaceNav, latestBack]);

  // ── A reset in progress: hand over, type, outcome ──────────────────────────────────────────
  if (reset.kind !== 'list') {
    const target = reset.target;
    if (reset.kind === 'handOver') {
      return (
        <Shell
          title={t('auth.pin.staff.resetTitle')}
          onBack={back}
          bottomAction={
            <Button
              label={t('auth.pin.staff.handedOver', { name: target.name })}
              onPress={() => dispatchReset({ kind: 'proceed' })}
              testID="staff-pin-proceed"
            />
          }
        >
          <OutcomeState
            tone="neutral"
            icon="phoneDevice"
            title={t('auth.pin.staff.handOverTitle', { name: target.name })}
            message={t('auth.pin.staff.handOverBody', { name: target.name })}
            testID="staff-pin-handover"
          />
        </Shell>
      );
    }
    if (reset.kind === 'entering' || reset.kind === 'submitting') {
      return (
        <StaffPinNewPin
          target={target}
          entry={reset.kind === 'entering' ? reset.entry : null}
          onComplete={(pin) => dispatchReset({ kind: 'enteredPin', pin })}
          onBack={back}
        />
      );
    }
    const done = reset.kind === 'done';
    return (
      <Shell
        title={t('auth.pin.staff.resetTitle')}
        onBack={back}
        bottomAction={
          <Button
            label={t(done ? 'auth.pin.staff.finish' : 'core.action.back')}
            onPress={finish}
            testID="staff-pin-reset-finish"
          />
        }
      >
        {done ? (
          <OutcomeState
            tone="success"
            icon="success"
            title={t('auth.pin.reset.done')}
            message={t('auth.pin.staff.resetDoneBody', { name: target.name })}
            testID="staff-pin-reset-done"
          />
        ) : (
          <OutcomeState
            tone="warning"
            icon="warning"
            title={t('auth.pin.staff.failedTitle')}
            message={
              reset.reason === 'denied' ? t('auth.pin.reset.denied') : t('core.errors.UNEXPECTED')
            }
            testID="staff-pin-reset-failed"
          />
        )}
      </Shell>
    );
  }

  // ── An unlock that finished ─────────────────────────────────────────────────────────────────
  if (unlock.kind === 'done' || unlock.kind === 'failed') {
    const done = unlock.kind === 'done';
    return (
      <Shell
        title={t('auth.pin.staff.title')}
        onBack={back}
        bottomAction={
          <Button
            label={t(done ? 'auth.pin.staff.finish' : 'core.action.back')}
            onPress={finish}
            testID="staff-pin-unlock-finish"
          />
        }
      >
        {done ? (
          <OutcomeState
            tone="success"
            icon="success"
            title={t('auth.pin.unlock.done')}
            message={t('auth.pin.staff.unlockDoneBody', { name: unlock.target.name })}
            testID="staff-pin-unlock-done"
          />
        ) : (
          <OutcomeState
            tone="neutral"
            icon="info"
            title={
              unlock.reason === 'notLocked'
                ? t('auth.pin.unlock.notLocked', { name: unlock.target.name })
                : t('auth.pin.staff.failedTitle')
            }
            message={unlock.reason === 'notLocked' ? undefined : t('core.errors.UNEXPECTED')}
            testID="staff-pin-unlock-failed"
          />
        )}
      </Shell>
    );
  }

  // ── One person's page ───────────────────────────────────────────────────────────────────────
  if (selected !== null) {
    const actions = staffPinActions(selected, { canUnlock, canReset });
    const [primary, secondary] = actions;
    const body = staffPinBodyKey(selected, actions);
    const run = (action: 'unlock' | 'reset'): void => {
      if (action === 'unlock') dispatchUnlock({ kind: 'pick', target: selected });
      else dispatchReset({ kind: 'pick', target: selected });
    };
    return (
      <Shell
        title={t('auth.pin.staff.title')}
        onBack={back}
        bottomAction={
          primary === undefined ? undefined : (
            <Button
              label={t(ACTION_LABEL[primary])}
              onPress={() => run(primary)}
              busy={unlock.kind === 'submitting'}
              testID={`staff-pin-${primary}`}
            />
          )
        }
        overlay={
          unlock.kind === 'confirming' ? (
            <ConfirmSheet
              title={t('auth.pin.staff.unlockConfirmTitle', { name: selected.name })}
              message={t('auth.pin.unlock.confirm')}
              confirmLabel={t('auth.pin.staff.unlock')}
              onConfirm={() => dispatchUnlock({ kind: 'confirm' })}
              cancelLabel={t('core.action.cancel')}
              onCancel={() => dispatchUnlock({ kind: 'cancel' })}
              testID="staff-pin-unlock-confirm"
            />
          ) : null
        }
      >
        <View style={styles.person} testID="staff-pin-person">
          <PinPerson person={selected} testID="staff-pin-person-who" />
          {selected.lockedOut ? (
            // Chips hug the start edge; this page is centred.
            <View style={styles.centred}>
              <Chip
                label={t('auth.switcher.locked')}
                icon="lock"
                tone="warning"
                testID="staff-pin-person-locked"
              />
            </View>
          ) : selected.needsFirstPin === true ? (
            <View style={styles.centred}>
              <Chip label={t('auth.switcher.noPin')} icon="pin" testID="staff-pin-person-nopin" />
            </View>
          ) : null}
          {body === null ? null : <Text style={styles.status}>{t(body)}</Text>}
          {secondary === undefined ? null : (
            <View style={styles.secondary}>
              <TextButton
                label={t(ACTION_LABEL[secondary])}
                onPress={() => run(secondary)}
                // One change at a time: an unlock in flight must finish before a reset can start.
                disabled={unlock.kind === 'submitting'}
                testID={`staff-pin-${secondary}`}
              />
            </View>
          )}
        </View>
      </Shell>
    );
  }

  // ── The list ────────────────────────────────────────────────────────────────────────────────
  // Opened for one person: the list waits rather than flashing before their hand-over opens.
  const opening = startWith !== null && !started;
  const listState = ownerListToListState(opening ? { kind: 'loading' } : shown, {
    emptyTitle:
      list.kind === 'ready' && list.targets.length > 0
        ? t('auth.switcher.noMatches')
        : t('auth.pin.reset.noUsers'),
    onBack: onClose,
    onReload,
  });
  return (
    <Shell title={t('auth.pin.staff.title')} onBack={back}>
      {searchable ? (
        <View style={styles.search}>
          <SearchField
            placeholder={t('auth.switcher.search')}
            accessibilityLabel={t('core.action.search')}
            clearLabel={t('core.action.clearSearch')}
            value={query}
            onChangeText={setQuery}
            testID="staff-pin-search"
          />
        </View>
      ) : null}
      <View style={styles.list}>
        <List
          state={listState}
          keyExtractor={(user) => user.id}
          renderRow={(user) => (
            <UserRow
              id={user.id}
              name={user.name}
              roleKeys={user.roleKeys}
              status={
                user.lockedOut ? (
                  <Chip
                    label={t('auth.switcher.locked')}
                    icon="lock"
                    tone="warning"
                    testID={`staff-pin-locked-${user.id}`}
                  />
                ) : user.needsFirstPin === true ? (
                  <Chip
                    label={t('auth.switcher.noPin')}
                    icon="pin"
                    testID={`staff-pin-nopin-${user.id}`}
                  />
                ) : undefined
              }
              onPress={() => setSelectedId(user.id)}
              testID={`staff-pin-target-${user.id}`}
            />
          )}
          testID="staff-pin-list"
        />
      </View>
    </Shell>
  );
}

const ACTION_LABEL = {
  unlock: 'auth.pin.staff.unlock',
  reset: 'auth.pin.staff.reset',
} as const;

/** The frame every step shares: a back arrow, no sync chip or avatar (a focused owner task). Never a
 *  scrolling AppShell: the list step is a `<List>`; the one step that scrolls is `StaffPinNewPin`. */
function Shell({
  title,
  onBack,
  bottomAction,
  overlay,
  children,
}: {
  readonly title: string;
  readonly onBack: () => void;
  readonly bottomAction?: React.ReactNode;
  readonly overlay?: React.ReactNode;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <AppShell
      title={title}
      titleVariant="detail"
      onBack={onBack}
      backLabel={t('core.action.back')}
      syncChip={null}
      avatar={<View testID="staff-pin-no-avatar" />}
      bottomAction={bottomAction}
      overlay={overlay}
      testID="staff-pin-screen"
    >
      {children}
    </AppShell>
  );
}

const styles = StyleSheet.create({
  search: { marginBottom: space.sm },
  list: { flex: 1, marginHorizontal: -space.lg },
  person: { alignItems: 'center', paddingTop: space['2xl'], gap: space.md },
  status: { ...type.body, color: color.textMuted, textAlign: 'center' },
  secondary: { marginTop: space.sm },
  centred: { alignItems: 'center' },
});
