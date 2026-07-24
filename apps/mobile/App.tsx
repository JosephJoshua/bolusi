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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { NotesHome } from './src/screens/notes/NotesHome.js';
import { renderZone } from './src/navigation/RootNavigator.js';
import type { SurfaceNav } from './src/navigation/surface.js';
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
import { CaptureScreen } from './src/media/CaptureScreen.js';
import type { CaptureSurface } from './src/media/CaptureHost.js';
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
   * 06 §5.2 (e)'s "manual retry from the sync-status screen" — `MediaClient.requestManual()` (task 130).
   *
   * A SEPARATE PROP FROM `onSyncNow`, because they are separate loops. FR-1138 makes the media drain
   * and the op push independent by construction (`media/client.ts`'s header: they share no state), so
   * folding the media retry into the sync button would make the tap on a `failed` photo chip either
   * do nothing to that photo or restart something the user did not ask for.
   */
  readonly onRetryMedia: () => void;
  /**
   * §5's Error retry on the User Switcher — re-run the directory read (`AppSessionController.refresh`).
   *
   * The switcher's error state is reached when that read THREW (`usersError`), so the only action
   * that can clear it is running it again. Nothing else on this shell can.
   */
  readonly onRetryUsers: () => void;
  /**
   * The in-app capture surface while a capture is running, or `null`/`undefined` when none is
   * (06 §2.1; task 130). Built by `useCaptureHost` at the composition root, because the promise the
   * notes editor awaits has to outlive the screen that shows the viewfinder.
   *
   * It replaces the SHELL ZONE only — never the gate's verdict. `resolveZone` still decides first,
   * so an idle lock, a revocation or a pending PIN beats an open camera (see the render below).
   */
  readonly capture?: CaptureSurface | null;
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
  /**
   * The user asked to open the switcher while a session is open — the voluntary quick-switch
   * (task 143; api/02-auth §6.2). `resolveZone` turns this into the switcher zone only when a session
   * is live; it is cleared the moment the switch lands on a shell surface (abandoned back, or a
   * completed switch), so a stale intent can never re-open the roster over the incoming user's shell.
   */
  const [switching, setSwitching] = useState(false);
  const [enrollment, setEnrollment] = useState<EnrollmentState>(() =>
    initialEnrollmentState(props.device === 'revoked'),
  );
  const [discardPrompt, setDiscardPrompt] = useState(false);
  /**
   * Which rejected op has its §8.4-item-4 technical detail disclosed (task 130).
   *
   * The op ID rather than a boolean, so opening a second row closes the first — a list where every
   * tap leaves another block expanded turns the one section that must never be skimmed into a wall.
   * Tapping the open row closes it, which is the only way back out of a disclosure with no chrome.
   */
  const [rejectedDetailFor, setRejectedDetailFor] = useState<string | null>(null);

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
    switching,
    route,
  });

  /**
   * The `home` module surface's own back/leave delegate (task 145). `NotesHome` owns a list→detail→
   * editor stack the pure zone gate cannot see, so it publishes this while it is off its list root;
   * the shell reads it at the moment of a back/leave. A ref, not state — a registration change must not
   * re-render the shell, and `goBack`/`leaveHome` must see the LIVE value, not a captured one.
   */
  const surfaceNavRef = useRef<SurfaceNav | null>(null);
  const registerSurfaceNav = useCallback((nav: SurfaceNav | null): void => {
    surfaceNavRef.current = nav;
  }, []);

  /**
   * Navigate away from the `home` surface toward `proceed`, but let the surface guard the leave first
   * (task 145): a dirty editor raises its ConfirmSheet and proceeds only on confirm; anything else
   * proceeds at once. Every header-chrome control on the notes surface goes through this, so a chip /
   * avatar / sync-chip tap can no longer unmount a half-written draft with no confirm.
   */
  const leaveHome = useCallback((proceed: () => void): void => {
    const nav = surfaceNavRef.current;
    if (nav !== null) nav.requestLeave(proceed);
    else proceed();
  }, []);

  /**
   * The switcher/PIN sync chip's navigation, guarded against origin drift (task 145). During a
   * live-session voluntary switch the gate keeps showing the switcher, so this chip cannot actually
   * reach Sync Status — but a bare `setRoute('syncStatus')` would still fold into the switcher's
   * `origin`, landing a later back on Sync Status instead of where the switch was opened (task 143's
   * `origin: ShellRoute`). Ignore it while `switching`, so `origin` stays put.
   */
  const openSyncStatus = useCallback((): void => {
    if (!switching) setRoute('syncStatus');
  }, [switching]);

  const captureSurface = props.capture ?? null;
  const goBack = useCallback((): boolean => {
    // A capture owns the screen while it runs (see the early return below), so back IS its cancel —
    // §8.1's "hardware back always equals the header back action", applied to the surface actually
    // showing. Without this the press would fall through to the zone underneath and navigate a tree
    // the user cannot see, leaving the viewfinder on top of it.
    if (captureSurface !== null) {
      captureSurface.onBack();
      return true;
    }
    // A module surface at `home` owns an internal stack the pure zone gate cannot see (NotesHome:
    // list→detail→editor). While it has somewhere to go back to, hardware back IS that surface's back
    // — routed through the editor's discard gate — never an app exit (design-system §8.1; task 145).
    if (zone.kind === 'shell' && zone.route === 'home' && surfaceNavRef.current !== null) {
      return surfaceNavRef.current.handleBack();
    }
    const target = backTarget(zone);
    if (target === null) return true; // Nothing behind this surface — consume, never exit past a lock.
    if (target.kind === 'switcher') {
      // Back from the PIN pad to the roster — a mis-tapped face costs no attempt (§8.2). The switch is
      // still in progress, so `switching` STAYS set: clearing it here would drop straight to the shell.
      setPinFor(null);
      return true;
    }
    if (target.kind === 'shellRoute') {
      // Landing on a shell surface ends any voluntary switch (task 143): the abandoned switcher returns
      // to its `origin`, a shell sub-route returns home. `setSwitching(false)` is a no-op off the
      // switcher and the load-bearing clear on it — without it `resolveZone` would re-open the roster.
      setPinFor(null);
      setSwitching(false);
      setRoute(target.route);
      return true;
    }
    // `exitApp`: the wizard is the exception — a back press on typed input asks first (§8.1).
    if (zone.kind === 'enrollment' && needsDiscardConfirm(enrollment)) {
      setDiscardPrompt(true);
      return true;
    }
    return false; // Let Android exit.
  }, [zone, enrollment, captureSurface]);

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

  const capture = captureSurface;
  if (capture !== null && zone.kind === 'shell') {
    /**
     * THE CAPTURE SURFACE WINS THE SCREEN — BUT ONLY INSIDE THE SHELL ZONE (06 §2.1; task 130).
     *
     * `zone.kind === 'shell'` is the whole security content of this line, and it is here because
     * the first version of it was wrong in the direction that matters. That version returned on
     * `capture !== null` alone, with a comment asserting that a mid-capture idle lock would still
     * lock — which was exactly backwards: `resolveZone` is recomputed on every render (above), but
     * an unconditional early return never reads it, so a device that locked with the camera open
     * kept showing a LIVE VIEWFINDER over a locked session. The comment was the guard, and the
     * guard was false (CLAUDE.md §2.11). Deferring to the zone makes the lock win by construction.
     * Falsified: dropping this conjunct turns `capture surface yields to an idle lock` red in
     * `test/live-shell-dead-controls.test.tsx`.
     *
     * The pending capture survives the lock for the SAME user only — the host holds the deferred in
     * `Root`, which does not unmount, so THIS user's PIN unlock returns to the viewfinder with the
     * notes editor still waiting behind it ("Pekerjaanmu aman", SwitcherScreen.tsx:7-11). If a
     * DIFFERENT user unlocks (an idle lock ended the session and someone else signed in), the host
     * cancels the capture rather than handing the incoming user the outgoing user's live camera —
     * that identity guard lives in `useCaptureHost` (`openedForUserRef`/`stranded`), because it needs
     * the acting-identity change the zone gate cannot see, and it is covered by
     * `a pending capture does not survive an idle lock into a different user's session`.
     *
     * The chrome comes from here because this is where chrome is built (§8.1: both slots always
     * present). The sync chip goes to Sync Status the way every other screen's does; the avatar
     * slot renders empty during a capture — a switcher hop from inside a half-finished photo would
     * strand the capture behind an identity change, and 06 §4 freezes the capturing user at the
     * shutter, so the identity must not be switchable between opening the camera and pressing it.
     */
    return (
      <View testID="bolusi-app-shell" style={FILL}>
        <StatusBar style="auto" />
        <CaptureScreen
          // Already-localized, per `CaptureScreenProps.title`. `media.action.takePhoto` is the
          // catalog's own name for this action ("Ambil Foto") — no new key, no hardcoded string.
          title={t('media.action.takePhoto')}
          state={capture.state}
          preview={capture.preview}
          syncChip={
            <SyncChip
              state={chip}
              pendingCount={props.sync.pendingOperationCount}
              accessibilityLabel={t('sync.status.lastSynced', { relative: '' })}
              onPress={openSyncStatus}
            />
          }
          avatar={<View testID="capture-no-avatar" />}
          onShutter={capture.onShutter}
          onRetake={capture.onRetake}
          onUsePhoto={capture.onUsePhoto}
          onRetry={capture.onRetry}
          onBack={capture.onBack}
        />
      </View>
    );
  }

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
            // NO `onEnroll` — the prop is GONE, not passed as a stub (owner ruling D23 §3; task 130).
            // §8.2's empty-roster CTA is out of v0: reaching Device Enrollment from an `active`
            // device needs a new input on `resolveZone` (the security gate) and completing it runs
            // api/02-auth §7.4 re-enrollment — new `deviceId`, new keypair, fresh chain at seq 1,
            // old registration left `active` server-side. §5 forbids rendering a control that
            // cannot work, so the empty state carries GUIDANCE TEXT instead
            // (`SWITCHER_EMPTY_HINT_KEY`). Deleting the prop rather than stubbing it is the
            // load-bearing half: a surviving prop is how the affordance grows back. Task 168
            // carries the flow to v1.
            //
            // §5's Error retry — the real producer (`AppSessionController.refresh`), reached through
            // Root. This is the read that FAILED; running it again is the only thing that can clear
            // the state, and until now it was `noop`, so the retry button on a directory failure
            // left the user with a permanently broken switcher and no way back.
            onRetry={props.onRetryUsers}
            // A DIFFERENT function from `onRetry`, which is the point (see SwitcherScreen's prop
            // doc). Back from the unauthorized state is the shell's ONE back — the same `goBack`
            // hardware back and the header run, so §8.2's "the lock has no back" holds here too:
            // `backTarget` returns null for the lock and `goBack` consumes the press rather than
            // walking into the previous user's session.
            onUnauthorizedBack={goBack}
            syncChip={chip}
            onOpenSync={openSyncStatus}
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
                  if (opened) {
                    // The switch completed (§6.3's ops are appended inside `onSubmitPin`). Retire both
                    // the pending target AND the switch intent, so the gate lands on the incoming
                    // user's shell rather than re-rendering the roster over their session (task 143).
                    setPinFor(null);
                    setSwitching(false);
                  }
                });
              }
            }}
            onSwitchUser={() => setPinFor(null)}
            syncChip={chip}
            onOpenSync={openSyncStatus}
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
                // 05 §2.3 / 06 §8: "rejections must be surfaced, never silent". The row already
                // carries the code's explanation; the tap discloses the server's own words under
                // `sync.rejected.technicalDetails` (a catalog key that shipped with no consumer).
                // Tapping the open row closes it — see `rejectedDetailFor`.
                onOpenRejected={(row) =>
                  setRejectedDetailFor((current) => (current === row.opId ? null : row.opId))
                }
                expandedRejectedOpId={rejectedDetailFor}
                // 06 §5.2 (e). The row-level chip is per item and the producer is loop-level
                // (`requestManual` coalesces into one immediate drain pass), which is the honest
                // shape: the drain is single-flight and processes oldest-evidence-first (§5.1), so
                // there is no per-item retry to call and pretending otherwise would be a control
                // that looks more precise than the engine underneath it.
                onRetryMedia={props.onRetryMedia}
                onOpenSwitcher={() => setSwitching(true)}
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
                onOpenSwitcher={() => setSwitching(true)}
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
              // The surface publishes its internal back/leave here (task 145) — see `leaveHome`/`goBack`.
              onRegisterSurfaceNav={registerSurfaceNav}
              onOpenSyncStatus={() => leaveHome(() => setRoute('syncStatus'))}
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
                  onPress={() => leaveHome(() => setRoute('syncStatus'))}
                />
              }
              avatar={
                currentUser === null ? (
                  <View testID="notes-no-avatar" />
                ) : (
                  // THE HEADER CHROME (§8.1): the language Chip (the ONLY producer of `route:
                  // 'settings'`) and the avatar (the producer of the User Switcher).
                  //
                  // WHY THE LANGUAGE CHIP IS SEPARATE FROM THE AVATAR. Settings holds the language
                  // toggle, the notification deep-links and the device-identity readout, and until
                  // task 124 added this node nothing in shipping source ever called
                  // `setRoute('settings')` — the render arm below was live, typed and tested, and no
                  // user could open it (CLAUDE.md §2.11's "sound tests, zero callers"). On an
                  // Indonesian-first product the language rows are the ONLY way out of a wrong locale
                  // (07-i18n §1.2), so the entry point cannot be folded behind the avatar: the avatar
                  // opens the User Switcher (a roster of faces), not Settings, so Settings needs its
                  // own direct control regardless of whether the switcher is reachable.
                  //
                  // THE AVATAR → SWITCHER HOP §8.1 DESCRIBES IS NOW REAL (task 143). It was a dead
                  // control before: `resolveZone` returned the shell for every session-open render
                  // (`session !== null && pinFor === null`), and the only writer was `setPinFor(null)`
                  // — a no-op in that state — so tapping the avatar left the notes list exactly where
                  // it was. `setSwitching(true)` is the input the model was missing: it produces the
                  // switcher zone from a live session, and `backTarget` returns to `home` (this
                  // surface's route) when the switch is abandoned.
                  //
                  // A `Chip` rather than a bespoke control for language: §3.5 gives it the icon+label
                  // pair §0 requires ("no icons without labels" — a bare cog is unreadable to the
                  // users this product is for) and pads its 28 dp body to the §1.4 48 dp floor. It
                  // rides the header-right group beside the avatar, in reach of the same thumb (§0).
                  // BOTH GO THROUGH `leaveHome` (task 145). Either tap used to unmount `NotesHome`
                  // outright, taking an open editor's title/body/mediaRef with it and showing no
                  // confirm — the §8.1 discard gate the editor's own header back has always run.
                  <View style={styles.headerChrome}>
                    <Chip
                      label={t('core.settings.language')}
                      icon="language"
                      onPress={() => leaveHome(() => setRoute('settings'))}
                      testID="shell-open-settings"
                    />
                    <AvatarButton
                      userId={currentUser.id}
                      initials={currentUser.initials}
                      accessibilityLabel={t('auth.switcher.title')}
                      onPress={() => leaveHome(() => setSwitching(true))}
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

const FILL = { flex: 1 } as const;

const styles = StyleSheet.create({
  /** The header-right group's own spacing rule (§1.4 `touch.gap`) — adjacent targets never touch. */
  headerChrome: { flexDirection: 'row', alignItems: 'center', gap: touch.gap },
});
