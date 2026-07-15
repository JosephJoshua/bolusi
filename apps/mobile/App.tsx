/**
 * The shell root (design-system §8.1; task 24).
 *
 * It holds the shell's state, asks `resolveZone` which surface is showing, and hands the answer to
 * `renderZone`. Everything with a decision in it lives elsewhere and is tested there: the gate in
 * `navigation/zone.ts`, the lock and work retention in `session/shell-session.ts`, each screen's
 * rules in its own `model.ts`. What is left here is wiring — which is why this file has no test of
 * its own and why it must stay this thin.
 *
 * ── WHAT IS STUBBED, AND WHY (read before wiring task 15) ───────────────────────────────────────
 * `SyncStatusInput` is assembled from `syncSnapshot`, a PROP. Task 15 (sync-client) is not merged,
 * so nothing on this device yet computes a real `SyncState`, the derived counters, or the rejected /
 * quarantined / media lists. The seam is typed against `03-state-machines` §8/§10 and `01` §5.2 (see
 * `src/sync/contract.ts`) rather than against a guess, so task 15 supplies the value and this file
 * does not change. The same is true of `requestSync`: the platform trigger adapters (NetInfo, the
 * 3 s append debounce, the 60 s foreground interval, the background task, pull-to-refresh) feed
 * core's intake behind this seam — this task ships the seam, task 15 ships the loop.
 */
import { StatusBar } from 'expo-status-bar';
import { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';

import { renderZone } from './src/navigation/RootNavigator.js';
import { useHardwareBack } from './src/navigation/useHardwareBack.js';
import {
  backTarget,
  resolveZone,
  type DeviceStatus,
  type ShellRoute,
} from './src/navigation/zone.js';
import { EnrollmentScreen } from './src/screens/enrollment/EnrollmentScreen.js';
import {
  initialEnrollmentState,
  needsDiscardConfirm,
  type EnrollmentState,
} from './src/screens/enrollment/model.js';
import { PinScreen } from './src/screens/pin/PinScreen.js';
import { SettingsScreen } from './src/screens/settings/SettingsScreen.js';
import { SwitcherScreen } from './src/screens/switcher/SwitcherScreen.js';
import {
  initialsOf,
  switcherState,
  tapTarget,
  type SwitcherUser,
} from './src/screens/switcher/model.js';
import { SyncStatusScreen } from './src/screens/sync-status/SyncStatusScreen.js';
import { syncChipState, type SyncStatusInput } from './src/screens/sync-status/model.js';
import type {
  DeviceInfo,
  MutablePushCategory,
  PushMuteState,
} from './src/screens/settings/model.js';
import { defaultMuteState } from './src/screens/settings/model.js';
import type { PinAttemptRow } from '@bolusi/core';
import type { Locale } from '@bolusi/i18n';

/**
 * Everything the shell reads from the outside. Injected rather than imported so the root is
 * drivable from fakes — and so the task-15 seam (`sync`) is one prop rather than a reach into a
 * module that does not exist yet.
 */
export interface AppProps {
  readonly device: DeviceStatus;
  readonly users: readonly SwitcherUser[] | null;
  readonly usersError: string | null;
  readonly pinRow: (userId: string) => PinAttemptRow | null;
  readonly now: number;
  readonly session: { readonly userId: string } | null;
  readonly locked: boolean;
  /** TASK 15 SEAM — see the file header. */
  readonly sync: SyncStatusInput;
  readonly onSyncNow: () => void;
  readonly onSubmitPin: (userId: string, pin: string) => void;
  readonly onSelectLocale: (locale: Locale) => void;
  readonly locale: Locale;
  readonly deviceInfo: DeviceInfo;
}

export default function App(props: AppProps): React.JSX.Element {
  const [route, setRoute] = useState<ShellRoute>('home');
  const [pinFor, setPinFor] = useState<string | null>(null);
  const [enrollment, setEnrollment] = useState<EnrollmentState>(() =>
    initialEnrollmentState(props.device === 'revoked'),
  );
  const [discardPrompt, setDiscardPrompt] = useState(false);
  const [muted, setMuted] = useState<PushMuteState>(defaultMuteState);

  const zone = resolveZone({
    device: props.device,
    session: props.session,
    locked: props.locked,
    pinFor,
    route,
  });

  const goBack = useCallback((): boolean => {
    const target = backTarget(zone);
    if (target === null) return true; // Nothing behind this surface — consume, never exit past a lock.
    if (target.kind === 'switcher') {
      setPinFor(null);
      return true;
    }
    if (target.kind === 'shellRoute') {
      setPinFor(null);
      setRoute(target.route);
      return true;
    }
    // `exitApp`: the wizard is the exception — a back press on typed input asks first (§8.1).
    if (zone.kind === 'enrollment' && needsDiscardConfirm(enrollment)) {
      setDiscardPrompt(true);
      return true;
    }
    return false; // Let Android exit.
  }, [zone, enrollment]);

  // Hardware back IS the header back (§8.1) — one function, so they cannot drift.
  useHardwareBack(goBack);

  const chip = useMemo(() => syncChipState(props.sync), [props.sync]);
  const currentUser = useMemo(() => {
    if (props.session === null) return null;
    const found = (props.users ?? []).find((user) => user.id === props.session?.userId);
    return found === undefined ? null : { id: found.id, initials: initialsOf(found.name) };
  }, [props.session, props.users]);

  return (
    <View testID="bolusi-app-shell" style={FILL}>
      <StatusBar style="auto" />
      {renderZone(zone, {
        enrollment: (revoked) => (
          <EnrollmentScreen
            state={{ ...enrollment, revoked }}
            onChange={(patch) => setEnrollment((previous) => ({ ...previous, ...patch }))}
            onLogin={noop}
            onEnroll={noop}
            onFinish={() => setEnrollment(initialEnrollmentState())}
            onBack={goBack}
            discardPrompt={discardPrompt}
            onConfirmDiscard={() => {
              setDiscardPrompt(false);
              setEnrollment(initialEnrollmentState(revoked));
            }}
            onCancelDiscard={() => setDiscardPrompt(false)}
          />
        ),
        switcher: (switcherZone) => (
          <SwitcherScreen
            state={switcherState(props.users, props.usersError)}
            mode={switcherZone.mode}
            // §8.2: the LOCK has no back. `backTarget` is the single source of that rule.
            onBack={backTarget(switcherZone) === null ? null : goBack}
            onSelect={(user) => setPinFor(tapTarget(user).userId)}
            onEnroll={noop}
            onRetry={noop}
            syncChip={chip}
            onOpenSync={() => setRoute('syncStatus')}
          />
        ),
        pin: (pinZone) => (
          <PinScreen
            userId={pinZone.userId}
            userName={nameOf(props.users, pinZone.userId)}
            row={props.pinRow(pinZone.userId)}
            now={props.now}
            lastAttempt="none"
            onSubmit={(pin) => props.onSubmitPin(pinZone.userId, pin)}
            onSwitchUser={() => setPinFor(null)}
            syncChip={chip}
            onOpenSync={() => setRoute('syncStatus')}
          />
        ),
        shell: (shellZone) => {
          if (shellZone.route === 'syncStatus') {
            return (
              <SyncStatusScreen
                input={props.sync}
                currentUser={currentUser}
                onBack={() => setRoute('home')}
                onSyncNow={props.onSyncNow}
                onOpenRejected={noop}
                onRetryMedia={noop}
                onOpenSwitcher={() => setPinFor(null)}
              />
            );
          }
          if (shellZone.route === 'settings' && currentUser !== null) {
            return (
              <SettingsScreen
                locale={props.locale}
                onSelectLocale={props.onSelectLocale}
                muted={muted}
                onToggleMute={(category: MutablePushCategory, value: boolean) =>
                  setMuted((previous) => ({ ...previous, [category]: value }))
                }
                device={props.deviceInfo}
                currentUser={currentUser}
                onBack={() => setRoute('home')}
                onOpenSwitcher={() => setRoute('home')}
                syncChip={chip}
                onOpenSync={() => setRoute('syncStatus')}
              />
            );
          }
          // `home` is the module surface — the notes screens land with task 25. Rendering an empty
          // shell rather than a placeholder string: a hardcoded "coming soon" would be exactly the
          // copy the label catalog exists to prevent (07-i18n).
          return <View testID="shell-home" style={FILL} />;
        },
      })}
    </View>
  );
}

function nameOf(users: readonly SwitcherUser[] | null, userId: string): string {
  return (users ?? []).find((user) => user.id === userId)?.name ?? '';
}

function noop(): void {
  // Wired by tasks 14/15/25 — see the file header for what is stubbed and why.
}

const FILL = { flex: 1 } as const;
