/**
 * The pages behind "Karyawan" that are forms rather than the list: adding or changing a person, a
 * deactivated person's page, and the frame every step shares. Kept apart from `StaffScreen` because
 * these pages scroll inside the frame, while the list scrolls through its own `List`.
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
  ListRow,
  TextButton,
  TextInput,
  border,
  color,
  space,
  type,
  Text,
} from '@bolusi/ui';
import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useLatestCallback } from '../../hooks/useLatestCallback.js';
import { PinPerson } from '../pin/PinEntry.js';

import {
  FAILURE_KEY,
  formRoles,
  PROBLEM_KEY,
  staffChange,
  staffDraftProblem,
  toggleRole,
} from '@bolusi/device/models/staff/model';
import { roleHint, roleName } from '@bolusi/device/models/staff/roles';

/**
 * The add form, and an active person's page: name, roles, then (for an existing person) the ways
 * forward that are not edits. Problems show once the owner presses the primary, next to the field.
 */
export function PersonForm({
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
    <StaffShell
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
                primaryText={roleName(role)}
                secondaryText={roleHint(role)}
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
    </StaffShell>
  );
}

export function InactivePage({
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
    <StaffShell
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
    </StaffShell>
  );
}

/** The frame every step shares: a back arrow and no sync chip or avatar (a focused owner task). */
export function StaffShell({
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
  person: { alignItems: 'center', paddingTop: space['2xl'], gap: space.md },
  centred: { alignItems: 'center' },
  status: { ...type.body, color: color.textMuted, textAlign: 'center' },
});
