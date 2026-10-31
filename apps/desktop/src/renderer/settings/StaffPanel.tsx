// "Karyawan" on the PC: the owner adds the people of this store, changes their name or roles, and
// deactivates or reactivates them (owner decision 2026-10-27). The phone's staff model decides who
// may be changed and which roles are offered; each change is a server call, so it needs the
// internet and the list shows only what the server took.
//
// A new person has no PIN. Right after adding, the owner is offered "Buat PIN", the same new-PIN
// dialog as "PIN karyawan": one PIN flow, not two.
import {
  staffAdminFailure,
  type StaffActor,
  type StaffAdminFailure,
  type StaffDirectory,
  type StaffDraft,
  type StaffMember,
} from '@bolusi/core';
import type { StaffControls } from '@bolusi/device/bootstrap/staff';
import {
  FAILURE_KEY,
  formRoles,
  hasOtherStaff,
  PROBLEM_KEY,
  staffChange,
  staffDraftProblem,
  staffListItems,
  toggleRole,
  type StaffListItem,
  type StaffStep,
} from '@bolusi/device/models/staff/model';
import { roleHint, roleName } from '@bolusi/device/models/staff/roles';
import type { PinTargetUser } from '@bolusi/device/models/pin/pin-target';
import { t } from '@bolusi/i18n';
import {
  Avatar,
  Banner,
  Button,
  Chip,
  ConfirmDialog,
  Dialog,
  SettingsPanel,
  Skeleton,
  StatePanel,
  TextField,
} from '@bolusi/ui-web';
import { clsx } from 'clsx';
import {
  Check,
  CircleAlert,
  CircleCheck,
  KeyRound,
  Lock,
  Plus,
  UserRound,
  Users,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ResetPinDialog, roleText } from './StaffPinsPanel.js';

type Loaded =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error' }
  | { readonly kind: 'ready'; readonly directory: StaffDirectory };

/** What a refused change says on the PC: offline asks to connect this computer, not a phone. */
function failureText(failure: StaffAdminFailure): string {
  return failure === 'offline' ? t('auth.pc.settings.staffOffline') : t(FAILURE_KEY[failure]);
}

export function StaffPanel({
  controls,
  actorUserId,
  resetPin,
}: {
  readonly controls: StaffControls;
  readonly actorUserId: string;
  /** Make a new person's first PIN; absent when this owner may not. */
  readonly resetPin?: ((targetUserId: string, newPin: string) => Promise<void>) | undefined;
}): React.JSX.Element {
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [step, setStep] = useState<StaffStep>({ kind: 'list' });
  const [notice, setNotice] = useState<string | null>(null);
  const [pinFor, setPinFor] = useState<PinTargetUser | null>(null);
  const actor: StaffActor = useMemo(
    () => ({ userId: actorUserId, tenantAdmin: controls.tenantAdmin }),
    [actorUserId, controls.tenantAdmin],
  );
  const latest = useRef(controls);
  latest.current = controls;

  const reload = useCallback(async (): Promise<StaffDirectory | null> => {
    try {
      const directory = await latest.current.load();
      setLoaded({ kind: 'ready', directory });
      return directory;
    } catch {
      setLoaded({ kind: 'error' });
      return null;
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  const directory = loaded.kind === 'ready' ? loaded.directory : null;
  const member = (id: string): StaffMember | undefined =>
    directory?.members.find((candidate) => candidate.id === id);
  const finish = (message: string | null): void => {
    setNotice(message);
    setStep({ kind: 'list' });
  };
  const makePin = (target: StaffMember | { id: string; name: string }): void => {
    setStep({ kind: 'list' });
    setPinFor({
      id: target.id,
      name: target.name,
      roleKeys: 'roleKeys' in target ? target.roleKeys : [],
      needsFirstPin: true,
      lockedOut: false,
    });
  };

  const items = directory === null ? [] : staffListItems(directory, actor);
  const editing = step.kind === 'edit' ? member(step.id) : undefined;
  const inactive = step.kind === 'inactive' ? member(step.id) : undefined;

  return (
    <SettingsPanel
      title={t('auth.staff.title')}
      lead={t('auth.staff.settingsSummary')}
      actions={
        directory === null ? undefined : (
          <Button
            label={t('auth.staff.add')}
            icon={Plus}
            variant="primary"
            onClick={() => {
              setNotice(null);
              setStep({ kind: 'add' });
            }}
            data-testid="desktop.settings.staff.add"
          />
        )
      }
      testId="desktop.settings.staff"
    >
      {notice === null ? null : (
        <Banner
          tone="success"
          message={notice}
          onDismiss={() => setNotice(null)}
          dismissLabel={t('core.action.close')}
        />
      )}
      {loaded.kind === 'loading' ? (
        <div className="flex flex-col gap-2" aria-busy>
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-14" />
          ))}
        </div>
      ) : directory === null ? (
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
      ) : !hasOtherStaff(directory, actor) ? (
        <StatePanel
          icon={Users}
          title={t('auth.staff.empty')}
          hint={t('auth.staff.emptyBody')}
          testId="desktop.settings.staff.empty"
        />
      ) : (
        <StaffTable
          items={items}
          onOpen={(next) => {
            setNotice(null);
            setStep(next);
          }}
        />
      )}

      {directory !== null && (step.kind === 'add' || editing !== undefined) ? (
        <PersonDialog
          key={editing?.id ?? 'new'}
          directory={directory}
          actor={actor}
          editing={editing ?? null}
          onClose={() => finish(null)}
          onCreate={async (draft) => {
            const { userId } = await latest.current.onCreate(draft);
            await reload();
            setStep({ kind: 'added', id: userId, name: draft.name.trim() });
          }}
          onUpdate={async (userId, change) => {
            await latest.current.onUpdate(userId, change);
            await reload();
            finish(t('auth.staff.saved'));
          }}
          onDeactivate={async (target) => {
            await latest.current.onSetActive(target.id, false);
            await reload();
            finish(t('auth.staff.deactivated', { name: target.name }));
          }}
          onMakePin={resetPin === undefined ? undefined : makePin}
        />
      ) : null}

      {step.kind === 'added' ? (
        <AddedDialog
          name={step.name}
          here={member(step.id) !== undefined}
          onLater={() => finish(null)}
          onMakePin={
            resetPin === undefined || member(step.id) === undefined
              ? undefined
              : () => makePin(member(step.id)!)
          }
        />
      ) : null}

      {inactive === undefined ? null : (
        <InactiveDialog
          target={inactive}
          onClose={() => finish(null)}
          onReactivate={async () => {
            await latest.current.onSetActive(inactive.id, true);
            await reload();
            finish(t('auth.staff.reactivated', { name: inactive.name }));
          }}
        />
      )}

      {pinFor === null || resetPin === undefined ? null : (
        <ResetPinDialog
          target={pinFor}
          resetPin={resetPin}
          onClose={() => {
            setPinFor(null);
            void reload();
          }}
        />
      )}
    </SettingsPanel>
  );
}

/** Everyone here: active people, then a heading and the deactivated ones. A row opens if allowed. */
function StaffTable({
  items,
  onOpen,
}: {
  readonly items: readonly StaffListItem[];
  readonly onOpen: (step: StaffStep) => void;
}): React.JSX.Element {
  return (
    <div
      className="rounded-md border border-border bg-surface"
      data-testid="desktop.settings.staff.list"
    >
      <div
        aria-hidden
        className="grid grid-cols-[minmax(200px,2fr)_minmax(140px,2fr)_minmax(160px,1fr)] gap-x-4 border-b border-border px-4 py-2 text-small font-semibold text-text-muted"
      >
        <span>{t('auth.pc.settings.colName')}</span>
        <span>{t('auth.pc.settings.colRoles')}</span>
        <span>{t('auth.pc.settings.colStatus')}</span>
      </div>
      <ul aria-label={t('auth.staff.title')}>
        {items.map((item) =>
          item.kind === 'inactiveHeading' ? (
            <li
              key="inactive"
              className="border-b border-border bg-surface-alt px-4 py-2 text-small font-semibold text-text-muted"
              data-testid="desktop.settings.staff.inactiveHeading"
            >
              {t('auth.staff.inactiveSection')}
            </li>
          ) : (
            <MemberRow key={item.member.id} item={item} onOpen={onOpen} />
          ),
        )}
      </ul>
    </div>
  );
}

function MemberRow({
  item,
  onOpen,
}: {
  readonly item: Extract<StaffListItem, { kind: 'member' }>;
  readonly onOpen: (step: StaffStep) => void;
}): React.JSX.Element {
  const { member, self, open } = item;
  // One status at most, the one that needs the owner: you, deactivated, or a missing PIN.
  const status = self ? (
    <Chip label={t('auth.staff.you')} icon={UserRound} />
  ) : !member.active ? (
    <Chip label={t('auth.staff.inactive')} icon={Lock} />
  ) : !member.hasPin ? (
    <Chip label={t('auth.staff.noPin')} icon={KeyRound} tone="warning" />
  ) : null;
  const cells = (
    <>
      <span className="flex min-w-0 items-center gap-3">
        <Avatar userId={member.id} name={member.name} size={32} />
        <span
          className={clsx(
            'min-w-0 break-words text-body font-semibold',
            member.active ? 'text-text' : 'text-text-muted',
          )}
        >
          {member.name}
        </span>
      </span>
      <span className="min-w-0 break-words text-body text-text-muted">
        {roleText(member.roleKeys)}
      </span>
      <span className="flex items-center">{status}</span>
    </>
  );
  const grid =
    'grid w-full grid-cols-[minmax(200px,2fr)_minmax(140px,2fr)_minmax(160px,1fr)] items-center gap-x-4 px-4 py-3 text-left';
  return (
    <li
      className="border-b border-border last:border-b-0"
      data-testid={`desktop.settings.staff.row.${member.id}`}
    >
      {open === null ? (
        <div className={grid}>{cells}</div>
      ) : (
        <button
          type="button"
          onClick={() => onOpen(open)}
          className={clsx(
            grid,
            'cursor-pointer hover:bg-surface-alt focus-visible:bg-surface-alt focus-visible:outline-none',
          )}
          data-testid={`desktop.settings.staff.open.${member.id}`}
        >
          {cells}
        </button>
      )}
    </li>
  );
}

/**
 * Adding someone, or an active person's page: name, roles, and for someone already here a missing
 * PIN and deactivating. Problems show once the owner presses save, beside the field.
 */
function PersonDialog({
  directory,
  actor,
  editing,
  onClose,
  onCreate,
  onUpdate,
  onDeactivate,
  onMakePin,
}: {
  readonly directory: StaffDirectory;
  readonly actor: StaffActor;
  readonly editing: StaffMember | null;
  readonly onClose: () => void;
  readonly onCreate: (draft: StaffDraft) => Promise<void>;
  readonly onUpdate: (
    userId: string,
    change: { readonly name?: string; readonly roleIds?: readonly string[] },
  ) => Promise<void>;
  readonly onDeactivate: (member: StaffMember) => Promise<void>;
  readonly onMakePin?: ((member: StaffMember) => void) | undefined;
}): React.JSX.Element {
  const [draft, setDraft] = useState<StaffDraft>(() => ({
    name: editing?.name ?? '',
    roleIds: editing?.roleIds ?? [],
  }));
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<StaffAdminFailure | null>(null);
  const [ask, setAsk] = useState<'discard' | 'deactivate' | null>(null);

  const roles = useMemo(
    () => formRoles(directory, actor, editing?.roleIds ?? []),
    [directory, actor, editing],
  );
  const problem = staffDraftProblem(draft, directory.members, editing?.id ?? null);
  const change = editing === null ? null : staffChange(editing, draft);
  const dirty =
    editing === null ? draft.name.trim() !== '' || draft.roleIds.length > 0 : change !== null;

  const leave = (): void => {
    if (busy) return;
    if (dirty) setAsk('discard');
    else onClose();
  };

  const run = (work: () => Promise<void>): void => {
    setBusy(true);
    setFailure(null);
    void work().then(
      () => setBusy(false),
      (error: unknown) => {
        setBusy(false);
        setFailure(staffAdminFailure(error));
      },
    );
  };

  const save = (): void => {
    setAttempted(true);
    if (problem !== null || busy) return;
    if (editing === null) run(() => onCreate({ name: draft.name.trim(), roleIds: draft.roleIds }));
    else if (change === null) onClose();
    else run(() => onUpdate(editing.id, change));
  };

  const nameProblem =
    attempted && problem !== null && problem !== 'roleMissing'
      ? t(PROBLEM_KEY[problem])
      : undefined;
  const testId = editing === null ? 'desktop.staff.add' : 'desktop.staff.edit';

  return (
    <>
      <Dialog
        open={ask === null}
        onRequestClose={leave}
        title={t(editing === null ? 'auth.staff.addTitle' : 'auth.staff.editTitle')}
        closeLabel={t('core.action.close')}
        size="md"
        testId={testId}
        banner={
          failure === null ? undefined : (
            <Banner
              tone={failure === 'offline' ? 'warning' : 'danger'}
              message={failureText(failure)}
            />
          )
        }
        footer={
          <>
            {editing === null ? null : (
              <Button
                label={t('auth.staff.deactivate')}
                variant="dangerText"
                onClick={() => setAsk('deactivate')}
                disabled={busy}
                className="mr-auto"
                data-testid="desktop.staff.deactivate"
              />
            )}
            <Button label={t('core.action.cancel')} onClick={leave} disabled={busy} />
            <Button
              label={t(editing === null ? 'auth.staff.add' : 'auth.staff.save')}
              variant="primary"
              onClick={save}
              busy={busy}
              data-testid={`${testId}.save`}
            />
          </>
        }
      >
        <form
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <TextField
            label={t('auth.staff.name')}
            hint={t('auth.staff.nameHint')}
            error={nameProblem}
            value={draft.name}
            onChange={(event) => {
              setFailure(null);
              setDraft((current) => ({ ...current, name: event.target.value }));
            }}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            // The owner opened this to type a name.
            autoFocus={editing === null}
            data-testid={`${testId}.name`}
          />
          <fieldset className="flex flex-col gap-2">
            <legend className="text-small font-semibold text-text">{t('auth.staff.roles')}</legend>
            <p className="-mt-1 text-small text-text-muted">{t('auth.staff.rolesHint')}</p>
            <div className="flex flex-col divide-y divide-border rounded-sm border border-border">
              {roles.map((role) => {
                const checked = draft.roleIds.includes(role.id);
                return (
                  <label
                    key={role.id}
                    className={clsx(
                      'flex cursor-pointer items-start gap-3 px-3 py-2.5 hover:bg-surface-alt',
                      busy && 'pointer-events-none opacity-60',
                    )}
                    data-testid={`${testId}.role.${role.key}`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={busy}
                      onChange={() => {
                        setFailure(null);
                        setDraft((current) => ({
                          ...current,
                          roleIds: toggleRole(current.roleIds, role.id),
                        }));
                      }}
                      className="peer sr-only"
                    />
                    <span
                      aria-hidden
                      className={clsx(
                        'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-xs border peer-focus-visible:ring-2 peer-focus-visible:ring-primary/40',
                        checked
                          ? 'border-primary bg-primary text-on-primary'
                          : 'border-border bg-surface',
                      )}
                    >
                      {checked ? <Check size={14} strokeWidth={3} /> : null}
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className="text-body font-semibold text-text">{roleName(role)}</span>
                      <span className="text-small text-text-muted">{roleHint(role)}</span>
                    </span>
                  </label>
                );
              })}
            </div>
            {attempted && problem === 'roleMissing' ? (
              <p
                role="alert"
                className="text-small text-danger"
                data-testid={`${testId}.roleProblem`}
              >
                {t(PROBLEM_KEY.roleMissing)}
              </p>
            ) : null}
          </fieldset>
          {editing === null || editing.hasPin || onMakePin === undefined ? null : (
            <div
              className="flex flex-wrap items-center justify-between gap-3 rounded-sm bg-warning-bg px-4 py-3"
              data-testid="desktop.staff.edit.noPin"
            >
              <p className="text-body text-warning">{t('auth.staff.makePinHint')}</p>
              <Button
                label={t('auth.staff.makePin')}
                icon={KeyRound}
                size="sm"
                onClick={() => onMakePin(editing)}
                // Making the PIN leaves this form; save or drop the changes first.
                disabled={busy || dirty}
                data-testid="desktop.staff.edit.makePin"
              />
            </div>
          )}
          {/* Enter in the name field saves, as in any form. */}
          <button type="submit" hidden />
        </form>
      </Dialog>
      <ConfirmDialog
        open={ask === 'discard'}
        title={t('auth.staff.discardTitle')}
        message={t('auth.staff.discardMessage')}
        confirmLabel={t('auth.staff.discard')}
        cancelLabel={t('auth.staff.keepEditing')}
        closeLabel={t('core.action.close')}
        destructive
        onConfirm={onClose}
        onCancel={() => setAsk(null)}
        testId="desktop.staff.discard"
      />
      <ConfirmDialog
        open={ask === 'deactivate' && editing !== null}
        title={editing === null ? '' : t('auth.staff.deactivateTitle', { name: editing.name })}
        message={t('auth.staff.deactivateBody')}
        confirmLabel={t('auth.staff.deactivateConfirm')}
        cancelLabel={t('core.action.cancel')}
        closeLabel={t('core.action.close')}
        destructive
        onConfirm={() => {
          setAsk(null);
          if (editing !== null) run(() => onDeactivate(editing));
        }}
        onCancel={() => setAsk(null)}
        testId="desktop.staff.deactivateConfirm"
      />
    </>
  );
}

function AddedDialog({
  name,
  here,
  onLater,
  onMakePin,
}: {
  readonly name: string;
  /** On this PC already; otherwise the next sync brings them. */
  readonly here: boolean;
  readonly onLater: () => void;
  readonly onMakePin?: (() => void) | undefined;
}): React.JSX.Element {
  return (
    <Dialog
      open
      onRequestClose={onLater}
      title={t('auth.staff.addTitle')}
      closeLabel={t('core.action.close')}
      size="sm"
      testId="desktop.staff.added"
      footer={
        onMakePin === undefined ? (
          <Button
            label={t('auth.pin.staff.finish')}
            variant="primary"
            onClick={onLater}
            autoFocus
          />
        ) : (
          <>
            <Button
              label={t('auth.staff.later')}
              onClick={onLater}
              data-testid="desktop.staff.added.later"
            />
            <Button
              label={t('auth.staff.makePinNow')}
              variant="primary"
              icon={KeyRound}
              onClick={onMakePin}
              autoFocus
              data-testid="desktop.staff.added.makePin"
            />
          </>
        )
      }
    >
      <div className="flex flex-col items-center gap-2 py-2 text-center">
        <CircleCheck size={40} strokeWidth={1.5} aria-hidden className="text-success" />
        <p className="text-heading font-semibold text-text">
          {t('auth.staff.addedTitle', { name })}
        </p>
        <p className="text-body text-text-muted">
          {here ? t('auth.pc.settings.addedBody') : t('auth.pc.settings.notYetHere', { name })}
        </p>
      </div>
    </Dialog>
  );
}

function InactiveDialog({
  target,
  onClose,
  onReactivate,
}: {
  readonly target: StaffMember;
  readonly onClose: () => void;
  readonly onReactivate: () => Promise<void>;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<StaffAdminFailure | null>(null);
  return (
    <Dialog
      open
      onRequestClose={() => (busy ? undefined : onClose())}
      title={target.name}
      closeLabel={t('core.action.close')}
      size="sm"
      testId="desktop.staff.inactive"
      banner={
        failure === null ? undefined : (
          <Banner
            tone={failure === 'offline' ? 'warning' : 'danger'}
            message={failureText(failure)}
          />
        )
      }
      footer={
        <>
          <Button label={t('core.action.close')} onClick={onClose} disabled={busy} />
          <Button
            label={t('auth.staff.reactivate')}
            variant="primary"
            busy={busy}
            onClick={() => {
              setBusy(true);
              setFailure(null);
              void onReactivate().then(
                () => setBusy(false),
                (error: unknown) => {
                  setBusy(false);
                  setFailure(staffAdminFailure(error));
                },
              );
            }}
            data-testid="desktop.staff.reactivate"
          />
        </>
      }
    >
      <div className="flex items-center gap-3">
        <Avatar userId={target.id} name={target.name} size={40} />
        <div className="flex min-w-0 flex-col gap-1">
          <Chip label={t('auth.staff.inactive')} icon={Lock} />
          <p className="text-body text-text-muted">{t('auth.staff.inactiveBody')}</p>
        </div>
      </div>
    </Dialog>
  );
}
