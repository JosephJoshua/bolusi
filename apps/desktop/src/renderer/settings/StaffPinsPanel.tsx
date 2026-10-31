// "PIN karyawan": the owner's one place for a colleague's PIN on this PC. Locked PINs come first
// (that is usually why the owner is here); each row offers what fits, unlocking or a new PIN. The
// phone's PIN models decide the list, the actions and the outcomes; the core flows enforce them.
//
// THE OWNER NEVER TYPES THE NEW PIN. A new PIN first asks the owner to let the colleague at the
// keyboard, and the colleague types it twice (api/02-auth §6.6).
import { t, translateRoleKey } from '@bolusi/i18n';
import {
  CLEAR_IDLE,
  clearActionReducer,
  clearLockoutOutcome,
} from '@bolusi/device/models/pin/clear-lockout.model';
import {
  newPinFeedbackKey,
  newPinPadState,
  newPinPromptKey,
  newPinPadKey,
} from '@bolusi/device/models/pin/new-pin';
import type { PinTargetUser } from '@bolusi/device/models/pin/pin-target';
import {
  RESET_LIST,
  resetOutcome,
  resetPinReducer,
  type ResetPhase,
} from '@bolusi/device/models/pin/reset-pin.model';
import { staffListState, staffPinActions } from '@bolusi/device/models/pin/staff-pin.model';
import { filterUsers, SWITCHER_SEARCH_MIN } from '@bolusi/device/models/switcher/model';
import {
  Avatar,
  Banner,
  Button,
  Chip,
  ConfirmDialog,
  Dialog,
  SearchField,
  SettingsPanel,
  Skeleton,
  StatePanel,
} from '@bolusi/ui-web';
import { CircleAlert, CircleCheck, KeyRound, Lock, UserRound, Users } from 'lucide-react';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';

import type { StaffPinAccess } from './access.js';
import { PinSteps } from './AccountPanel.js';

type Loaded =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly code: string }
  | { readonly kind: 'ready'; readonly users: readonly PinTargetUser[] };

export function roleText(roleKeys: readonly string[] | undefined): string {
  return (roleKeys ?? [])
    .map((key) => translateRoleKey(key))
    .filter((name) => name !== null)
    .join(', ');
}

export function StaffPinsPanel({
  access,
  actorUserId,
}: {
  readonly access: StaffPinAccess;
  readonly actorUserId: string;
}): React.JSX.Element {
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState<{
    tone: 'success' | 'info' | 'danger';
    text: string;
  } | null>(null);
  const [unlock, dispatchUnlock] = useReducer(clearActionReducer, CLEAR_IDLE);
  const [resetFor, setResetFor] = useState<PinTargetUser | null>(null);
  const latest = useRef(access);
  latest.current = access;

  const reload = useCallback(async (): Promise<void> => {
    try {
      setLoaded({ kind: 'ready', users: await latest.current.list() });
    } catch (error) {
      const code =
        typeof (error as { code?: unknown } | null)?.code === 'string'
          ? (error as { code: string }).code
          : 'UNEXPECTED';
      setLoaded({ kind: 'error', code });
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (unlock.kind !== 'submitting') return undefined;
    let cancelled = false;
    void latest.current.clearLockout(unlock.target.id).then(
      () => {
        if (!cancelled) dispatchUnlock({ kind: 'settled', result: { ok: true } });
      },
      (error: unknown) => {
        if (!cancelled) dispatchUnlock({ kind: 'settled', result: clearLockoutOutcome(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [unlock]);

  // An unlock that finished says so above the list, which is read again for the new marks.
  useEffect(() => {
    if (unlock.kind !== 'done' && unlock.kind !== 'failed') return;
    const name = unlock.target.name;
    setNotice(
      unlock.kind === 'done'
        ? { tone: 'success', text: t('auth.pin.staff.unlockDoneBody', { name }) }
        : unlock.reason === 'notLocked'
          ? { tone: 'info', text: t('auth.pin.unlock.notLocked', { name }) }
          : { tone: 'danger', text: t('core.errors.UNEXPECTED') },
    );
    dispatchUnlock({ kind: 'dismiss' });
    void reload();
  }, [unlock, reload]);

  const { canUnlock, canReset } = access;
  const users = loaded.kind === 'ready' ? loaded.users : [];
  const list = staffListState({
    canUnlock,
    canReset,
    loading: loaded.kind === 'loading',
    error: loaded.kind === 'error' ? loaded.code : null,
    users,
    actorUserId,
  });
  const searchable = list.kind === 'ready' && list.targets.length >= SWITCHER_SEARCH_MIN;
  const shown = useMemo(
    () =>
      list.kind !== 'ready' ? [] : searchable ? filterUsers(list.targets, query) : list.targets,
    [list, searchable, query],
  );

  return (
    <SettingsPanel
      title={t('auth.pin.staff.title')}
      lead={t('core.settings.staffPinsSummary')}
      testId="desktop.settings.staffPins"
    >
      {notice === null ? null : (
        <Banner
          tone={notice.tone}
          message={notice.text}
          onDismiss={() => setNotice(null)}
          dismissLabel={t('core.action.close')}
        />
      )}
      {searchable ? (
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder={t('auth.switcher.search')}
          label={t('core.action.search')}
          clearLabel={t('core.action.clearSearch')}
          className="max-w-sm"
          testId="desktop.settings.staffPins.search"
        />
      ) : null}
      {list.kind === 'loading' ? (
        <div className="flex flex-col gap-2" aria-busy>
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-14" />
          ))}
        </div>
      ) : list.kind === 'unauthorized' ? (
        <StatePanel
          icon={Lock}
          title={t('auth.pin.manage.unauthorizedTitle')}
          hint={t('auth.pin.manage.unauthorizedBody')}
        />
      ) : list.kind === 'error' ? (
        <StatePanel
          icon={CircleAlert}
          tone="danger"
          title={t('core.errors.UNEXPECTED')}
          action={
            <Button
              label={t('core.action.retry')}
              variant="secondary"
              onClick={() => void reload()}
            />
          }
        />
      ) : shown.length === 0 ? (
        <StatePanel
          icon={Users}
          title={
            list.targets.length > 0
              ? t('auth.switcher.noMatches')
              : t('auth.pc.settings.noOtherStaff')
          }
          testId="desktop.settings.staffPins.empty"
        />
      ) : (
        <ul
          className="divide-y divide-border rounded-md border border-border bg-surface"
          aria-label={t('auth.pin.staff.title')}
          data-testid="desktop.settings.staffPins.list"
        >
          {shown.map((user) => {
            const actions = staffPinActions(user, { canUnlock, canReset });
            return (
              <li
                key={user.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3"
                data-testid={`desktop.settings.staffPins.row.${user.id}`}
              >
                <PersonCell user={user} />
                {user.lockedOut ? (
                  <Chip label={t('auth.switcher.locked')} icon={Lock} tone="warning" />
                ) : user.needsFirstPin === true ? (
                  <Chip label={t('auth.switcher.noPin')} icon={KeyRound} tone="warning" />
                ) : null}
                <div className="ml-auto flex shrink-0 items-center gap-2">
                  {actions.includes('reset') ? (
                    <Button
                      label={t('auth.pin.staff.reset')}
                      variant={actions[0] === 'reset' ? 'secondary' : 'text'}
                      size="sm"
                      onClick={() => {
                        setNotice(null);
                        setResetFor(user);
                      }}
                      data-testid={`desktop.settings.staffPins.reset.${user.id}`}
                    />
                  ) : null}
                  {actions.includes('unlock') ? (
                    <Button
                      label={t('auth.pin.staff.unlock')}
                      variant="secondary"
                      size="sm"
                      icon={Lock}
                      busy={unlock.kind === 'submitting' && unlock.target.id === user.id}
                      onClick={() => {
                        setNotice(null);
                        dispatchUnlock({ kind: 'pick', target: user });
                      }}
                      data-testid={`desktop.settings.staffPins.unlock.${user.id}`}
                    />
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <ConfirmDialog
        open={unlock.kind === 'confirming'}
        title={
          unlock.kind === 'confirming'
            ? t('auth.pin.staff.unlockConfirmTitle', { name: unlock.target.name })
            : ''
        }
        message={t('auth.pin.unlock.confirm')}
        confirmLabel={t('auth.pin.staff.unlock')}
        cancelLabel={t('core.action.cancel')}
        closeLabel={t('core.action.close')}
        onConfirm={() => dispatchUnlock({ kind: 'confirm' })}
        onCancel={() => dispatchUnlock({ kind: 'cancel' })}
        testId="desktop.settings.staffPins.unlockConfirm"
      />
      {resetFor === null ? null : (
        <ResetPinDialog
          target={resetFor}
          resetPin={access.resetPin}
          onClose={(done) => {
            setResetFor(null);
            if (done) void reload();
          }}
        />
      )}
    </SettingsPanel>
  );
}

function PersonCell({ user }: { readonly user: PinTargetUser }): React.JSX.Element {
  const role = roleText(user.roleKeys);
  return (
    <div className="flex min-w-0 flex-1 basis-56 items-center gap-3">
      <Avatar userId={user.id} name={user.name} size={40} />
      <div className="flex min-w-0 flex-col">
        <p className="break-words text-body font-semibold text-text">{user.name}</p>
        {role === '' ? null : <p className="break-words text-small text-text-muted">{role}</p>}
      </div>
    </div>
  );
}

/**
 * A new PIN for a colleague: the owner lets them at the keyboard, they type it twice, then it is
 * saved. Opened from "PIN karyawan" and right after adding someone in "Karyawan".
 */
export function ResetPinDialog({
  target,
  resetPin,
  onClose,
}: {
  readonly target: PinTargetUser;
  readonly resetPin: (targetUserId: string, newPin: string) => Promise<void>;
  /** `done`: a PIN was made, so the caller reads its list again. */
  readonly onClose: (done: boolean) => void;
}): React.JSX.Element {
  const [phase, dispatch] = useReducer(resetPinReducer, target, (picked): ResetPhase =>
    resetPinReducer(RESET_LIST, { kind: 'pick', target: picked }),
  );
  const reset = useRef(resetPin);
  reset.current = resetPin;

  useEffect(() => {
    if (phase.kind !== 'submitting') return undefined;
    let cancelled = false;
    void reset.current(phase.target.id, phase.newPin).then(
      () => {
        if (!cancelled) dispatch({ kind: 'settled', result: { ok: true } });
      },
      (error: unknown) => {
        if (!cancelled) dispatch({ kind: 'settled', result: resetOutcome(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [phase]);

  const name = target.name;
  const person = { userId: target.id, name };
  const close = (): void => {
    if (phase.kind === 'submitting') return;
    onClose(phase.kind === 'done');
  };

  const body = (): React.JSX.Element => {
    switch (phase.kind) {
      case 'list':
      case 'handOver':
        return (
          <div
            className="flex flex-col items-center gap-3 py-2 text-center"
            data-testid="desktop.resetPin.handOver"
          >
            <span className="flex size-14 items-center justify-center rounded-full bg-surface-alt text-text-muted">
              <UserRound size={28} strokeWidth={1.75} aria-hidden />
            </span>
            <p className="text-heading font-semibold text-text">
              {t('auth.pc.settings.handOverTitle', { name })}
            </p>
            <p className="text-body text-text-muted">
              {t('auth.pc.settings.handOverBody', { name })}
            </p>
          </div>
        );
      case 'entering':
      case 'submitting': {
        const entry = phase.kind === 'entering' ? phase.entry : null;
        const feedback = entry === null ? null : newPinFeedbackKey(entry);
        const padState = entry === null ? 'busy' : newPinPadState(entry);
        return (
          <PinSteps
            person={person}
            prompt={t(entry === null ? 'auth.pin.setup.repeat' : newPinPromptKey(entry))}
            message={
              entry === null ? t('auth.pin.saving') : feedback === null ? undefined : t(feedback)
            }
            danger={padState === 'error'}
            padState={padState}
            padKey={entry === null ? 'submitting' : newPinPadKey(entry)}
            onComplete={(pin) => dispatch({ kind: 'enteredPin', pin })}
            testId="desktop.resetPin"
          />
        );
      }
      case 'done':
        return (
          <div
            className="flex flex-col items-center gap-2 py-4 text-center"
            data-testid="desktop.resetPin.done"
          >
            <CircleCheck size={40} strokeWidth={1.5} aria-hidden className="text-success" />
            <p className="text-heading font-semibold text-text">{t('auth.pin.reset.done')}</p>
            <p className="text-body text-text-muted">
              {t('auth.pin.staff.resetDoneBody', { name })}
            </p>
          </div>
        );
      case 'failed':
        return (
          <div
            className="flex flex-col items-center gap-2 py-4 text-center"
            data-testid="desktop.resetPin.failed"
          >
            <CircleAlert size={40} strokeWidth={1.5} aria-hidden className="text-warning" />
            <p className="text-heading font-semibold text-text">
              {t('auth.pin.staff.failedTitle')}
            </p>
            <p className="text-body text-text-muted">
              {phase.reason === 'denied' ? t('auth.pin.reset.denied') : t('core.errors.UNEXPECTED')}
            </p>
          </div>
        );
    }
  };

  return (
    <Dialog
      open
      onRequestClose={close}
      title={t('auth.pc.settings.pinFor', { name })}
      closeLabel={t('core.action.close')}
      size="sm"
      testId="desktop.resetPin"
      footer={
        phase.kind === 'handOver' || phase.kind === 'list' ? (
          <>
            <Button label={t('core.action.cancel')} onClick={close} />
            <Button
              label={t('auth.pin.staff.handedOver')}
              variant="primary"
              autoFocus
              onClick={() => dispatch({ kind: 'proceed' })}
              data-testid="desktop.resetPin.proceed"
            />
          </>
        ) : phase.kind === 'done' || phase.kind === 'failed' ? (
          <Button
            label={t(phase.kind === 'done' ? 'auth.pin.staff.finish' : 'core.action.close')}
            variant="primary"
            autoFocus
            onClick={close}
            data-testid="desktop.resetPin.finish"
          />
        ) : undefined
      }
    >
      {body()}
    </Dialog>
  );
}
