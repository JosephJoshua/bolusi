/**
 * "Karyawan" — the owner adds the people of their store, changes their name or roles, and
 * deactivates or reactivates them (owner decision 2026-10-27). Reached from Settings.
 *
 * ONLINE ONLY: each change is a server call (`StaffAdminPort`), and the screen waits until this
 * phone's directory has the result, so the list never shows something the server refused. Offline
 * the change is refused at once with the reason, and nothing is half done.
 *
 * A new person has no PIN. Right after adding, the owner is offered "Buat PIN sekarang", which opens
 * the existing "PIN karyawan" hand-over for that person (`onMakePin`): one PIN flow, not two.
 */
import {
  staffAdminFailure,
  type StaffActor,
  type StaffAdminFailure,
  type StaffDirectory,
  type StaffDraft,
  type StaffMember,
} from '@bolusi/core';
import { t } from '@bolusi/i18n';
import {
  AppShell,
  Banner,
  Button,
  Chip,
  ConfirmSheet,
  List,
  ListRow,
  OutcomeState,
  TextButton,
  TextInput,
  border,
  color,
  space,
  type,
  type ListState,
} from '@bolusi/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useLatestCallback } from '../../hooks/useLatestCallback.js';
import type { SurfaceNav } from '../../navigation/surface.js';
import { PinPerson } from '../pin/PinEntry.js';
import { UserRow } from '../switcher/UserRow.js';

import {
  FAILURE_KEY,
  formRoles,
  hasOtherStaff,
  PROBLEM_KEY,
  ROLE_HINT_KEY,
  staffChange,
  staffDraftProblem,
  staffListItems,
  toggleRole,
  type StaffListItem,
  type StaffStep,
} from './model.js';

export interface StaffScreenProps {
  readonly actor: StaffActor;
  /** Read the staff list from this phone's directory. */
  readonly load: () => Promise<StaffDirectory>;
  /** Add a person. Resolves once the server has them and this phone's directory was refreshed;
   *  REJECTS with a `StaffAdminError`. */
  readonly onCreate: (draft: StaffDraft) => Promise<{ readonly userId: string }>;
  readonly onUpdate: (
    userId: string,
    change: { readonly name?: string; readonly roleIds?: readonly string[] },
  ) => Promise<void>;
  readonly onSetActive: (userId: string, active: boolean) => Promise<void>;
  /** Open "PIN karyawan" at this person's hand-over. Absent when the owner may not reset PINs. */
  readonly onMakePin?: ((userId: string) => void) | undefined;
  readonly onClose: () => void;
  /** Publishes this screen's own back, so Android's back button steps back inside the flow. */
  readonly onRegisterSurfaceNav?: ((nav: SurfaceNav | null) => void) | undefined;
}

type Loaded =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error' }
  | { readonly kind: 'ready'; readonly directory: StaffDirectory };

export function StaffScreen({
  actor,
  load,
  onCreate,
  onUpdate,
  onSetActive,
  onMakePin,
  onClose,
  onRegisterSurfaceNav,
}: StaffScreenProps): React.JSX.Element {
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [step, setStep] = useState<StaffStep>({ kind: 'list' });
  /** What the last change did, said on the list it returns to. */
  const [notice, setNotice] = useState<string | null>(null);

  const latestLoad = useLatestCallback(load);
  const reload = useCallback(async (): Promise<StaffDirectory | null> => {
    try {
      const directory = await latestLoad();
      setLoaded({ kind: 'ready', directory });
      return directory;
    } catch {
      setLoaded({ kind: 'error' });
      return null;
    }
  }, [latestLoad]);
  useEffect(() => {
    void reload();
  }, [reload]);

  /** A step's own back: forms with unsaved changes ask first (see `PersonForm`). */
  const [stepBack, setStepBack] = useState<(() => void) | null>(null);
  const back = (): void => {
    if (stepBack !== null) stepBack();
    else if (step.kind !== 'list') setStep({ kind: 'list' });
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

  const finish = (message: string | null): void => {
    setStepBack(null);
    setNotice(message);
    setStep({ kind: 'list' });
  };

  const directory = loaded.kind === 'ready' ? loaded.directory : null;
  const member = (id: string): StaffMember | undefined =>
    directory?.members.find((m) => m.id === id);

  // A person who left this store's directory while their page was open (a sync, another owner):
  // back to the list rather than a page about nobody.
  const missing =
    directory !== null &&
    (step.kind === 'edit' || step.kind === 'inactive') &&
    !directory.members.some((m) => m.id === step.id);
  useEffect(() => {
    if (missing) finish(null);
  });

  // ── Just added ─────────────────────────────────────────────────────────────────────────────────
  if (step.kind === 'added') {
    // Present on this phone once the directory refreshed; otherwise the next sync brings them.
    const here = member(step.id) !== undefined;
    const canPin = here && onMakePin !== undefined;
    return (
      <Shell
        title={t('auth.staff.addTitle')}
        onBack={() => finish(null)}
        bottomAction={
          canPin ? (
            <View style={styles.answers}>
              <View style={styles.answer}>
                <Button
                  label={t('auth.staff.later')}
                  variant="secondary"
                  onPress={() => finish(null)}
                  testID="staff-added-later"
                />
              </View>
              <View style={styles.answer}>
                <Button
                  label={t('auth.staff.makePinNow')}
                  onPress={() => onMakePin(step.id)}
                  testID="staff-added-pin"
                />
              </View>
            </View>
          ) : (
            <Button
              label={t('auth.pin.staff.finish')}
              onPress={() => finish(null)}
              testID="staff-added-done"
            />
          )
        }
      >
        <OutcomeState
          tone="success"
          icon="success"
          title={t('auth.staff.addedTitle', { name: step.name })}
          message={
            here ? t('auth.staff.addedBody') : t('auth.staff.notYetHere', { name: step.name })
          }
          testID="staff-added"
        />
      </Shell>
    );
  }

  // ── Add, or one active person's page ───────────────────────────────────────────────────────────
  if (directory !== null && !missing && (step.kind === 'add' || step.kind === 'edit')) {
    const editing = step.kind === 'edit' ? member(step.id) : undefined;
    return (
      <PersonForm
        key={editing?.id ?? 'new'}
        directory={directory}
        actor={actor}
        editing={editing ?? null}
        onRegisterBack={setStepBack}
        onCancel={() => finish(null)}
        onCreate={async (draft) => {
          const { userId } = await onCreate(draft);
          await reload();
          setStepBack(null);
          setStep({ kind: 'added', id: userId, name: draft.name.trim() });
        }}
        onUpdate={async (userId, change) => {
          await onUpdate(userId, change);
          await reload();
          finish(t('auth.staff.saved'));
        }}
        onDeactivate={async (target) => {
          await onSetActive(target.id, false);
          await reload();
          finish(t('auth.staff.deactivated', { name: target.name }));
        }}
        onMakePin={onMakePin}
      />
    );
  }

  // ── A deactivated person ───────────────────────────────────────────────────────────────────────
  const inactive = step.kind === 'inactive' ? member(step.id) : undefined;
  if (inactive !== undefined) {
    const target = inactive;
    return (
      <InactivePage
        target={target}
        onBack={() => finish(null)}
        onReactivate={async () => {
          await onSetActive(target.id, true);
          await reload();
          finish(t('auth.staff.reactivated', { name: target.name }));
        }}
      />
    );
  }

  // ── The list ───────────────────────────────────────────────────────────────────────────────────
  const listState: ListState<StaffListItem> =
    loaded.kind === 'loading'
      ? { kind: 'loading' }
      : loaded.kind === 'error' || directory === null
        ? {
            kind: 'error',
            error: {
              title: t('core.errors.UNEXPECTED'),
              errorCode: 'UNEXPECTED',
              retryLabel: t('core.action.retry'),
              onRetry: () => void reload(),
            },
          }
        : !hasOtherStaff(directory, actor)
          ? {
              kind: 'empty',
              empty: { title: t('auth.staff.empty'), hint: t('auth.staff.emptyBody') },
            }
          : { kind: 'ready', items: staffListItems(directory, actor) };

  return (
    <Shell
      title={t('auth.staff.title')}
      onBack={back}
      banner={
        notice === null ? undefined : (
          <Banner
            variant="info"
            message={notice}
            onDismiss={() => setNotice(null)}
            testID="staff-notice"
          />
        )
      }
      bottomAction={
        directory === null ? undefined : (
          <Button
            label={t('auth.staff.add')}
            onPress={() => {
              setNotice(null);
              setStep({ kind: 'add' });
            }}
            testID="staff-add"
          />
        )
      }
    >
      <View style={styles.list}>
        <List
          state={listState}
          keyExtractor={(item) => (item.kind === 'member' ? item.member.id : 'inactive')}
          renderRow={(item) =>
            item.kind === 'inactiveHeading' ? (
              <Text
                style={styles.heading}
                accessibilityRole="header"
                testID="staff-inactive-heading"
              >
                {t('auth.staff.inactiveSection')}
              </Text>
            ) : (
              <MemberRow
                item={item}
                onOpen={(next) => {
                  setNotice(null);
                  setStep(next);
                }}
              />
            )
          }
          testID="staff-list"
        />
      </View>
    </Shell>
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
  // One status at most, the one that needs the owner: you, a missing PIN, or deactivated.
  const status = self ? (
    <Chip label={t('auth.staff.you')} icon="staff" testID={`staff-you-${member.id}`} />
  ) : !member.active ? (
    <Chip label={t('auth.staff.inactive')} icon="lock" testID={`staff-inactive-${member.id}`} />
  ) : !member.hasPin ? (
    <Chip
      label={t('auth.staff.noPin')}
      icon="pin"
      tone="warning"
      testID={`staff-nopin-${member.id}`}
    />
  ) : undefined;
  return (
    <UserRow
      id={member.id}
      name={member.name}
      roleKeys={member.roleKeys}
      status={status}
      onPress={open === null ? undefined : () => onOpen(open)}
      testID={`staff-member-${member.id}`}
    />
  );
}

/**
 * The add form, and an active person's page: name, roles, then (for an existing person) the ways
 * forward that are not edits. Problems show once the owner presses the primary, next to the field.
 */
function PersonForm({
  directory,
  actor,
  editing,
  onRegisterBack,
  onCancel,
  onCreate,
  onUpdate,
  onDeactivate,
  onMakePin,
}: {
  readonly directory: StaffDirectory;
  readonly actor: StaffActor;
  readonly editing: StaffMember | null;
  readonly onRegisterBack: (back: (() => void) | null) => void;
  readonly onCancel: () => void;
  readonly onCreate: (draft: StaffDraft) => Promise<void>;
  readonly onUpdate: (
    userId: string,
    change: { readonly name?: string; readonly roleIds?: readonly string[] },
  ) => Promise<void>;
  readonly onDeactivate: (member: StaffMember) => Promise<void>;
  readonly onMakePin?: ((userId: string) => void) | undefined;
}): React.JSX.Element {
  const [draft, setDraft] = useState<StaffDraft>(() => ({
    name: editing?.name ?? '',
    roleIds: editing?.roleIds ?? [],
  }));
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<StaffAdminFailure | null>(null);
  const [sheet, setSheet] = useState<'discard' | 'deactivate' | null>(null);

  const roles = useMemo(
    () => formRoles(directory, actor, editing?.roleIds ?? []),
    [directory, actor, editing],
  );
  const problem = staffDraftProblem(draft, directory.members, editing?.id ?? null);
  const change = editing === null ? null : staffChange(editing, draft);
  const dirty =
    editing === null ? draft.name.trim() !== '' || draft.roleIds.length > 0 : change !== null;

  // The header arrow and Android's back both come here: unsaved changes ask first.
  const leave = useLatestCallback(() => {
    if (busy) return;
    if (sheet !== null) setSheet(null);
    else if (dirty) setSheet('discard');
    else onCancel();
  });
  useEffect(() => {
    onRegisterBack(() => leave);
    return () => onRegisterBack(null);
  }, [onRegisterBack, leave]);

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
    if (problem !== null) return;
    if (editing === null) {
      run(() => onCreate({ name: draft.name.trim(), roleIds: draft.roleIds }));
    } else if (change === null) {
      onCancel();
    } else {
      run(() => onUpdate(editing.id, change));
    }
  };

  const nameProblem =
    attempted && problem !== null && problem !== 'roleMissing'
      ? t(PROBLEM_KEY[problem])
      : undefined;
  const testID = editing === null ? 'staff-add-form' : 'staff-edit-form';

  return (
    <Shell
      scrollable
      title={t(editing === null ? 'auth.staff.addTitle' : 'auth.staff.editTitle')}
      onBack={leave}
      banner={
        failure === null ? undefined : (
          <Banner
            variant={failure === 'offline' ? 'warning' : 'danger'}
            message={t(FAILURE_KEY[failure])}
            testID={`${testID}-failure`}
          />
        )
      }
      bottomAction={
        <Button
          label={t(editing === null ? 'auth.staff.add' : 'auth.staff.save')}
          onPress={save}
          busy={busy}
          testID={`${testID}-save`}
        />
      }
      overlay={
        sheet === 'discard' ? (
          <ConfirmSheet
            title={t('auth.staff.discardTitle')}
            message={t('auth.staff.discardMessage')}
            confirmLabel={t('auth.staff.discard')}
            onConfirm={() => {
              setSheet(null);
              onCancel();
            }}
            cancelLabel={t('auth.staff.keepEditing')}
            onCancel={() => setSheet(null)}
            tone="destructive"
            testID={`${testID}-discard`}
          />
        ) : sheet === 'deactivate' && editing !== null ? (
          <ConfirmSheet
            title={t('auth.staff.deactivateTitle', { name: editing.name })}
            message={t('auth.staff.deactivateBody')}
            confirmLabel={t('auth.staff.deactivateConfirm')}
            onConfirm={() => {
              setSheet(null);
              run(() => onDeactivate(editing));
            }}
            cancelLabel={t('core.action.cancel')}
            onCancel={() => setSheet(null)}
            tone="destructive"
            testID="staff-deactivate-confirm"
          />
        ) : null
      }
    >
      <View style={styles.form} testID={testID}>
        <View>
          <TextInput
            label={t('auth.staff.name')}
            value={draft.name}
            onChangeText={(name) => {
              setFailure(null);
              setDraft((d) => ({ ...d, name }));
            }}
            autoCapitalize="words"
            autoCorrect={false}
            errorMessage={nameProblem}
            disabled={busy}
            testID={`${testID}-name`}
          />
          {nameProblem === undefined ? (
            <Text style={styles.hint}>{t('auth.staff.nameHint')}</Text>
          ) : null}
        </View>

        <View>
          <Text style={styles.label}>{t('auth.staff.roles')}</Text>
          <Text style={styles.hint}>{t('auth.staff.rolesHint')}</Text>
          <View style={styles.rows}>
            {roles.map((role) => (
              <ListRow
                key={role.id}
                primaryText={t(`role.${role.key}.name` as 'role.cashier.name')}
                secondaryText={t(ROLE_HINT_KEY[role.key])}
                checked={draft.roleIds.includes(role.id)}
                onPress={() => {
                  if (busy) return;
                  setFailure(null);
                  setDraft((d) => ({ ...d, roleIds: toggleRole(d.roleIds, role.id) }));
                }}
                testID={`${testID}-role-${role.key}`}
              />
            ))}
          </View>
          {attempted && problem === 'roleMissing' ? (
            <Text style={styles.error} testID={`${testID}-role-problem`}>
              {t(PROBLEM_KEY.roleMissing)}
            </Text>
          ) : null}
        </View>

        {editing === null ? null : (
          <View style={styles.more}>
            {editing.hasPin || onMakePin === undefined ? null : (
              <View style={styles.pinNote} testID="staff-edit-nopin">
                <Text style={styles.hint}>{t('auth.staff.makePinHint')}</Text>
                <View style={styles.edge}>
                  <TextButton
                    label={t('auth.staff.makePin')}
                    icon="pin"
                    onPress={() => onMakePin(editing.id)}
                    disabled={busy}
                    testID="staff-edit-make-pin"
                  />
                </View>
              </View>
            )}
            {/* Destructive, so set apart at the end and confirmed (design guide §2). */}
            <View style={[styles.edge, styles.danger]}>
              <TextButton
                label={t('auth.staff.deactivate')}
                tone="danger"
                onPress={() => setSheet('deactivate')}
                disabled={busy}
                testID="staff-deactivate"
              />
            </View>
          </View>
        )}
      </View>
    </Shell>
  );
}

function InactivePage({
  target,
  onBack,
  onReactivate,
}: {
  readonly target: StaffMember;
  readonly onBack: () => void;
  readonly onReactivate: () => Promise<void>;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<StaffAdminFailure | null>(null);
  return (
    <Shell
      title={t('auth.staff.title')}
      onBack={() => (busy ? undefined : onBack())}
      banner={
        failure === null ? undefined : (
          <Banner
            variant={failure === 'offline' ? 'warning' : 'danger'}
            message={t(FAILURE_KEY[failure])}
            testID="staff-inactive-failure"
          />
        )
      }
      bottomAction={
        <Button
          label={t('auth.staff.reactivate')}
          busy={busy}
          onPress={() => {
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
          testID="staff-reactivate"
        />
      }
    >
      <View style={styles.person} testID="staff-inactive-page">
        <PinPerson person={target} testID="staff-inactive-person" />
        <View style={styles.centred}>
          <Chip label={t('auth.staff.inactive')} icon="lock" />
        </View>
        <Text style={styles.status}>{t('auth.staff.inactiveBody')}</Text>
      </View>
    </Shell>
  );
}

/** The frame every step shares: a back arrow and no sync chip or avatar (a focused owner task). */
function Shell({
  title,
  onBack,
  scrollable = false,
  banner,
  bottomAction,
  overlay,
  children,
}: {
  readonly title: string;
  readonly onBack: () => void;
  readonly scrollable?: boolean;
  readonly banner?: React.ReactNode;
  readonly bottomAction?: React.ReactNode;
  readonly overlay?: React.ReactNode;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <AppShell
      scrollable={scrollable}
      title={title}
      titleVariant="detail"
      onBack={onBack}
      backLabel={t('core.action.back')}
      syncChip={null}
      avatar={<View testID="staff-no-avatar" />}
      banner={banner}
      bottomAction={bottomAction}
      overlay={overlay}
      testID="staff-screen"
    >
      {children}
    </AppShell>
  );
}

const styles = StyleSheet.create({
  list: { flex: 1, marginHorizontal: -space.lg },
  heading: {
    ...type.bodyBold,
    color: color.text,
    paddingHorizontal: space.lg,
    paddingTop: space.xl,
    paddingBottom: space.xs,
  },
  form: { paddingTop: space.md, gap: space.xl },
  label: { ...type.bodyBold, color: color.text },
  hint: { ...type.bodySm, color: color.textMuted, marginTop: space.xs },
  error: { ...type.bodySm, color: color.danger, marginTop: space.sm },
  rows: {
    marginHorizontal: -space.lg,
    marginTop: space.sm,
    borderTopWidth: border.hairline,
    borderTopColor: color.border,
  },
  more: { gap: space.lg },
  pinNote: { gap: space.xs },
  // TextButtons carry their own padding; pull them back so the text lines up with the form's edge.
  edge: { alignItems: 'flex-start', marginLeft: -space.sm },
  danger: { marginTop: space.lg },
  answers: { flexDirection: 'row', gap: space.sm },
  answer: { flex: 1 },
  person: { alignItems: 'center', paddingTop: space['2xl'], gap: space.md },
  centred: { alignItems: 'center' },
  status: { ...type.body, color: color.textMuted, textAlign: 'center' },
});
