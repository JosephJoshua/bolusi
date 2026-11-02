// What the window shows: opening the data, registering the PC, choosing who is here and their PIN,
// then the counter. Which one is a pure function of the core's state (the phone's `resolveZone`), so
// a lock or a blocked PC can never leave someone's work on screen.
import { derivePinAuthState, type HeldPhone, type StaffDirectory } from '@bolusi/core';
import type { PinOutcome } from '@bolusi/device/bootstrap/session';
import type { StaffControls } from '@bolusi/device/bootstrap/staff';
import type { PinTargetUser } from '@bolusi/device/models/pin/pin-target';
import type { LoginResult } from '@bolusi/device/models/enrollment/model';
import { tapTarget, type SwitcherUser } from '@bolusi/device/models/switcher/model';
import { resolveZone } from '@bolusi/device/navigation/zone';
import { withDraft, type UserWorkspace } from '@bolusi/device/state/user-workspaces';
import { getLocale, setLocale, t, translateRoleKey } from '@bolusi/i18n';
import { REPAIR_MODULE_ID, parseIntakeDraft } from '@bolusi/modules/repair';
import { RepairRuntimeProvider, type IntakeDraft } from '@bolusi/modules/repair/desktop';
import { dataArriving } from '@bolusi/device/models/sync-status/model';
import { setDataArriving, Spinner, StatePanel } from '@bolusi/ui-web';
import { CircleAlert, Lock, Users } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { CoreState, SessionView } from '../core/api.js';
import type { Client } from '../main/rpc.js';

import { EnrolScreen } from './auth/EnrolScreen.js';
import { AuthLayout } from './auth/AuthLayout.js';
import { FirstPinScreen, PinScreen, type PinSubmitResult } from './auth/PinScreen.js';
import { SwitcherScreen } from './auth/SwitcherScreen.js';
import { createCaptureDialogs, type CaptureDialogs } from './capture-dialogs.js';
import { CloseGuard } from './close-guard.js';
import { windowHandoff } from './phone-handoff.js';
import type { PcCapture } from './capture.js';
import { createCoreRepairRuntime } from './core-runtime.js';
import type { SettingsAccess } from './settings/access.js';
import { Counter } from './Counter.js';
import {
  DEMO_PEOPLE,
  DEMO_STORE_NAME,
  demoRuntimeFor,
  demoStaffFor,
  type DemoPerson,
} from './demo.js';
import { SyncStatusButton } from './SyncStatus.js';
import { useReportBusy } from './updates.js';
import { useCore } from './use-core.js';

/** How often typing and clicking count as "still here" for the idle lock. */
const ACTIVITY_EVERY_MS = 5_000;
/**
 * How long a photo or signature being waited for (the customer signing on the paired phone) keeps
 * the idle lock away without a click: a hand-off takes minutes, a PC left open must still lock.
 */
const CAPTURE_KEEPS_AWAKE_MS = 15 * 60_000;

export function App(): React.JSX.Element {
  // The webcam, signature and phone dialogs, once for the window; leaving the counter backs out.
  const [dialogs] = useState(() => createCaptureDialogs(windowHandoff()));
  useReportBusy();
  return (
    <>
      <Gate dialogs={dialogs} />
      <dialogs.Host />
      <CloseGuard />
    </>
  );
}

function Gate({ dialogs }: { readonly dialogs: CaptureDialogs }): React.JSX.Element {
  const core = useCore();
  const capture = dialogs.capture;
  if (core.mode === 'demo') return <DemoApp capture={capture} />;
  if (core.mode === 'connecting') return <BootScreen failed={false} />;
  if (core.mode === 'unavailable') return <BootScreen failed />;
  const { state } = core;
  if (state === null || state.phase === 'booting') return <BootScreen failed={false} />;
  if (state.phase === 'failed') return <BootScreen failed />;
  return <LiveApp client={core.client} state={state} dialogs={dialogs} />;
}

function BootScreen({ failed }: { readonly failed: boolean }): React.JSX.Element {
  return (
    <AuthLayout testId={failed ? 'boot.failed' : 'boot'}>
      {failed ? (
        <StatePanel
          icon={CircleAlert}
          tone="danger"
          title={t('auth.pc.openFailed')}
          hint={t('auth.pc.openFailedHint')}
        />
      ) : (
        <div className="flex flex-col items-center gap-4 py-6 text-center">
          <Spinner size={28} />
          <p className="text-body text-text-muted">{t('auth.pc.opening')}</p>
        </div>
      )}
    </AuthLayout>
  );
}

function roleOf(user: SwitcherUser | undefined): string {
  const names = user?.roleKeys.map((key) => translateRoleKey(key)) ?? [];
  return names.filter((name) => name !== null).join(', ');
}

function LiveApp({
  client,
  state,
  dialogs,
}: {
  readonly client: Client;
  readonly state: CoreState;
  readonly dialogs: CaptureDialogs;
}): React.JSX.Element {
  const capture = dialogs.capture;
  const session = state.session;
  const active = session?.active ?? null;
  const [pinFor, setPinFor] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [reenrolling, setReenrolling] = useState(false);
  const zone = resolveZone({
    device: state.device,
    session: active,
    locked: session?.locked ?? false,
    pinFor,
    reenrolling,
    switching,
    route: 'home',
  });

  // Tables read it: while a new PC's first sync brings the store's data, empty is loading.
  const arriving = state.sync !== null && dataArriving(state.sync);
  useEffect(() => setDataArriving(arriving), [arriving]);

  // A new session (or none) starts from a clean gate: no half-open switch from before.
  const activeUserId = active?.userId ?? null;
  useEffect(() => {
    setSwitching(false);
    setPinFor(null);
  }, [activeUserId]);

  // The people list is read again each time it shows, so a colleague added on another device is there.
  const showingSwitcher = zone.kind === 'switcher';
  useEffect(() => {
    if (showingSwitcher) client.call('session.refresh').catch(() => undefined);
  }, [client, showingSwitcher]);

  // Typing and clicking keep the idle lock away, as touches do on the phone.
  useEffect(() => {
    let last = 0;
    const onActivity = (): void => {
      const now = Date.now();
      if (now - last < ACTIVITY_EVERY_MS) return;
      last = now;
      client.call('session.recordActivity').catch(() => undefined);
    };
    window.addEventListener('pointerdown', onActivity, true);
    window.addEventListener('keydown', onActivity, true);
    // Waiting on the customer to sign or a photo from the phone is being here too, for a while.
    const waiting = window.setInterval(() => {
      const since = dialogs.waitingSince();
      if (since !== null && Date.now() - since < CAPTURE_KEEPS_AWAKE_MS) onActivity();
    }, ACTIVITY_EVERY_MS);
    return () => {
      window.removeEventListener('pointerdown', onActivity, true);
      window.removeEventListener('keydown', onActivity, true);
      window.clearInterval(waiting);
    };
  }, [client, dialogs]);

  // Locked or switched: whatever was being captured is backed out of, not left over the lock.
  const inShell = zone.kind === 'shell';
  useEffect(() => {
    if (!inShell) dialogs.cancel();
  }, [inShell, dialogs]);

  const storeName = state.deviceInfo?.storeName ?? null;
  const users = session?.users ?? null;

  switch (zone.kind) {
    case 'enrollment':
      return (
        <EnrolScreen
          key={zone.revoked ? 'revoked' : 'enrol'}
          revoked={zone.revoked}
          onCancel={zone.voluntary ? () => setReenrolling(false) : undefined}
          calls={{
            login: (request) => client.call<LoginResult>('enrollment.login', request),
            enroll: (request) => client.call<void>('enrollment.enroll', request),
            heldPhone: () => client.call<HeldPhone | null>('enrollment.heldPhone'),
            finish() {
              setReenrolling(false);
              client.call('enrollment.finish').catch(() => undefined);
            },
          }}
        />
      );
    case 'switcher': {
      const current = users?.find((user) => user.id === activeUserId);
      return (
        <SwitcherScreen
          storeName={storeName}
          users={users}
          usersError={session?.usersError ?? null}
          pinRows={session?.pinRows ?? {}}
          locked={zone.mode === 'lock'}
          current={current === undefined ? null : { id: current.id, name: current.name }}
          onPick={(user) => setPinFor(user.id)}
          onBack={() => setSwitching(false)}
          onReenrol={() => setReenrolling(true)}
        />
      );
    }
    case 'pin':
      return (
        <PinGate
          client={client}
          storeName={storeName}
          user={users?.find((user) => user.id === zone.userId)}
          session={session}
          onOpened={() => {
            setPinFor(null);
            setSwitching(false);
          }}
          onBack={() => setPinFor(null)}
        />
      );
    case 'shell':
      if (session === null || active === null) return <BootScreen failed={false} />;
      return (
        <LiveCounter
          key={active.userId}
          client={client}
          state={state}
          session={session}
          userId={active.userId}
          user={users?.find((user) => user.id === active.userId)}
          capture={capture}
          onSwitch={() => setSwitching(true)}
          onReenrol={() => setReenrolling(true)}
        />
      );
  }
}

function PinGate({
  client,
  storeName,
  user,
  session,
  onOpened,
  onBack,
}: {
  readonly client: Client;
  readonly storeName: string | null;
  readonly user: SwitcherUser | undefined;
  readonly session: SessionView | null;
  readonly onOpened: () => void;
  readonly onBack: () => void;
}): React.JSX.Element {
  // Someone removed from the list while their PIN pad was open goes back to the list.
  const missing = user === undefined;
  useEffect(() => {
    if (missing) onBack();
  }, [missing, onBack]);
  if (user === undefined) return <BootScreen failed={false} />;

  const submit = async (pin: string): Promise<PinSubmitResult> => {
    const outcome = await client.call<PinOutcome>('session.submitPin', user.id, pin);
    switch (outcome.kind) {
      case 'opened':
        onOpened();
        return 'opened';
      case 'wrong':
        return 'wrong';
      case 'gated':
        return 'gated';
      case 'needs_first_pin':
        return 'needsFirstPin';
    }
  };

  if (tapTarget(user).kind === 'firstPinSetup') {
    return (
      <FirstPinScreen
        key={user.id}
        storeName={storeName}
        user={user}
        onSwitchUser={onBack}
        onSave={async (pin) => {
          await client.call('session.setFirstPin', user.id, pin);
          if ((await submit(pin)) !== 'opened')
            throw new Error('the new PIN did not open a session');
        }}
      />
    );
  }
  return (
    <PinScreen
      key={user.id}
      storeName={storeName}
      user={user}
      row={session?.pinRows[user.id] ?? null}
      onSubmit={submit}
      onSwitchUser={onBack}
    />
  );
}

function LiveCounter({
  client,
  state,
  session,
  userId,
  user,
  capture,
  onSwitch,
  onReenrol,
}: {
  readonly client: Client;
  readonly state: CoreState;
  readonly session: SessionView;
  readonly userId: string;
  readonly user: SwitcherUser | undefined;
  readonly capture: PcCapture;
  readonly onSwitch: () => void;
  readonly onReenrol: () => void;
}): React.JSX.Element {
  const storeName = state.deviceInfo?.storeName ?? '';
  // Locking or switching away closes an open capture: nothing of this person's stays on screen,
  // and a phone still recording for it is told the computer stopped waiting instead of "sent".
  useEffect(() => () => capture.backOut(), [capture]);
  // A new runtime when the person's grants change, so every screen re-derives what it offers.
  const grants = JSON.stringify({
    permissions: session.permissions,
    colleaguePermissions: session.colleaguePermissions,
    limits: session.limits,
  });
  const runtime = useMemo(
    () =>
      createCoreRepairRuntime({
        client,
        session: JSON.parse(grants) as Pick<
          SessionView,
          'permissions' | 'colleaguePermissions' | 'limits'
        >,
        userId,
        storeName,
        capture,
        statusSite: state.statusSite,
      }),
    [client, grants, userId, storeName, capture, state.statusSite],
  );

  const settings = useSettingsAccess(client, state, session, userId);
  const users = session.users;
  const nameOf = useCallback(
    (id: string) => users?.find((other) => other.id === id)?.name ?? null,
    [users],
  );
  const [syncOpen, setSyncOpen] = useState(false);

  // The intake in progress belongs to this PC (Joseph, 2026-10-31): it survives a lock, a switch
  // to a colleague and a restart, and whoever signs in next may carry on with it. One kept in this
  // person's own workspace by an older version still comes back, and moves to the PC on its next
  // change.
  const workspace = session.workspace?.ownerUserId === userId ? session.workspace : null;
  const deviceDraft = session.deviceDrafts?.[REPAIR_MODULE_ID];
  const restoredDraft = useMemo<IntakeDraft | null>(
    () =>
      parseIntakeDraft(deviceDraft) ??
      (workspace === null ? null : parseIntakeDraft(workspace.drafts[REPAIR_MODULE_ID])),
    [deviceDraft, workspace],
  );
  // The core's copy arrives a moment after each write; a write repeating the last one is skipped.
  const sent = useRef<string>(JSON.stringify(deviceDraft ?? null));
  const legacy = useRef<UserWorkspace | null>(
    workspace !== null && workspace.drafts[REPAIR_MODULE_ID] !== undefined ? workspace : null,
  );
  const onDraftChange = useCallback(
    (draft: IntakeDraft | null) => {
      const held = legacy.current;
      if (held !== null) {
        legacy.current = null;
        client
          .call('session.updateWorkspace', withDraft(held, REPAIR_MODULE_ID, null))
          .catch(() => undefined);
      }
      const json = JSON.stringify(draft);
      if (json === sent.current) return;
      sent.current = json;
      client.call('session.updateDeviceDraft', REPAIR_MODULE_ID, draft).catch(() => undefined);
    },
    [client],
  );

  return (
    <RepairRuntimeProvider runtime={runtime}>
      <Counter
        storeName={storeName}
        person={{ userId, name: user?.name ?? '', role: roleOf(user) }}
        nameOf={nameOf}
        menuItems={[
          { key: 'switch', label: t('core.account.switchUser'), icon: Users, onSelect: onSwitch },
          {
            key: 'lock',
            label: t('auth.pc.lock'),
            icon: Lock,
            onSelect: () => void client.call('session.lock').catch(() => undefined),
          },
        ]}
        sync={
          state.sync === null ? null : (
            <SyncStatusButton
              input={state.sync}
              open={syncOpen}
              onOpenChange={setSyncOpen}
              onSyncNow={() => void client.call('sync.requestManual').catch(() => undefined)}
              onMarkRejectedHandled={(opIds) =>
                void client.call('sync.markRejectedHandled', opIds).catch(() => undefined)
              }
              onReenrol={onReenrol}
            />
          )
        }
        onOpenSyncStatus={() => setSyncOpen(true)}
        settings={settings}
        restoredDraft={restoredDraft}
        onDraftChange={onDraftChange}
        setupPending={state.setupFor === userId}
        onSetupDone={() => void client.call('device.finishSetup').catch(() => undefined)}
      />
    </RepairRuntimeProvider>
  );
}

/**
 * What Settings may do for the person signed in, each part only when the core says they may: their
 * own PIN always, colleagues' PINs with unlock or reset, "Karyawan" with staff rights. Every call
 * names the person, and the core refuses it for anyone else.
 */
function useSettingsAccess(
  client: Client,
  state: CoreState,
  session: SessionView,
  userId: string,
): SettingsAccess {
  const {
    canUnlock,
    canReset,
    canManageStaff,
    canSetLimits,
    canRenameDevice,
    tenantAdmin,
    pinRows,
  } = session;
  // Colleagues whose PIN is locked here, from the same lockout machine as the PIN pad.
  const lockedCount = Object.entries(pinRows).filter(
    ([id, row]) => id !== userId && derivePinAuthState(row) === 'locked_out',
  ).length;
  const device = state.deviceInfo;
  return useMemo((): SettingsAccess => {
    const call = <T,>(method: string, ...args: readonly unknown[]): Promise<T> =>
      client.call<T>(method, userId, ...args);
    const staff: StaffControls | undefined = canManageStaff
      ? {
          tenantAdmin,
          load: () => call<StaffDirectory>('staff.list'),
          onCreate: (draft) => call<{ readonly userId: string }>('staff.create', draft),
          onUpdate: (memberId, change) => call<void>('staff.update', memberId, change),
          onSetActive: (memberId, active) => call<void>('staff.setActive', memberId, active),
          canSetLimits,
          onSetLimits: (roleId, limits) => call<void>('staff.setLimits', roleId, limits),
          onCreateRole: (name, copyFromRoleId) =>
            call<{ readonly roleId: string }>('staff.createRole', name, copyFromRoleId),
          onUpdateRole: (roleId, change) => call<void>('staff.updateRole', roleId, change),
          onDeleteRole: (roleId) => call<void>('staff.deleteRole', roleId),
        }
      : undefined;
    return {
      changePin: (currentPin, newPin) => call<void>('session.changePin', currentPin, newPin),
      staffPins:
        canUnlock || canReset
          ? {
              canUnlock,
              canReset,
              lockedCount,
              list: () => call<readonly PinTargetUser[]>('session.listPinTargets'),
              clearLockout: (targetUserId) => call<void>('session.clearLockout', targetUserId),
              resetPin: (targetUserId, newPin) =>
                call<void>('session.resetPin', targetUserId, newPin),
            }
          : undefined,
      staff,
      device,
      renameDevice: canRenameDevice ? (name) => call<void>('device.rename', name) : undefined,
      chooseLocale: (locale) => call<void>('device.setLocale', locale),
    };
  }, [
    client,
    userId,
    canUnlock,
    canReset,
    canManageStaff,
    canSetLimits,
    canRenameDevice,
    tenantAdmin,
    lockedCount,
    device,
  ]);
}

function demoNameOf(userId: string): string | null {
  return DEMO_PEOPLE.find((person) => person.userId === userId)?.name ?? null;
}

/** The seeded demo (the dev server in a browser, and the demo build): four people, no core. */
function DemoApp({ capture }: { readonly capture: PcCapture }): React.JSX.Element {
  const [person, setPerson] = useState<DemoPerson>(DEMO_PEOPLE[0]!);
  // One intake for the whole PC, as the core keeps it: whoever is here may carry on with it.
  const [draft, setDraft] = useState<IntakeDraft | null>(null);
  const runtime = useMemo(() => demoRuntimeFor(person, capture), [person, capture]);
  // The demo has no core to keep the language: it switches the window, until the next load.
  const [, setDemoLocale] = useState(getLocale);
  const settings = useMemo(
    (): SettingsAccess => ({
      staff: demoStaffFor(person),
      chooseLocale: (next) => {
        setLocale(next);
        setDemoLocale(next);
        return Promise.resolve();
      },
    }),
    [person],
  );
  return (
    <RepairRuntimeProvider runtime={runtime}>
      <Counter
        key={person.userId}
        storeName={DEMO_STORE_NAME}
        person={{
          userId: person.userId,
          name: person.name,
          role: translateRoleKey(person.roleKey) ?? '',
        }}
        nameOf={demoNameOf}
        menuHeader={
          <span className="text-small font-semibold text-text-muted">
            {t('core.account.switchUser')}
          </span>
        }
        menuItems={DEMO_PEOPLE.filter((other) => other.userId !== person.userId).map((other) => ({
          key: other.userId,
          label: other.name,
          onSelect: () => setPerson(other),
        }))}
        restoredDraft={draft}
        onDraftChange={setDraft}
        settings={settings}
      />
    </RepairRuntimeProvider>
  );
}
