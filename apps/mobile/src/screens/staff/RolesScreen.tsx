/**
 * "Tugas karyawan" — the main owner's role editor (product-scope.md, "Managers, limits, approvals
 * and roles"), reached from Settings. The store roles in a list; each opens a page of plain-language
 * switches, and a new role starts as a copy of another. The owners' own roles are listed as fixed.
 *
 * ONLINE ONLY, like "Karyawan": each change is a server call, and the screen re-reads this phone's
 * directory afterwards, so it never shows a role the server refused.
 */
import {
  staffAdminFailure,
  type StaffAdminFailure,
  type StaffDirectory,
  type StaffRole,
} from '@bolusi/core';
import type { RoleChange } from '@bolusi/device/bootstrap/staff';
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
import { ROLE_NAME_MAX } from '@bolusi/schemas';
import {
  Banner,
  Button,
  ConfirmSheet,
  Icon,
  List,
  ListRow,
  SwitchRow,
  TextButton,
  TextInput,
  border,
  color,
  space,
  type,
  type ListState,
} from '@bolusi/ui';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useLatestCallback } from '../../hooks/useLatestCallback.js';
import type { SurfaceNav } from '../../navigation/surface.js';

import { StaffShell } from './StaffPages.js';

export interface RolesScreenProps {
  /** Read the roles and who holds them from this phone's directory. */
  readonly load: () => Promise<StaffDirectory>;
  /** Each resolves once the server took the change and this phone's directory caught up; each
   *  REJECTS with a `StaffAdminError`. */
  readonly onCreate: (name: string, copyFromRoleId: string) => Promise<{ readonly roleId: string }>;
  readonly onUpdate: (roleId: string, change: RoleChange) => Promise<void>;
  readonly onDelete: (roleId: string) => Promise<void>;
  readonly onClose: () => void;
  readonly onRegisterSurfaceNav?: ((nav: SurfaceNav | null) => void) | undefined;
}

type Loaded =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error' }
  | { readonly kind: 'ready'; readonly directory: StaffDirectory };

type Step =
  | { readonly kind: 'list' }
  | { readonly kind: 'add' }
  | { readonly kind: 'edit'; readonly roleId: string };

const GROUPS = ROLE_ABILITY_GROUPS as readonly RoleAbilityGroup[];

const FAILURE_KEY = {
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

export function RolesScreen({
  load,
  onCreate,
  onUpdate,
  onDelete,
  onClose,
  onRegisterSurfaceNav,
}: RolesScreenProps): React.JSX.Element {
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [step, setStep] = useState<Step>({ kind: 'list' });
  const [notice, setNotice] = useState<string | null>(null);

  const latestLoad = useLatestCallback(load);
  const reload = useCallback(async (): Promise<void> => {
    try {
      setLoaded({ kind: 'ready', directory: await latestLoad() });
    } catch {
      setLoaded({ kind: 'error' });
    }
  }, [latestLoad]);
  useEffect(() => {
    void reload();
  }, [reload]);

  // A step's own back (asking first when there are changes) wins; the list's back leaves.
  const [stepBack, setStepBack] = useState<(() => void) | null>(null);
  const back = (): void => {
    if (stepBack !== null) stepBack();
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

  const directory = loaded.kind === 'ready' ? loaded.directory : null;
  const toList = (message: string | null): void => {
    setStepBack(null);
    setNotice(message);
    setStep({ kind: 'list' });
  };

  if (directory !== null && step.kind === 'add') {
    return (
      <AddRole
        directory={directory}
        onRegisterBack={setStepBack}
        onLeave={() => toList(null)}
        onCreate={async (name, from) => {
          const { roleId } = await onCreate(name, from);
          await reload();
          setStepBack(null);
          setNotice(t('auth.roles.created', { role: name }));
          setStep({ kind: 'edit', roleId });
        }}
      />
    );
  }
  const editing =
    step.kind === 'edit'
      ? directory?.roles.find((role) => role.id === step.roleId && !role.ownerRole)
      : undefined;
  if (directory !== null && editing !== undefined) {
    return (
      <RoleEditor
        key={editing.id}
        role={editing}
        directory={directory}
        notice={notice}
        onClearNotice={() => setNotice(null)}
        onRegisterBack={setStepBack}
        onLeave={() => toList(null)}
        onSave={async (change) => {
          await onUpdate(editing.id, change);
          await reload();
          toList(t('auth.roles.saved', { role: change.name ?? roleName(editing) }));
        }}
        onDelete={async () => {
          await onDelete(editing.id);
          await reload();
          toList(t('auth.roles.deleted', { role: roleName(editing) }));
        }}
      />
    );
  }

  const listState: ListState<StaffRole> =
    loaded.kind === 'loading'
      ? { kind: 'loading' }
      : loaded.kind === 'error'
        ? {
            kind: 'error',
            error: {
              title: t('core.errors.UNEXPECTED'),
              errorCode: 'UNEXPECTED',
              retryLabel: t('core.action.retry'),
              onRetry: () => void reload(),
            },
          }
        : {
            kind: 'ready',
            items: [
              ...editableRoles(loaded.directory),
              ...loaded.directory.roles.filter((role) => role.ownerRole),
            ],
          };

  return (
    <StaffShell
      title={t('auth.roles.title')}
      onBack={back}
      banner={
        notice === null ? undefined : (
          <Banner
            variant="info"
            message={notice}
            onDismiss={() => setNotice(null)}
            testID="roles-notice"
          />
        )
      }
      bottomAction={
        directory === null ? undefined : (
          <Button
            label={t('auth.roles.add')}
            onPress={() => {
              setNotice(null);
              setStep({ kind: 'add' });
            }}
            testID="roles-add"
          />
        )
      }
    >
      <View style={styles.list}>
        <List
          state={listState}
          keyExtractor={(role) => role.id}
          renderRow={(role) =>
            role.ownerRole ? (
              <ListRow
                primaryText={roleName(role)}
                secondaryText={t('auth.roles.ownersFixed')}
                trailing={<Icon name="lock" size={20} color={color.textMuted} />}
                testID={`roles-owner-${role.key}`}
              />
            ) : (
              <ListRow
                primaryText={roleName(role)}
                secondaryText={roleHint(role)}
                onPress={() => {
                  setNotice(null);
                  setStep({ kind: 'edit', roleId: role.id });
                }}
                testID={`roles-role-${role.id}`}
              />
            )
          }
          testID="roles-list"
        />
      </View>
    </StaffShell>
  );
}

function failureBanner(failure: StaffAdminFailure | null): React.ReactNode {
  return failure === null ? undefined : (
    <Banner
      variant={failure === 'offline' ? 'warning' : 'danger'}
      message={t(FAILURE_KEY[failure])}
      testID="roles-failure"
    />
  );
}

function AddRole({
  directory,
  onRegisterBack,
  onLeave,
  onCreate,
}: {
  readonly directory: StaffDirectory;
  readonly onRegisterBack: (back: (() => void) | null) => void;
  readonly onLeave: () => void;
  readonly onCreate: (name: string, copyFromRoleId: string) => Promise<void>;
}): React.JSX.Element {
  const sources = editableRoles(directory);
  const [name, setName] = useState('');
  const [from, setFrom] = useState<string | null>(sources[0]?.id ?? null);
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<StaffAdminFailure | null>(null);
  const problem = roleNameProblem(name, directory.roles, null);

  const leave = useLatestCallback(() => {
    if (!busy) onLeave();
  });
  useEffect(() => {
    onRegisterBack(() => leave);
    return () => onRegisterBack(null);
  }, [onRegisterBack, leave]);

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
    <StaffShell
      scrollable
      title={t('auth.roles.addTitle')}
      onBack={leave}
      banner={failureBanner(failure)}
      bottomAction={
        <Button label={t('auth.roles.create')} onPress={save} busy={busy} testID="roles-add-save" />
      }
    >
      <View style={styles.form}>
        <TextInput
          label={t('auth.roles.name')}
          value={name}
          onChangeText={(next) => {
            if (busy) return;
            setFailure(null);
            setName(next);
          }}
          autoCapitalize="words"
          autoCorrect={false}
          errorMessage={
            attempted && problem !== null
              ? t(NAME_PROBLEM_KEY[problem], { max: ROLE_NAME_MAX })
              : undefined
          }
          disabled={busy}
          testID="roles-add-name"
        />
        <View>
          <Text style={styles.label}>{t('auth.roles.copyFrom')}</Text>
          <Text style={styles.hint}>{t('auth.roles.copyFromHint')}</Text>
          <View style={styles.rows}>
            {sources.map((role) => (
              <ListRow
                key={role.id}
                primaryText={roleName(role)}
                secondaryText={roleHint(role)}
                selected={from === role.id}
                onPress={() => {
                  if (!busy) setFrom(role.id);
                }}
                testID={`roles-add-from-${role.id}`}
              />
            ))}
          </View>
        </View>
      </View>
    </StaffShell>
  );
}

function RoleEditor({
  role,
  directory,
  notice,
  onClearNotice,
  onRegisterBack,
  onLeave,
  onSave,
  onDelete,
}: {
  readonly role: StaffRole;
  readonly directory: StaffDirectory;
  readonly notice: string | null;
  readonly onClearNotice: () => void;
  readonly onRegisterBack: (back: (() => void) | null) => void;
  readonly onLeave: () => void;
  readonly onSave: (change: RoleChange) => Promise<void>;
  readonly onDelete: () => Promise<void>;
}): React.JSX.Element {
  const [draft, setDraft] = useState<RoleDraft>(() => roleDraftOf(role));
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<StaffAdminFailure | null>(null);
  const [ask, setAsk] = useState<'discard' | 'delete' | null>(null);

  const change = roleChangeOf(role, draft);
  const problem = role.custom ? roleNameProblem(draft.name, directory.roles, role.id) : null;
  const dirty = change !== null;
  const inUse = roleInUse(directory, role.id);

  const leave = useLatestCallback(() => {
    if (busy) return;
    if (ask !== null) setAsk(null);
    else if (dirty) setAsk('discard');
    else onLeave();
  });
  useEffect(() => {
    onRegisterBack(() => leave);
    return () => onRegisterBack(null);
  }, [onRegisterBack, leave]);

  const edit = (next: (current: RoleDraft) => RoleDraft): void => {
    if (busy) return;
    onClearNotice();
    setFailure(null);
    setDraft(next);
  };
  const run = (work: () => Promise<void>): void => {
    setBusy(true);
    setFailure(null);
    onClearNotice();
    work().catch((error: unknown) => {
      setBusy(false);
      setFailure(staffAdminFailure(error));
    });
  };
  const save = (): void => {
    setAttempted(true);
    if (problem !== null || busy) return;
    if (change === null) {
      onLeave();
      return;
    }
    run(() => onSave(change));
  };

  return (
    <StaffShell
      scrollable
      title={roleName(role)}
      onBack={leave}
      banner={
        failure !== null ? (
          failureBanner(failure)
        ) : notice !== null ? (
          <Banner variant="info" message={notice} onDismiss={onClearNotice} testID="roles-notice" />
        ) : undefined
      }
      bottomAction={
        <Button label={t('auth.roles.save')} onPress={save} busy={busy} testID="roles-save" />
      }
      overlay={
        ask === 'discard' ? (
          <ConfirmSheet
            title={t('auth.staff.discardTitle')}
            message={t('auth.staff.discardMessage')}
            confirmLabel={t('auth.staff.discard')}
            onConfirm={() => {
              setAsk(null);
              onLeave();
            }}
            cancelLabel={t('auth.staff.keepEditing')}
            onCancel={() => setAsk(null)}
            tone="destructive"
            testID="roles-discard"
          />
        ) : ask === 'delete' ? (
          <ConfirmSheet
            title={t('auth.roles.deleteTitle', { role: roleName(role) })}
            message={t('auth.roles.deleteMessage')}
            confirmLabel={t('auth.roles.delete')}
            onConfirm={() => {
              setAsk(null);
              run(onDelete);
            }}
            cancelLabel={t('core.action.cancel')}
            onCancel={() => setAsk(null)}
            tone="destructive"
            testID="roles-delete-confirm"
          />
        ) : null
      }
    >
      <View style={styles.form} testID={`roles-editor-${role.id}`}>
        <Text style={styles.intro}>{t('auth.roles.intro')}</Text>
        {role.custom ? (
          <TextInput
            label={t('auth.roles.name')}
            value={draft.name}
            onChangeText={(name) => edit((current) => ({ ...current, name }))}
            autoCapitalize="words"
            autoCorrect={false}
            errorMessage={
              attempted && problem !== null
                ? t(NAME_PROBLEM_KEY[problem], { max: ROLE_NAME_MAX })
                : undefined
            }
            disabled={busy}
            testID="roles-name"
          />
        ) : null}
        {GROUPS.map((group) => (
          <View key={group.id} testID={`roles-group-${group.id}`}>
            <Text style={styles.label}>{groupTitle(group.id)}</Text>
            <View style={styles.switches}>
              {group.abilities.map((ability) => (
                <SwitchRow
                  key={ability.id}
                  label={abilityLabel(ability.id)}
                  caption={abilityHint(ability.id)}
                  value={draft.on.has(ability.id)}
                  onValueChange={(value) =>
                    edit((current) => switchAbility(current, ability.id, value))
                  }
                  testID={`roles-ability-${ability.id}`}
                />
              ))}
            </View>
          </View>
        ))}
        {hasLimitableAbility(draft.on) || draft.limited ? (
          <View style={styles.switches}>
            <SwitchRow
              label={t('auth.roles.limited')}
              caption={t('auth.roles.limitedHint')}
              value={draft.limited}
              onValueChange={(limited) => edit((current) => ({ ...current, limited }))}
              testID="roles-limited"
            />
          </View>
        ) : null}
        {role.custom ? (
          <View style={styles.delete}>
            <View style={styles.edge}>
              <TextButton
                label={t('auth.roles.delete')}
                tone="danger"
                onPress={() => setAsk('delete')}
                disabled={busy || inUse}
                testID="roles-delete"
              />
            </View>
            {inUse ? <Text style={styles.hint}>{t('auth.roles.inUse')}</Text> : null}
          </View>
        ) : null}
      </View>
    </StaffShell>
  );
}

const styles = StyleSheet.create({
  list: { flex: 1, marginHorizontal: -space.lg },
  form: { paddingTop: space.md, gap: space.xl },
  intro: { ...type.body, color: color.textMuted },
  label: { ...type.bodyBold, color: color.text },
  hint: { ...type.bodySm, color: color.textMuted, marginTop: space.xs },
  rows: {
    marginHorizontal: -space.lg,
    marginTop: space.sm,
    borderTopWidth: border.hairline,
    borderTopColor: color.border,
  },
  switches: { marginTop: space.xs },
  delete: { gap: space.xs },
  // TextButtons carry their own padding; pull them back so the text lines up with the form's edge.
  edge: { alignItems: 'flex-start', marginLeft: -space.sm },
});
