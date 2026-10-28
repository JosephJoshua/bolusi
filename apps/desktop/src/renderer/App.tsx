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
import {
  emptyWorkspace,
  withDraft,
  type UserWorkspace,
} from '@bolusi/device/state/user-workspaces';
import { t, translateRoleKey } from '@bolusi/i18n';
import { REPAIR_MODULE_ID, parseIntakeDraft } from '@bolusi/modules/repair';
import { RepairRuntimeProvider, type IntakeDraft } from '@bolusi/modules/repair/desktop';
import { Spinner, StatePanel } from '@bolusi/ui-web';
import { CircleAlert, Lock, Users } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { CoreState, SessionView } from '../core/api.js';
import type { Client } from '../main/rpc.js';

import { EnrolScreen } from './auth/EnrolScreen.js';
import { AuthLayout } from './auth/AuthLayout.js';
import { FirstPinScreen, PinScreen, type PinSubmitResult } from './auth/PinScreen.js';
import { SwitcherScreen } from './auth/SwitcherScreen.js';
import { createCaptureDialogs } from './capture-dialogs.js';
import { windowHandoff } from './phone-handoff.js';
import type { PcCapture } from './capture.js';
import { createCoreRepairRuntime } from './core-runtime.js';
import type { SettingsAccess } from './settings/access.js';
import { Counter } from './Counter.js';
import { DEMO_PEOPLE, DEMO_STORE_NAME, demoRuntimeFor, type DemoPerson } from './demo.js';
import { SyncStatusButton } from './SyncStatus.js';
import { useCore } from './use-core.js';

/** How often typing and clicking count as "still here" for the idle lock. */
const ACTIVITY_EVERY_MS = 5_000;

export function App(): React.JSX.Element {
  // The webcam, signature and phone dialogs, once for the window; leaving the counter backs out.
  const [dialogs] = useState(() => createCaptureDialogs(windowHandoff()));
  return (
    <>
      <Gate capture={dialogs.capture} />
      <dialogs.Host />
    </>
  );
}

function Gate({ capture }: { readonly capture: PcCapture }): React.JSX.Element {
  const core = useCore();
  if (core.mode === 'demo') return <DemoApp capture={capture} />;
  if (core.mode === 'connecting') return <BootScreen failed={false} />;
  if (core.mode === 'unavailable') return <BootScreen failed />;
  const { state } = core;
  if (state === null || state.phase === 'booting') return <BootScreen failed={false} />;
  if (state.phase === 'failed') return <BootScreen failed />;
  return <LiveApp client={core.client} state={state} capture={capture} />;
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
  capture,
}: {
  readonly client: Client;
  readonly state: CoreState;
  readonly capture: PcCapture;
}): React.JSX.Element {
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
    return () => {
      window.removeEventListener('pointerdown', onActivity, true);
      window.removeEventListener('keydown', onActivity, true);
    };
  }, [client]);

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
  // A new runtime when the person's grants change, so every screen re-derives what it offers.
  const grants = JSON.stringify({
    permissions: session.permissions,
    colleaguePermissions: session.colleaguePermissions,
  });
  const runtime = useMemo(
    () =>
      createCoreRepairRuntime({
        client,
        session: JSON.parse(grants) as Pick<SessionView, 'permissions' | 'colleaguePermissions'>,
        userId,
        storeName,
        capture,
      }),
    [client, grants, userId, storeName, capture],
  );

  const settings = useSettingsAccess(client, state, session, userId);

  // The intake in progress lives in this person's workspace in the core, so it survives a lock, a
  // switch to a colleague and a restart, and only this person's PIN brings it back.
  const workspace = session.workspace?.ownerUserId === userId ? session.workspace : null;
  const restoredDraft = useMemo<IntakeDraft | null>(
    () => (workspace === null ? null : parseIntakeDraft(workspace.drafts[REPAIR_MODULE_ID])),
    [workspace],
  );
  // The core's copy arrives a moment after each write; the next write builds on the last one sent.
  const sent = useRef<UserWorkspace | null>(workspace);
  const onDraftChange = useCallback(
    (draft: IntakeDraft | null) => {
      const base = sent.current ?? emptyWorkspace(userId);
      const held = base.drafts[REPAIR_MODULE_ID] ?? null;
      if (JSON.stringify(held) === JSON.stringify(draft)) return;
      const next = withDraft(base, REPAIR_MODULE_ID, draft);
      sent.current = next;
      client.call('session.updateWorkspace', next).catch(() => undefined);
    },
    [client, userId],
  );

  return (
    <RepairRuntimeProvider runtime={runtime}>
      <Counter
        storeName={storeName}
        person={{ userId, name: user?.name ?? '', role: roleOf(user) }}
        menuItems={[
          { key: 'switch', label: t('core.account.switchUser'), icon: Users, onSelect: onSwitch },
          {
            key: 'lock',
            label: t('auth.pc.lock'),
            icon: Lock,
            onSelect: () => void client.call('session.lock').catch(() => undefined),
          },
        ]}
        sync={(compact) =>
          state.sync === null ? null : (
            <SyncStatusButton
              input={state.sync}
              compact={compact}
              onSyncNow={() => void client.call('sync.requestManual').catch(() => undefined)}
              onReenrol={onReenrol}
            />
          )
        }
        settings={settings}
        restoredDraft={restoredDraft}
        onDraftChange={onDraftChange}
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
  const { canUnlock, canReset, canManageStaff, tenantAdmin, pinRows } = session;
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
    };
  }, [client, userId, canUnlock, canReset, canManageStaff, tenantAdmin, lockedCount, device]);
}

/** The seeded demo (the dev server in a browser, and the demo build): four people, no core. */
function DemoApp({ capture }: { readonly capture: PcCapture }): React.JSX.Element {
  const [person, setPerson] = useState<DemoPerson>(DEMO_PEOPLE[0]!);
  // Each person's intake waits for them, as the core's workspaces do.
  const [drafts, setDrafts] = useState<Readonly<Record<string, IntakeDraft | null>>>({});
  const runtime = useMemo(() => demoRuntimeFor(person, capture), [person, capture]);
  const onDraftChange = useCallback(
    (draft: IntakeDraft | null) => setDrafts((all) => ({ ...all, [person.userId]: draft })),
    [person.userId],
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
        restoredDraft={drafts[person.userId] ?? null}
        onDraftChange={onDraftChange}
      />
    </RepairRuntimeProvider>
  );
}
