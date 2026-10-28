/**
 * "Karyawan" — the owner adds the people of their store, changes their name or roles, and
 * deactivates or reactivates them (owner decision 2026-10-27). Reached from Settings.
 *
 * ONLINE ONLY: each change is a server call (`StaffAdminPort`), and the screen waits until this
 * phone's directory has the result, so the list never shows something the server refused. Offline
 * the change is refused at once with the reason, and nothing is half done.
 *
 * A new person has no PIN. Right after adding, the owner is offered "Buat PIN", which opens
 * the existing "PIN karyawan" hand-over for that person (`onMakePin`): one PIN flow, not two.
 */
import {
  type StaffActor,
  type StaffDirectory,
  type StaffDraft,
  type StaffMember,
} from '@bolusi/core';
import { t } from '@bolusi/i18n';
import {
  Banner,
  Button,
  Chip,
  List,
  OutcomeState,
  color,
  space,
  type,
  type ListState,
} from '@bolusi/ui';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useLatestCallback } from '../../hooks/useLatestCallback.js';
import type { SurfaceNav } from '../../navigation/surface.js';
import { UserRow } from '../switcher/UserRow.js';

import {
  hasOtherStaff,
  staffListItems,
  type StaffListItem,
  type StaffStep,
} from '@bolusi/device/models/staff/model';
import { InactivePage, PersonForm, StaffShell } from './StaffPages.js';

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
      <StaffShell
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
      </StaffShell>
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
    <StaffShell
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
    </StaffShell>
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

const styles = StyleSheet.create({
  list: { flex: 1, marginHorizontal: -space.lg },
  heading: {
    ...type.bodyBold,
    color: color.text,
    paddingHorizontal: space.lg,
    paddingTop: space.xl,
    paddingBottom: space.xs,
  },
  answers: { flexDirection: 'row', gap: space.sm },
  answer: { flex: 1 },
});
