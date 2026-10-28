// "Tugas karyawan" on the PC: the main owner's role editor (product-scope.md, "Managers, limits,
// approvals and roles"). A list of the store roles, each opening a page of plain-language switches;
// a new role starts as a copy of another. The owners' own roles are listed as fixed. Each change is
// a server call, so it needs the internet and the page shows only what the server took.
import {
  staffAdminFailure,
  type StaffAdminFailure,
  type StaffDirectory,
  type StaffRole,
} from '@bolusi/core';
import type { StaffControls } from '@bolusi/device/bootstrap/staff';
import {
  abilityHint,
  abilityLabel,
  editableRoles,
  groupTitle,
  hasLimitableAbility,
  roleChangeOf,
  roleDraftOf,
  roleHint,
  roleInUse,
  roleName,
  roleNameProblem,
  switchAbility,
  type RoleDraft,
  type RoleNameProblem,
} from '@bolusi/device/models/staff/roles';
import { t } from '@bolusi/i18n';
import { ROLE_ABILITY_GROUPS, type RoleAbilityGroup } from '@bolusi/modules/roles';
import { FormFooter, SaveBar } from '@bolusi/modules/repair/desktop';
import { ROLE_NAME_MAX } from '@bolusi/schemas';
import {
  Banner,
  Button,
  Card,
  ChoiceList,
  Chip,
  ConfirmDialog,
  Dialog,
  SettingsPanel,
  Skeleton,
  StatePanel,
  Switch,
  TextField,
} from '@bolusi/ui-web';
import { ArrowLeft, ChevronRight, CircleAlert, Lock, Plus } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

type Loaded =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error' }
  | { readonly kind: 'ready'; readonly directory: StaffDirectory };

const GROUPS = ROLE_ABILITY_GROUPS as readonly RoleAbilityGroup[];

/** What a refused change says on the PC: offline asks to connect this computer, not a phone. */
function failureText(failure: StaffAdminFailure): string {
  return failure === 'offline' ? t('auth.pc.settings.staffOffline') : t(FAILURE_KEY_ROLES[failure]);
}

const FAILURE_KEY_ROLES = {
  offline: 'auth.roles.failure.offline',
  denied: 'auth.roles.failure.denied',
  lastOwner: 'auth.roles.failure.lastOwner',
  rateLimited: 'auth.roles.failure.rateLimited',
  unexpected: 'auth.roles.failure.unexpected',
} as const satisfies Record<StaffAdminFailure, string>;

const NAME_PROBLEM_KEY = {
  missing: 'auth.roles.problem.missing',
  tooLong: 'auth.roles.problem.tooLong',
  taken: 'auth.roles.problem.taken',
} as const satisfies Record<RoleNameProblem, string>;

export function RolesPanel({
  controls,
  onDirtyChange,
}: {
  readonly controls: StaffControls;
  readonly onDirtyChange: (dirty: boolean) => void;
}): React.JSX.Element {
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
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
  const open = directory?.roles.find((role) => role.id === openId && !role.ownerRole);

  if (directory !== null && open !== undefined) {
    return (
      <RoleEditor
        key={open.id}
        role={open}
        directory={directory}
        controls={controls}
        notice={notice}
        onClearNotice={() => setNotice(null)}
        onDirtyChange={onDirtyChange}
        onBack={() => {
          setNotice(null);
          setOpenId(null);
        }}
        onSaved={async (message) => {
          await reload();
          setNotice(message);
        }}
        onDeleted={async (message) => {
          await reload();
          setOpenId(null);
          setNotice(message);
        }}
      />
    );
  }

  return (
    <SettingsPanel
      title={t('auth.roles.title')}
      lead={t('auth.roles.settingsSummary')}
      actions={
        directory === null ? undefined : (
          <Button
            label={t('auth.roles.add')}
            icon={Plus}
            variant="primary"
            onClick={() => {
              setNotice(null);
              setAdding(true);
            }}
            data-testid="desktop.settings.roles.add"
          />
        )
      }
      testId="desktop.settings.roles"
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
      ) : (
        <RoleList
          directory={directory}
          onOpen={(roleId) => {
            setNotice(null);
            setOpenId(roleId);
          }}
        />
      )}
      {directory === null || !adding ? null : (
        <AddRoleDialog
          directory={directory}
          onClose={() => setAdding(false)}
          onCreate={async (name, copyFromRoleId) => {
            const { roleId } = await latest.current.onCreateRole(name, copyFromRoleId);
            await reload();
            setAdding(false);
            setOpenId(roleId);
            setNotice(t('auth.roles.created', { role: name }));
          }}
        />
      )}
    </SettingsPanel>
  );
}

function RoleList({
  directory,
  onOpen,
}: {
  readonly directory: StaffDirectory;
  readonly onOpen: (roleId: string) => void;
}): React.JSX.Element {
  const owners = directory.roles.filter((role) => role.ownerRole);
  return (
    <div className="flex flex-col gap-3">
      <ul
        aria-label={t('auth.roles.title')}
        className="rounded-md border border-border bg-surface"
        data-testid="desktop.settings.roles.list"
      >
        {editableRoles(directory).map((role) => (
          <li key={role.id} className="border-b border-border last:border-b-0">
            <button
              type="button"
              onClick={() => onOpen(role.id)}
              className="flex w-full cursor-pointer items-center gap-4 px-4 py-3 text-left hover:bg-surface-alt focus-visible:bg-surface-alt focus-visible:outline-none"
              data-testid={`desktop.settings.roles.open.${role.id}`}
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="break-words text-body font-semibold text-text">
                  {roleName(role)}
                </span>
                <span className="break-words text-small text-text-muted">{roleHint(role)}</span>
              </span>
              <span className="shrink-0 text-small text-text-muted">
                {t('auth.roles.holders', { count: holders(directory, role) })}
              </span>
              <ChevronRight size={18} aria-hidden className="shrink-0 text-text-muted" />
            </button>
          </li>
        ))}
        {owners.map((role) => (
          <li
            key={role.id}
            className="flex items-center gap-4 border-b border-border bg-surface-alt px-4 py-3 last:border-b-0"
            data-testid={`desktop.settings.roles.owner.${role.key}`}
          >
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="break-words text-body font-semibold text-text-muted">
                {roleName(role)}
              </span>
              <span className="break-words text-small text-text-muted">
                {t('auth.roles.ownersFixed')}
              </span>
            </span>
            <Chip label={t('auth.roles.fixed')} icon={Lock} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function holders(directory: StaffDirectory, role: StaffRole): number {
  return directory.members.filter((member) => member.active && member.roleIds.includes(role.id))
    .length;
}

function AddRoleDialog({
  directory,
  onClose,
  onCreate,
}: {
  readonly directory: StaffDirectory;
  readonly onClose: () => void;
  readonly onCreate: (name: string, copyFromRoleId: string) => Promise<void>;
}): React.JSX.Element {
  const sources = editableRoles(directory);
  const [name, setName] = useState('');
  const [from, setFrom] = useState<string | null>(sources[0]?.id ?? null);
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<StaffAdminFailure | null>(null);
  const problem = roleNameProblem(name, directory.roles, null);

  const save = (): void => {
    setAttempted(true);
    if (problem !== null || from === null || busy) return;
    setBusy(true);
    setFailure(null);
    onCreate(name.trim(), from).catch((error: unknown) => {
      setBusy(false);
      setFailure(staffAdminFailure(error));
    });
  };

  return (
    <Dialog
      open
      onRequestClose={() => {
        if (!busy) onClose();
      }}
      title={t('auth.roles.addTitle')}
      closeLabel={t('core.action.close')}
      size="md"
      testId="desktop.roles.add"
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
          <Button label={t('core.action.cancel')} onClick={onClose} disabled={busy} />
          <Button
            label={t('auth.roles.create')}
            variant="primary"
            onClick={save}
            busy={busy}
            data-testid="desktop.roles.add.save"
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
          label={t('auth.roles.name')}
          error={
            attempted && problem !== null
              ? t(NAME_PROBLEM_KEY[problem], { max: ROLE_NAME_MAX })
              : undefined
          }
          value={name}
          onChange={(event) => {
            setFailure(null);
            setName(event.target.value);
          }}
          maxLength={ROLE_NAME_MAX + 10}
          autoComplete="off"
          disabled={busy}
          autoFocus
          data-testid="desktop.roles.add.name"
        />
        <div className="flex flex-col gap-2">
          <span className="text-small font-semibold text-text">{t('auth.roles.copyFrom')}</span>
          <span className="-mt-1 text-small text-text-muted">{t('auth.roles.copyFromHint')}</span>
          <ChoiceList
            options={sources.map((role) => ({ value: role.id, label: roleName(role) }))}
            value={from}
            onChange={setFrom}
            label={t('auth.roles.copyFrom')}
            testId="desktop.roles.add.from"
          />
        </div>
      </form>
    </Dialog>
  );
}

function RoleEditor({
  role,
  directory,
  controls,
  notice,
  onClearNotice,
  onDirtyChange,
  onBack,
  onSaved,
  onDeleted,
}: {
  readonly role: StaffRole;
  readonly directory: StaffDirectory;
  readonly controls: StaffControls;
  readonly notice: string | null;
  readonly onClearNotice: () => void;
  readonly onDirtyChange: (dirty: boolean) => void;
  readonly onBack: () => void;
  readonly onSaved: (message: string) => Promise<void>;
  readonly onDeleted: (message: string) => Promise<void>;
}): React.JSX.Element {
  const [draft, setDraft] = useState<RoleDraft>(() => roleDraftOf(role));
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<StaffAdminFailure | null>(null);
  const [ask, setAsk] = useState<'discard' | 'delete' | null>(null);

  // The saved role, re-read after a save, is the new starting point.
  useEffect(() => {
    setDraft(roleDraftOf(role));
  }, [role]);

  const change = roleChangeOf(role, draft);
  const problem = role.custom ? roleNameProblem(draft.name, directory.roles, role.id) : null;
  const dirty = change !== null;
  const report = useRef(onDirtyChange);
  report.current = onDirtyChange;
  useEffect(() => {
    report.current(dirty);
  }, [dirty]);
  useEffect(() => () => report.current(false), []);

  const edit = (next: (current: RoleDraft) => RoleDraft): void => {
    onClearNotice();
    setFailure(null);
    setDraft(next);
  };
  const run = (work: () => Promise<void>): void => {
    setBusy(true);
    setFailure(null);
    onClearNotice();
    work()
      .catch((error: unknown) => setFailure(staffAdminFailure(error)))
      .finally(() => setBusy(false));
  };
  const save = (): void => {
    setAttempted(true);
    if (change === null || problem !== null || busy) return;
    run(async () => {
      await controls.onUpdateRole(role.id, change);
      setAttempted(false);
      await onSaved(t('auth.roles.saved', { role: draft.name.trim() || roleName(role) }));
    });
  };
  const inUse = roleInUse(directory, role.id);
  const limitable = hasLimitableAbility(draft.on);

  return (
    <SettingsPanel
      title={roleName(role)}
      lead={t('auth.roles.intro')}
      actions={
        <Button
          label={t('auth.roles.title')}
          icon={ArrowLeft}
          variant="secondary"
          onClick={() => (dirty ? setAsk('discard') : onBack())}
          disabled={busy}
          data-testid="desktop.roles.back"
        />
      }
      testId="desktop.settings.roles.editor"
    >
      {failure === null ? null : (
        <Banner
          tone={failure === 'offline' ? 'warning' : 'danger'}
          message={failureText(failure)}
        />
      )}
      {notice === null ? null : (
        <Banner
          tone="success"
          message={notice}
          onDismiss={onClearNotice}
          dismissLabel={t('core.action.close')}
        />
      )}
      {role.custom ? (
        <Card>
          <TextField
            label={t('auth.roles.name')}
            error={
              attempted && problem !== null
                ? t(NAME_PROBLEM_KEY[problem], { max: ROLE_NAME_MAX })
                : undefined
            }
            value={draft.name}
            onChange={(event) => {
              const name = event.target.value;
              edit((current) => ({ ...current, name }));
            }}
            autoComplete="off"
            disabled={busy}
            data-testid="desktop.roles.name"
          />
        </Card>
      ) : null}
      {GROUPS.map((group) => (
        <Card key={group.id} testId={`desktop.roles.group.${group.id}`}>
          <h3 className="pb-2 text-body font-semibold text-text">{groupTitle(group.id)}</h3>
          <div className="flex flex-col divide-y divide-border">
            {group.abilities.map((ability) => (
              <Switch
                key={ability.id}
                label={abilityLabel(ability.id)}
                caption={abilityHint(ability.id)}
                checked={draft.on.has(ability.id)}
                onChange={(value) =>
                  edit((current) => switchAbility(current, ability.id, value))
                }
                disabled={busy}
                className="py-3"
                testId={`desktop.roles.ability.${ability.id}`}
              />
            ))}
          </div>
        </Card>
      ))}
      {limitable || draft.limited ? (
        <Card testId="desktop.roles.limits">
          <Switch
            label={t('auth.roles.limited')}
            caption={t('auth.roles.limitedHint')}
            checked={draft.limited}
            onChange={(limited) => edit((current) => ({ ...current, limited }))}
            disabled={busy}
            testId="desktop.roles.limited"
          />
        </Card>
      ) : null}
      {role.custom ? (
        <div className="flex flex-col items-start gap-1">
          <Button
            label={t('auth.roles.delete')}
            variant="dangerText"
            onClick={() => setAsk('delete')}
            disabled={busy || inUse}
            data-testid="desktop.roles.delete"
          />
          {inUse ? (
            <span className="text-small text-text-muted">{t('auth.roles.inUse')}</span>
          ) : null}
        </div>
      ) : null}
      <FormFooter>
        <SaveBar
          dirty={dirty}
          busy={busy}
          saved={null}
          onSave={save}
          onDiscard={() => {
            setAttempted(false);
            setFailure(null);
            setDraft(roleDraftOf(role));
          }}
          saveLabel={t('auth.roles.save')}
          testId="desktop.roles"
        />
      </FormFooter>
      <ConfirmDialog
        open={ask === 'discard'}
        title={t('auth.staff.discardTitle')}
        message={t('auth.staff.discardMessage')}
        confirmLabel={t('auth.staff.discard')}
        cancelLabel={t('auth.staff.keepEditing')}
        closeLabel={t('core.action.close')}
        destructive
        onConfirm={() => {
          setAsk(null);
          report.current(false);
          onBack();
        }}
        onCancel={() => setAsk(null)}
        testId="desktop.roles.discard"
      />
      <ConfirmDialog
        open={ask === 'delete'}
        title={t('auth.roles.deleteTitle', { role: roleName(role) })}
        message={t('auth.roles.deleteMessage')}
        confirmLabel={t('auth.roles.delete')}
        cancelLabel={t('core.action.cancel')}
        closeLabel={t('core.action.close')}
        destructive
        onConfirm={() => {
          setAsk(null);
          run(async () => {
            await controls.onDeleteRole(role.id);
            await onDeleted(t('auth.roles.deleted', { role: roleName(role) }));
          });
        }}
        onCancel={() => setAsk(null)}
        testId="desktop.roles.deleteConfirm"
      />
    </SettingsPanel>
  );
}
