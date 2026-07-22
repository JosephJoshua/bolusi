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
 * `SyncStatusInput` arrives as the `sync` PROP. Task 15 (sync-client) is not merged,
 * so nothing on this device yet computes a real `SyncState`, the derived counters, or the rejected /
 * quarantined / media lists. The seam is typed against `03-state-machines` §8/§10 and `01` §5.2 (see
 * `src/sync/contract.ts`) rather than against a guess, so task 15 supplies the value and this file
 * does not change. The same is true of `requestSync`: the platform trigger adapters (NetInfo, the
 * 3 s append debounce, the 60 s foreground interval, the background task, pull-to-refresh) feed
 * core's intake behind this seam — this task ships the seam, task 15 ships the loop.
 */
import { AvatarButton, Chip, SyncChip, touch } from '@bolusi/ui';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { NotesHome } from './src/screens/notes/NotesHome.js';
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
  canSubmitConfirm,
  canSubmitCredentials,
  classifyFailure,
  initialEnrollmentState,
  needsDiscardConfirm,
  type EnrollmentState,
} from './src/screens/enrollment/model.js';
import type { EnrollmentController } from './src/bootstrap/enrollment.js';
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
import type { DeviceInfo, MutablePushCategory } from './src/screens/settings/model.js';
import { channelId } from './src/bootstrap/notifications.js';
import { openNotificationSettings } from './src/push/notification-settings.js';
import type { PushRouteRequest } from './src/push/router.js';
import type { PinAttemptRow } from '@bolusi/core';
import type { NotesRuntime } from '@bolusi/modules/notes/screens';
import { formatRelative, t, type Locale } from '@bolusi/i18n';

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
  /**
   * The notes module surface at the `home` route (task 96). A `NotesRuntime` bound over the composed
   * command/query runtimes + media client + a session identity (04 §7). `undefined` until a live
   * session-scoped runtime is wired (the shell is still pre-session — `session` is `null` today), in
   * which case `home` stays the empty shell rather than faking a surface that cannot query.
   */
  readonly notes?: NotesRuntime | undefined;
  /**
   * Submit a PIN for `userId`. Resolves TRUE when a session opened (task 119).
   *
   * The result is load-bearing, not informational. `resolveZone` step 3 keeps rendering the pad
   * while `pinFor` is set — even once a session exists — so something has to tell the shell the
   * unlock succeeded and the pending PIN target is spent. Nothing did, because until this task
   * `onSubmitPin` was `() => undefined` and no submission had ever succeeded: the shell had a
   * success path it could not reach and therefore never had to clear. A caller that does not
   * authenticate (the web harness) returns `void` and the pad simply stays put.
   */
  readonly onSubmitPin: (userId: string, pin: string) => void | Promise<boolean>;
  readonly onSelectLocale: (locale: Locale) => void;
  readonly locale: Locale;
  readonly deviceInfo: DeviceInfo;
  /**
   * A deep-link navigation requested by a notification tap (api/04-push §4), driven by `Root`'s push
   * router. A fresh object per tap, applied by the effect below via `setRoute` — the shell owns its
   * route, so the composition root asks rather than reaches in. `null`/`undefined` on every render
   * that is not a tap (the web harness never sets it). See `src/push/router.ts`.
   */
  readonly pushRoute?: PushRouteRequest | null;
  /**
   * The enrollment caller (api/02-auth §4). `login` mints the control session + store list;
   * `enroll` registers the device, appends the genesis, persists the identity, and starts the loop.
   * Root supplies the real one (index.ts binds the transports + keystore + runtime); a test injects a
   * fake. Both reject on failure, and the wizard buckets it (`classifyFailure`).
   */
  readonly enrollment: EnrollmentController;
}

export default function App(props: AppProps): React.JSX.Element {
  const [route, setRoute] = useState<ShellRoute>('home');
  const [pinFor, setPinFor] = useState<string | null>(null);
  const [enrollment, setEnrollment] = useState<EnrollmentState>(() =>
    initialEnrollmentState(props.device === 'revoked'),
  );
  const [discardPrompt, setDiscardPrompt] = useState(false);

  /**
   * Apply a notification-tap deep link (api/04-push §4). `Root` hands a FRESH `pushRoute` object per
   * tap, so a repeat tap to the same route re-navigates (object identity is the trigger); an unrelated
   * re-render passes the SAME object and this does nothing. The gate still decides what actually shows
   * — a tap while locked sets the route but `resolveZone` keeps the lock until a PIN unlock, then lands
   * on the requested surface. `null`/`undefined` (every non-tap render) is a no-op.
   */
  const pushRoute = props.pushRoute;
  useEffect(() => {
    if (pushRoute !== undefined && pushRoute !== null) setRoute(pushRoute.route);
  }, [pushRoute]);

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

  // Step 1 (§4.2): log in. On success, advance to the confirm step carrying the tenant/store choices;
  // auto-select the store when there is exactly one (nothing to disambiguate). On failure, bucket it
  // into one of the four human actions (`classifyFailure`) — never a raw server string.
  const runLogin = (): void => {
    if (enrollment.busy || !canSubmitCredentials(enrollment)) return;
    setEnrollment((s) => ({ ...s, busy: true, failure: null }));
    props.enrollment
      .login({ loginIdentifier: enrollment.loginIdentifier.trim(), password: enrollment.password })
      .then((login) =>
        setEnrollment((s) => ({
          ...s,
          busy: false,
          login,
          step: 'confirm',
          selectedStoreId:
            login.stores.length === 1 ? (login.stores[0]?.id ?? null) : s.selectedStoreId,
        })),
      )
      .catch((error: unknown) =>
        setEnrollment((s) => ({ ...s, busy: false, failure: classifyFailure(error) })),
      );
  };

  // Step 2 (§4.3 + §4.1 steps 4–6): register + genesis + persist. The state is captured BEFORE the
  // async call so a concurrent edit cannot change what was submitted. On success the wizard shows the
  // done step; Root has already re-derived the enrolled deviceId and started the loop (`onEnrolled`).
  const runEnroll = (): void => {
    if (enrollment.busy || !canSubmitConfirm(enrollment)) return;
    const { login, selectedStoreId } = enrollment;
    if (login === null || selectedStoreId === null) return;
    const deviceName = enrollment.deviceName.trim();
    setEnrollment((s) => ({ ...s, busy: true, failure: null }));
    props.enrollment
      .enroll({ login, storeId: selectedStoreId, deviceName })
      .then(() => setEnrollment((s) => ({ ...s, busy: false, step: 'done' })))
      .catch((error: unknown) =>
        setEnrollment((s) => ({ ...s, busy: false, failure: classifyFailure(error) })),
      );
  };

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
            onLogin={runLogin}
            onEnroll={runEnroll}
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
            onSubmit={(pin) => {
              // Clear the pending PIN target only on a CONFIRMED unlock. On a wrong PIN the pad
              // stays exactly where it is (its own `state` renders the failure), which is why this
              // waits for the result rather than clearing optimistically — an optimistic clear
              // would drop a failed attempt straight into the shell.
              const submitted = props.onSubmitPin(pinZone.userId, pin);
              if (submitted !== undefined) {
                void submitted.then((opened) => {
                  if (opened) setPinFor(null);
                });
              }
            }}
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
                onOpenNotificationSettings={(category: MutablePushCategory) =>
                  openNotificationSettings(channelId(category))
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
          // `home` is the module surface (task 96): the notes screens, when a live `NotesRuntime` is
          // available. Until the shell is session-wired (`props.notes` is `undefined` today), it stays
          // the empty shell rather than a placeholder string — a hardcoded "coming soon" is exactly the
          // copy the label catalog exists to prevent (07-i18n).
          if (props.notes === undefined) return <View testID="shell-home" style={FILL} />;
          return (
            <NotesHome
              runtime={props.notes}
              now={props.now}
              onOpenSyncStatus={() => setRoute('syncStatus')}
              syncChip={
                <SyncChip
                  state={chip}
                  pendingCount={props.sync.pendingOperationCount}
                  accessibilityLabel={t('sync.status.lastSynced', {
                    relative:
                      props.sync.state.lastSuccessfulSyncAt === null
                        ? t('core.status.empty')
                        : formatRelative(props.now - props.sync.state.lastSuccessfulSyncAt),
                  })}
                  onPress={() => setRoute('syncStatus')}
                />
              }
              avatar={
                currentUser === null ? (
                  <View testID="notes-no-avatar" />
                ) : (
                  // THE HEADER CHROME (§8.1) — and the ONLY producer of `route: 'settings'`.
                  //
                  // The Settings screen holds the language toggle, the notification deep-links and
                  // the device-identity readout, and until this node existed nothing in shipping
                  // source ever called `setRoute('settings')`: the render arm below was live,
                  // typed and tested, and no user could open it (CLAUDE.md §2.11's "sound tests,
                  // zero callers"). On an Indonesian-first product the language rows are the ONLY
                  // way out of a wrong locale (07-i18n §1.2), so the entry point cannot be behind
                  // the avatar → User Switcher hop that §8.1 describes: `resolveZone` returns the
                  // shell for every session-open render, so nothing reaches the switcher from here.
                  //
                  // A `Chip` rather than a bespoke control: §3.5 gives it the icon+label pair §0
                  // requires ("no icons without labels" — a bare cog is unreadable to the users
                  // this product is for) and pads its 28 dp body to the §1.4 48 dp floor. It rides
                  // the header-right group beside the avatar, in reach of the same thumb (§0).
                  <View style={styles.headerChrome}>
                    <Chip
                      label={t('core.settings.language')}
                      icon="language"
                      onPress={() => setRoute('settings')}
                      testID="shell-open-settings"
                    />
                    <AvatarButton
                      userId={currentUser.id}
                      initials={currentUser.initials}
                      accessibilityLabel={t('auth.switcher.title')}
                      onPress={() => setPinFor(null)}
                    />
                  </View>
                )
              }
            />
          );
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

const styles = StyleSheet.create({
  /** The header-right group's own spacing rule (§1.4 `touch.gap`) — adjacent targets never touch. */
  headerChrome: { flexDirection: 'row', alignItems: 'center', gap: touch.gap },
});
