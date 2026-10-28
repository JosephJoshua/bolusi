/** App shell: session gates, navigation, retained drafts and screen callbacks.
 * Native services and sync state are supplied by the bootstrap composition root.
 */
import {
  Avatar,
  AvatarButton,
  ConfirmSheet,
  Icon,
  ListRow,
  NAV_BAR_INSET,
  Sheet,
  SyncChip,
  TabBar,
  color,
  size,
  space,
} from '@bolusi/ui';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { SafeAreaInsetsContext, type EdgeInsets } from 'react-native-safe-area-context';
import {
  Platform,
  StatusBar as RNStatusBar,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';

import { NotesHome } from './src/screens/notes/NotesHome.js';
import { RepairSettingsRoute } from './src/screens/repair/RepairSettingsRoute.js';
import { RepairHome } from './src/screens/repair/RepairHome.js';
import { KasHome } from './src/screens/money/KasHome.js';
import { PaymentMethodsRoute } from './src/screens/money/PaymentMethodsRoute.js';
import { PartsRoute } from './src/screens/inventory/PartsRoute.js';
import { systemClock } from '@bolusi/device/ports/clock';
import { renderZone } from './src/navigation/RootNavigator.js';
import type { SurfaceNav } from './src/navigation/surface.js';
import {
  emptyWorkspace,
  withDraft,
  withRoute,
  type UserWorkspace,
} from '@bolusi/device/state/user-workspaces';
import { useHardwareBack } from './src/navigation/useHardwareBack.js';
import {
  backTarget,
  resolveZone,
  type DeviceStatus,
  type ShellRoute,
} from '@bolusi/device/navigation/zone';
import { EnrollmentScreen } from './src/screens/enrollment/EnrollmentScreen.js';
import {
  afterLogin,
  canSubmitConfirm,
  canSubmitCredentials,
  chosenStoreId,
  classifyFailure,
  initialEnrollmentState,
  needsDiscardConfirm,
  type EnrollmentState,
} from '@bolusi/device/models/enrollment/model';
import type { EnrollmentController } from '@bolusi/device/bootstrap/enrollment';
import { ChangePinScreen } from './src/screens/pin/ChangePinScreen.js';
import { useLatestCallback } from './src/hooks/useLatestCallback.js';
import { StaffPinScreen } from './src/screens/pin/StaffPinScreen.js';
import { LimitsScreen } from './src/screens/staff/LimitsScreen.js';
import { RolesScreen } from './src/screens/staff/RolesScreen.js';
import { StaffScreen } from './src/screens/staff/StaffScreen.js';
import type { PinTargetUser } from '@bolusi/device/models/pin/pin-target';
import { PinScreen } from './src/screens/pin/PinScreen.js';
import { PinSetupScreen } from './src/screens/pin/PinSetupScreen.js';
import { pinView } from '@bolusi/device/models/pin/model';
import { SettingsScreen } from './src/screens/settings/SettingsScreen.js';
import { SwitcherScreen } from './src/screens/switcher/SwitcherScreen.js';
import { roleLabel } from './src/screens/switcher/UserRow.js';
import {
  initialsOf,
  switcherState,
  tapTarget,
  type SwitcherUser,
} from '@bolusi/device/models/switcher/model';
import { SyncStatusScreen } from './src/screens/sync-status/SyncStatusScreen.js';
import {
  firstSyncPercent,
  syncChipState,
  type SyncStatusInput,
} from '@bolusi/device/models/sync-status/model';
import { syncChipAccessibilityLabels } from './src/screens/sync-status/chip-a11y.js';
import { CaptureScreen } from './src/media/CaptureScreen.js';
import type { CaptureSurface } from './src/media/CaptureHost.js';
import type { SignatureSurface } from './src/media/SignatureHost.js';
import { SignaturePadScreen } from './src/media/SignaturePadScreen.js';
import type { ScanSurface } from './src/media/ScanHost.js';
import { ScanScreen } from './src/media/ScanScreen.js';
import type { DeviceInfo, MutablePushCategory } from '@bolusi/device/models/settings/model';
import { channelId } from './src/bootstrap/notifications.js';
import { openNotificationSettings } from './src/push/notification-settings.js';
import type { PushRouteRequest } from './src/push/router.js';
import { errorCodeOrUnexpected, type PinAttemptRow } from '@bolusi/core';
import type { StaffControls } from '@bolusi/device/bootstrap/staff';
import { NOTES_MODULE_ID } from '@bolusi/modules/notes';
import {
  REPAIR_MODULE_ID,
  REPAIR_PERMISSION,
  parseIntakeDraft,
  type IntakeDraft,
} from '@bolusi/modules/repair';
import { moneyRuntimeOf, tn, type RepairRuntime } from '@bolusi/modules/repair/screens';
import { MONEY_PERMISSION } from '@bolusi/modules/money';
import { tm, type MoneyRuntime } from '@bolusi/modules/money/screens';
import { INVENTORY_PERMISSION } from '@bolusi/modules/inventory';
import { ti } from '@bolusi/modules/inventory/screens';
import { parseNoteDraft, type NoteDraft, type NotesRuntime } from '@bolusi/modules/notes/screens';
import { formatRelative, t, type Locale } from '@bolusi/i18n';

/**
 * Services and state supplied by bootstrap; tests can supply the same interface.
 */
export interface AppProps {
  readonly device: DeviceStatus;
  readonly users: readonly SwitcherUser[] | null;
  readonly usersError: string | null;
  readonly pinRow: (userId: string) => PinAttemptRow | null;
  readonly now: number;
  /**
   * The clock the repair screens count from (an intake's ready-by, how long a phone has waited).
   * The system clock unless a preview pins its demo time.
   */
  readonly clock?: (() => number) | undefined;
  readonly session: { readonly userId: string } | null;
  readonly locked: boolean;
  /** Live operation-sync state. */
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
   * The signature pad while a customer is signing (06 §2.3), from `useSignatureHost`. Rendered
   * exactly like `capture`: it wins the screen inside the shell zone only, so a lock still wins.
   */
  readonly signature?: SignatureSurface | null;
  /** The code scanner while it looks for a barcode or QR code, from `useScanHost`; like `capture`. */
  readonly scan?: ScanSurface | null;
  /**
   * The notes module surface at the `home` route (task 96). A `NotesRuntime` bound over the composed
   * command/query runtimes + media client + a session identity (04 §7). `undefined` until a live
   * session-scoped runtime is wired (the shell is still pre-session — `session` is `null` today), in
   * which case `home` stays the empty shell rather than faking a surface that cannot query.
   */
  readonly notes?: NotesRuntime | undefined;
  /**
   * The repair module surface (slice 1). When present it is the `home` surface, ahead of notes,
   * because the repair ticket is what the stores use the app for.
   */
  readonly repair?: RepairRuntime | undefined;
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
  /**
   * THE ACTIVE USER'S RETAINED WORK (SEC-AUTH-08; api/02-auth §6.4; task 155) — `ShellSession`'s
   * workspace, forwarded by `Root`, or `null` when nobody is signed in.
   *
   * This is the READ half of task 133's retention path, which shipped with a producer and no
   * consumer: a lock preserved the workspace, an unlock restored it, and no screen ever looked at
   * it, so a half-typed note was still lost on a real device. The shell reads two things out of it —
   * the route the user was on, and the notes module's draft — and treats the draft as OPAQUE
   * (`drafts` is `Record<string, unknown>` by design; only the module knows the shape).
   *
   * Absent for hosts with no session to retain into (the web gallery), which is why it is optional.
   */
  readonly workspace?: UserWorkspace | null;
  /**
   * Write the active user's work back into retention (task 155). Bound to
   * `AppSessionController.updateWorkspace`, which is keyed by the SIGNED-IN user and ignores a write
   * for anyone else — so this seam cannot be used to smuggle one user's work into another's slot.
   */
  readonly onWorkspaceChange?: ((next: UserWorkspace) => void) | undefined;
  readonly onSelectLocale: (locale: Locale) => void;
  /**
   * Change the signed-in user's PIN (api/02-auth §6.6; task 186a), driven by the session controller.
   * Resolves on success; REJECTS with the flow's DomainError so `ChangePinScreen` maps it to the pad.
   */
  readonly onChangePin: (currentPin: string, newPin: string) => Promise<void>;
  /**
   * Make a first PIN for a user who has none (api/02-auth §6.6). Resolves once it is stored; REJECTS
   * with the flow's DomainError. The shell then signs them in through `onSubmitPin`.
   */
  readonly onSetFirstPin?: ((userId: string, pin: string) => Promise<void>) | undefined;
  /**
   * Does the signed-in user hold `auth.pin_unlock` (task 186b)? Drives whether the Settings "Unlock a
   * PIN" row is offered — the owner Unlock entry is absent for a non-owner. From the session snapshot,
   * so it re-derives on a user switch. Core still enforces the permission, so this is a UX gate.
   */
  readonly canUnlock: boolean;
  /**
   * The device directory as owner-unlock targets (task 186b), each with a caller-derived `lockedOut`
   * flag. Loaded on demand when the Unlock screen opens (the effect below), so the owner sees the
   * current lockout state rather than a snapshot from an earlier refresh. Bound to
   * `AppSessionController.listPinTargets`.
   */
  readonly listPinTargets: () => Promise<readonly PinTargetUser[]>;
  /**
   * Clear a target user's PIN lockout (api/02-auth §6.5.1; task 186b), driven by the session
   * controller as the acting owner. Resolves on success; REJECTS with the flow's DomainError so
   * `StaffPinScreen` maps it (`INVALID_TRANSITION → notLocked`). No verifier is computed — the
   * owner never learns the PIN — so unlike Change PIN there is nothing to drain afterward.
   */
  readonly onClearLockout: (targetUserId: string) => Promise<void>;
  /**
   * Does the signed-in user hold `auth.user_reset_pin` (task 186b-2)? Gates the Settings "Reset a PIN"
   * row. From the session snapshot; core still enforces it, so this is a UX gate.
   */
  readonly canReset: boolean;
  /**
   * Reset a target user's PIN to the owner-typed `newPin` (api/02-auth §6.6; task 186b-2), driven by the
   * session controller as the acting owner. Resolves on success; REJECTS with the flow's DomainError so
   * `StaffPinScreen` maps it (the §6.6 privileged-target refusal). Enqueues a verifier carrying the OWNER
   * as its actor, so the drain POSTs the owner in `X-Acting-User` (never the target).
   */
  readonly onResetPin: (targetUserId: string, newPin: string) => Promise<void>;
  /**
   * The owner's staff management, Settings › Karyawan (owner decision 2026-10-27). Absent for anyone
   * who may not add staff here, and on a build with no server wire; then the row is absent too.
   */
  readonly staff?: StaffControls | undefined;
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
  /**
   * Set while this device should be asked, once, to allow notifications (`push/permission.ts`):
   * `true` is "Nyalakan" (the OS prompt follows), `false` is "Nanti saja". Null when not asking.
   */
  readonly onAnswerNotifications?: ((allow: boolean) => void) | null | undefined;
}

export default function App(props: AppProps): React.JSX.Element {
  // Live system insets from the entry's SafeAreaProvider; null where there is none (tests, web).
  const safeArea = useContext(SafeAreaInsetsContext);
  const [route, setRoute] = useState<ShellRoute>('home');
  /** "PIN karyawan" opened from "Karyawan" for one person's first PIN; back returns to Karyawan. */
  const [staffPinFor, setStaffPinFor] = useState<string | null>(null);
  const [pinFor, setPinFor] = useState<string | null>(null);
  // Wrong PINs typed for one person since their pad opened. Each one remounts the pad in its error
  // state, which clears the dots and shows "PIN salah" again, even on a second wrong PIN in a row.
  const [wrongPins, setWrongPins] = useState<{ readonly userId: string; readonly count: number }>({
    userId: '',
    count: 0,
  });
  // A pad opened afresh starts clean, not with the last visit's "PIN salah".
  useEffect(() => setWrongPins({ userId: '', count: 0 }), [pinFor]);
  /**
   * The user asked to open the switcher while a session is open — the voluntary quick-switch
   * (task 143; api/02-auth §6.2). `resolveZone` turns this into the switcher zone only when a session
   * is live; it is cleared the moment the switch lands on a shell surface (abandoned back, or a
   * completed switch), so a stale intent can never re-open the roster over the incoming user's shell.
   */
  const [switching, setSwitching] = useState(false);
  // The avatar's menu (switch user, settings), open over the home surface.
  const [accountMenu, setAccountMenu] = useState(false);
  // The home tab (Servisan or Kas) is the person's own: whoever signs in next starts on Servisan.
  const [homeTab, setHomeTab] = useState<{ readonly userId: string; readonly tab: HomeTab }>({
    userId: '',
    tab: 'repair',
  });
  const { fontScale } = useWindowDimensions();
  /**
   * The user asked to RE-ENROL this device from the empty-roster switcher (task 168, D27). Feeds
   * `resolveZone`, which decides whether it is honoured — device status, an idle lock and a pending
   * PIN all beat it, so setting this can never render the wizard over a locked device.
   */
  const [reenrolling, setReenrolling] = useState(false);
  /** True while a login or enroll request is in flight (see `runLogin`). */
  const enrollRequestRef = useRef(false);
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
   * The owner's staff PIN list, loaded ON DEMAND when the `staffPins` route opens. The screen takes a
   * caller-loaded list; loading it only while that screen shows keeps a directory + per-user lockout
   * read off every other render. `loading` starts true so the screen shows its loading state until the
   * first read resolves — never an empty list flash before data.
   */
  const [pinTargets, setPinTargets] = useState<{
    readonly loading: boolean;
    readonly users: readonly PinTargetUser[];
    readonly error: string | null;
  }>({ loading: true, users: [], error: null });

  /**
   * ── WORK RETENTION ACROSS A LOCK (SEC-AUTH-08; task 155) ──────────────────────────────────────
   *
   * THE ONE DISTINCTION THIS CODE EXISTS TO GET RIGHT, in task 130's words: a transient null identity
   * is a LOCK, not a switch. `A → null → A` must return A's editor exactly as they left it (the
   * switcher promises it in so many words — "Pekerjaanmu aman", SwitcherScreen.tsx:7-11), while
   * `A → null → B` must land B on B's own home with none of A's work anywhere near the screen.
   * Retention that restored A's draft into B's session would be a PRIVACY DEFECT, not a UX bug.
   *
   * HOW THE DISTINCTION IS ENFORCED, in three layers, none of which is a comment:
   *   1. The KEY. `SessionManager` stores work under `userId` and hands back only that user's on
   *      `switchTo` (task 14); `restoreWorkspace` re-checks `ownerUserId` at the boundary (task 133).
   *      B's unlock therefore yields `emptyWorkspace(B)` — there is no path by which A's bytes are
   *      handed to B in the first place. That is the load-bearing control and it is not mine.
   *   2. NO SHELL-LOCAL COPY. `App` survives the lock (only the ZONE changes), so the obvious
   *      implementation — remember the draft in `useState` here and hand it back on remount — leaks
   *      A's work to B by construction. There is deliberately no such state: the ONLY draft this
   *      component knows is derived, every render, from the workspace of whoever is signed in NOW.
   *   3. The owner check below, which selects that workspace. Belt and braces over (1), in the same
   *      spirit as `ShellSession.snapshot`'s own — it makes a future refactor that starts forwarding
   *      a stale snapshot fail closed (empty screen) rather than open (B reads A's note).
   */
  const sessionUserId = props.session?.userId ?? null;
  const retained = props.workspace ?? null;
  const workspace =
    retained !== null && sessionUserId !== null && retained.ownerUserId === sessionUserId
      ? retained
      : null;

  /**
   * THE ROUTE COMES BACK WITH THE USER — and only with the RIGHT user (task 155, consuming task 133's
   * `withRoute`, which until now was a genuinely dead export).
   *
   * `route` is `App` state and `App` does not unmount across a lock, so without this the shell simply
   * kept whatever route was showing: A locked on Sync Status and B unlocked onto Sync Status, A's
   * position inherited by a different person. Adjusting state DURING render (React's documented
   * alternative to a prop-change effect) rather than in a `useEffect` is what keeps B from rendering
   * one frame of A's surface before the correction lands.
   *
   * `workspace` is null while locked and for a user with nothing retained, so the fallback is `home`
   * — B's own landing surface, never the outgoing user's.
   */
  const [routeOwner, setRouteOwner] = useState<string | null>(sessionUserId);
  /**
   * Where Back from Sync Status goes: the route it was opened from, however it was opened (a header
   * chip, the Settings row, a notification tap). Recorded during render, like `routeOwner`, so the
   * frame that first shows Sync Status already knows its way back. When that is `home`, the home
   * surface also stays mounted underneath (see the `shell` renderer), so the open servisan, its step
   * and anything typed are still there.
   */
  const [shownRoute, setShownRoute] = useState<ShellRoute>(route);
  const [syncReturn, setSyncReturn] = useState<ShellRoute>('home');
  if (routeOwner !== sessionUserId) {
    const restored = workspace?.route ?? 'home';
    setRouteOwner(sessionUserId);
    setRoute(restored);
    // Never another user's way back: a restored Sync Status returns home.
    setShownRoute(restored);
    setSyncReturn('home');
  } else if (shownRoute !== route) {
    setShownRoute(route);
    if (route === 'syncStatus') setSyncReturn(shownRoute);
  }

  /**
   * The freshest workspace, readable synchronously by the publishers below. A ref because two
   * publishes can happen in the SAME commit (a keystroke that also moved the route): the second must
   * compose onto the first's result, not onto the props of a render that has already been superseded.
   */
  const workspaceRef = useRef<UserWorkspace | null>(workspace);
  workspaceRef.current = workspace;
  const userIdRef = useRef<string | null>(sessionUserId);
  userIdRef.current = sessionUserId;
  const onWorkspaceChange = props.onWorkspaceChange;

  /**
   * Apply `mutate` to the ACTIVE user's workspace and write it through. No session ⇒ nothing is
   * retained: a lock has already cleared the identity, and a write with no owner is exactly the
   * cross-user smuggling the `ownerUserId` field exists to make impossible.
   *
   * A mutation that returns its own input publishes NOTHING — every write emits, and an emit
   * re-renders this tree, so an unconditional publish would be an infinite loop rather than a
   * write-through.
   */
  const publishWorkspace = useCallback(
    (mutate: (base: UserWorkspace) => UserWorkspace): void => {
      const userId = userIdRef.current;
      if (userId === null || onWorkspaceChange === undefined) return;
      const held = workspaceRef.current;
      const base = held !== null && held.ownerUserId === userId ? held : emptyWorkspace(userId);
      const next = mutate(base);
      if (next === base) return;
      workspaceRef.current = next;
      onWorkspaceChange(next);
    },
    [onWorkspaceChange],
  );

  /** The notes module's retained draft, re-derived every render — see layer 2 above. */
  const restoredNotesDraft = useMemo<NoteDraft | null>(
    () => (workspace === null ? null : parseNoteDraft(workspace.drafts[NOTES_MODULE_ID])),
    [workspace],
  );

  /**
   * The notes surface's write-through. Stable, so the editor's publish effect does not re-fire on
   * every render of this component — which is what stops the keystroke → publish → re-render →
   * publish cycle from running away.
   */
  const publishNotesDraft = useCallback(
    (draft: NoteDraft | null): void => {
      publishWorkspace((base) => {
        const current = base.drafts[NOTES_MODULE_ID] ?? null;
        // STRUCTURAL, not identity. The editor builds a fresh draft object on the render its publish
        // effect fires, so an identity check (`current === draft`) never matches an unchanged draft
        // and every render would write a new object — a re-render-per-write feedback loop that OOMs
        // the composed lane (observed). Comparing VALUES makes an equal re-publish a genuine no-op, so
        // only a real edit moves retention.
        if (sameNotesDraft(current, draft)) return base;
        return withDraft(base, NOTES_MODULE_ID, draft);
      });
    },
    [publishWorkspace],
  );

  /** The repair intake in progress, retained across a lock exactly like a notes draft. */
  const restoredIntakeDraft = useMemo<IntakeDraft | null>(
    () => (workspace === null ? null : parseIntakeDraft(workspace.drafts[REPAIR_MODULE_ID])),
    [workspace],
  );

  const publishIntakeDraft = useCallback(
    (draft: IntakeDraft | null): void => {
      publishWorkspace((base) => {
        const current = base.drafts[REPAIR_MODULE_ID] ?? null;
        // Structural, for the same reason as `publishNotesDraft`: an equal re-publish is a no-op.
        if (JSON.stringify(current) === JSON.stringify(draft)) return base;
        return withDraft(base, REPAIR_MODULE_ID, draft);
      });
    },
    [publishWorkspace],
  );

  // Record where this user is, continuously (never on a lock signal — by then the shell no longer
  // knows whose route it was; `shell-session.ts`'s header states the race in full).
  useEffect(() => {
    publishWorkspace((base) => (base.route === route ? base : withRoute(base, route)));
  }, [route, sessionUserId, publishWorkspace]);

  /**
   * Apply a notification-tap deep link (api/04-push §4). `Root` hands a FRESH `pushRoute` object per
   * tap, so a repeat tap to the same route re-navigates (object identity is the trigger); an unrelated
   * re-render passes the SAME object and this does nothing. The gate still decides what actually shows
   * — a tap while locked sets the route but `resolveZone` keeps the lock until a PIN unlock, then lands
   * on the requested surface. `null`/`undefined` (every non-tap render) is a no-op.
   */
  // Leg B (task 159): a tap that lands mid-switch must not fold into the switcher's `origin` — the same
  // drift `openSyncStatus` guards (task 145). Read `switching` through a ref so the effect stays keyed on
  // the TAP alone: adding `switching` to its deps would re-run on a later switcher open/close and re-fire
  // this stale `pushRoute` (a phantom navigation). The draft the tap would leave behind is already safe —
  // task 155 writes it through to retention on every keystroke, so this navigates without destroying it
  // (D23 §1: preserve-then-navigate; the "preserve" half is done by construction, no ConfirmSheet).
  const switchingRef = useRef(switching);
  switchingRef.current = switching;
  const pushRoute = props.pushRoute;
  useEffect(() => {
    if (pushRoute !== undefined && pushRoute !== null && !switchingRef.current) {
      setRoute(pushRoute.route);
    }
  }, [pushRoute]);

  /**
   * Load the owner-Unlock target list (task 186b). A closed CODE on failure, never a raw string — the
   * screen renders §5 Error from it. `loading: true` up front so a re-read shows loading, not stale
   * rows. The Unlock screen's `onReload` calls this directly (error retry); the effect below calls it
   * once on entry.
   */
  // `useLatestCallback` gives the loader a STABLE identity even though `Root` hands a fresh inline
  // `listPinTargets` arrow each render — without it the entry effect below re-fired on every unrelated
  // Root bump, flashing the list to its spinner and re-reading the DB (task 186b-1 review). `loadPinTargets`
  // depends only on that stable wrapper, so it too stays stable and the effect fires "only on entry".
  const listPinTargets = useLatestCallback(props.listPinTargets);
  const loadPinTargets = useCallback(() => {
    setPinTargets({ loading: true, users: [], error: null });
    void listPinTargets().then(
      (users) => setPinTargets({ loading: false, users, error: null }),
      (error: unknown) =>
        setPinTargets({ loading: false, users: [], error: errorCodeOrUnexpected(error) }),
    );
  }, [listPinTargets]);

  // Load the staff list when the owner's staff PIN screen opens, not before, and fresh on each ENTRY.
  // `loadPinTargets` is stable and the effect keys on the derived `onOwnerPicker` flag, so it fires only
  // when that flag TOGGLES, never on an unrelated Root bump that leaves the route put. The cleanup resets
  // to loading when the screen closes, so a later re-entry never flashes the previous visit's list.
  const onOwnerPicker = route === 'staffPins';
  useEffect(() => {
    if (!onOwnerPicker) return undefined;
    loadPinTargets();
    return () => setPinTargets({ loading: true, users: [], error: null });
  }, [onOwnerPicker, loadPinTargets]);

  // Stabilize the owner-flow callbacks the same way: each screen's submit effect depends on the callback,
  // so a fresh Root arrow mid-flow (a `finally` emit bumps Root) would re-fire the submit and run the
  // flow a SECOND time — `clearPinLockoutFlow`/`resetPin` then throw on the already-acted target and the
  // screen shows a spurious failure over a real success. The stable wrapper keeps each submit single-shot.
  const clearLockout = useLatestCallback(props.onClearLockout);
  const resetPin = useLatestCallback(props.onResetPin);

  const zone = resolveZone({
    device: props.device,
    session: props.session,
    locked: props.locked,
    pinFor,
    reenrolling,
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
  const signatureSurface = props.signature ?? null;
  const scanSurface = props.scan ?? null;
  const goBack = useCallback((): boolean => {
    if (accountMenu) {
      setAccountMenu(false);
      return true;
    }
    // A capture owns the screen while it runs (see the early return below), so back IS its cancel —
    // §8.1's "hardware back always equals the header back action", applied to the surface actually
    // showing. Without this the press would fall through to the zone underneath and navigate a tree
    // the user cannot see, leaving the viewfinder on top of it.
    if (captureSurface !== null) {
      captureSurface.onBack();
      return true;
    }
    if (signatureSurface !== null) {
      signatureSurface.onBack();
      return true;
    }
    if (scanSurface !== null) {
      scanSurface.onBack();
      return true;
    }
    // A module surface at `home` owns an internal stack the pure zone gate cannot see (NotesHome:
    // list→detail→editor). While it has somewhere to go back to, hardware back IS that surface's back
    // — routed through the editor's discard gate — never an app exit (design-system §8.1; task 145).
    if (
      zone.kind === 'shell' &&
      MODULE_SURFACE_ROUTES.has(zone.route) &&
      surfaceNavRef.current !== null
    ) {
      return surfaceNavRef.current.handleBack();
    }
    // The wizard asks before discarding typed input (§8.1) — BEFORE any target dispatch, because
    // where back would otherwise go is irrelevant to whether the user is about to lose work.
    //
    // This used to sit in the `exitApp` branch below, where it was DEAD: `backTarget` only returns
    // `exitApp` for `shell`+`home`, so `zone.kind === 'enrollment'` could never be true there. The
    // forced wizard's back fell into `target === null` and was silently swallowed; the voluntary
    // wizard task 168 added fell into the `switcher` branch and silently destroyed the typed input.
    // Found by a QA sweep of this surface. Checking here covers both, which is why it is not a
    // `voluntary`-only fix.
    if (zone.kind === 'enrollment' && needsDiscardConfirm(enrollment)) {
      setDiscardPrompt(true);
      return true;
    }
    const target = backTarget(zone);
    if (target === null) return true; // Nothing behind this surface — consume, never exit past a lock.
    if (target.kind === 'switcher') {
      // Back from the PIN pad to the roster — a mis-tapped face costs no attempt (§8.2). The switch is
      // still in progress, so `switching` STAYS set: clearing it here would drop straight to the shell.
      setPinFor(null);
      // `reenrolling` is the OPPOSITE case and must be cleared (task 168). `resolveZone` re-derives
      // the zone from state on every render, so leaving it set means back lands on the switcher and
      // the very next render computes the wizard again — a dead loop, and afterwards every
      // logged-out render shows the wizard instead of the roster for the life of the process.
      // Abandoning a voluntary re-enrolment is exactly what this clear makes possible.
      setReenrolling(false);
      return true;
    }
    if (target.kind === 'shellRoute') {
      // Landing on a shell surface ends any voluntary switch (task 143): the abandoned switcher returns
      // to its `origin`, a shell sub-route returns home. `setSwitching(false)` is a no-op off the
      // switcher and the load-bearing clear on it — without it `resolveZone` would re-open the roster.
      setPinFor(null);
      setSwitching(false);
      // Sync Status backs to where it was opened from, the same as its header back.
      setRoute(zone.kind === 'shell' && zone.route === 'syncStatus' ? syncReturn : target.route);
      return true;
    }
    return false; // Let Android exit.
  }, [accountMenu, zone, enrollment, captureSurface, signatureSurface, scanSurface, syncReturn]);

  // An idle lock or a sign-out takes the shell away under an open menu; it must not reappear after.
  useEffect(() => {
    if (zone.kind !== 'shell') setAccountMenu(false);
  }, [zone.kind]);

  // A phone enrolled before goes back to its own store, and its owner sees the unsynced changes
  // that will be carried over (core auth/carry-over.ts). Read each time the wizard opens.
  const inEnrollment = zone.kind === 'enrollment';
  const readHeldPhone = props.enrollment.heldPhone;
  useEffect(() => {
    if (!inEnrollment) return;
    let live = true;
    readHeldPhone()
      .then((phone) => {
        if (live) setEnrollment((s) => ({ ...s, phone }));
      })
      // Unreadable: the wizard still works, and core refuses a bind into another store anyway.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [inEnrollment, readHeldPhone]);

  // Hardware back IS the header back (§8.1) — one function, so they cannot drift.
  useHardwareBack(goBack);

  // Step 1 (§4.2): log in. On success, advance to the confirm step carrying the tenant/store choices;
  // auto-select the store when there is exactly one (nothing to disambiguate). On failure, bucket it
  // into one of the four human actions (`classifyFailure`) — never a raw server string.
  // `enrollRequestRef` closes the gap between a tap and the re-render that sets `busy`: two quick
  // taps both saw `busy: false` and fired two requests, and binding cannot be undone.
  const runLogin = (): void => {
    if (enrollRequestRef.current || enrollment.busy || !canSubmitCredentials(enrollment)) return;
    enrollRequestRef.current = true;
    setEnrollment((s) => ({ ...s, busy: true, failure: null }));
    props.enrollment
      .login({ loginIdentifier: enrollment.loginIdentifier.trim(), password: enrollment.password })
      .then((login) => setEnrollment((s) => afterLogin(s, login)))
      .catch((error: unknown) =>
        setEnrollment((s) => ({ ...s, busy: false, failure: classifyFailure(error) })),
      )
      .finally(() => {
        enrollRequestRef.current = false;
      });
  };

  // Step 2 (§4.3 + §4.1 steps 4–6): register + genesis + persist. The state is captured BEFORE the
  // async call so a concurrent edit cannot change what was submitted. On success the wizard shows the
  // done step; the enrolled-zone handoff and sync loop wait for the owner's Continue tap (`finish`,
  // §8.5 step 3) so the done step is not unmounted before it renders (task 201).
  const runEnroll = (): void => {
    if (enrollRequestRef.current || enrollment.busy || !canSubmitConfirm(enrollment)) return;
    const { login } = enrollment;
    const storeId = chosenStoreId(enrollment);
    if (login === null || storeId === null) return;
    const deviceName = enrollment.deviceName.trim();
    enrollRequestRef.current = true;
    setEnrollment((s) => ({ ...s, busy: true, failure: null }));
    props.enrollment
      .enroll({ login, storeId, deviceName })
      // The done step names the store from `selectedStoreId`, so it is set to what was bound.
      .then(() =>
        setEnrollment((s) => ({ ...s, busy: false, step: 'done', selectedStoreId: storeId })),
      )
      .catch((error: unknown) =>
        setEnrollment((s) => ({
          ...s,
          busy: false,
          failure: classifyFailure(error),
        })),
      )
      .finally(() => {
        enrollRequestRef.current = false;
      });
  };

  const chip = useMemo(() => syncChipState(props.sync), [props.sync]);
  const canSetIntakeOptions =
    props.repair !== undefined &&
    (props.repair.hasPermission(REPAIR_PERMISSION.manageIntakeOptions) ||
      props.repair.hasPermission(REPAIR_PERMISSION.hideIntakeOptions));
  const canSetCancelFees =
    props.repair !== undefined && props.repair.hasPermission(REPAIR_PERMISSION.setCancelFees);
  const canSetUncollectedDays =
    props.repair !== undefined && props.repair.hasPermission(REPAIR_PERMISSION.setUncollectedDays);
  const canSetPrintSettings =
    props.repair !== undefined && props.repair.hasPermission(REPAIR_PERMISSION.setPrintSettings);
  const backToSettings = useCallback(() => setRoute('settings'), []);
  const closeParts = useCallback(() => setRoute('home'), []);
  const setupPercent =
    props.sync.firstSync === null ? null : firstSyncPercent(props.sync.firstSync);
  // The ledger as the Kas screens read it: repair's money port, live on the same tables.
  const moneyRuntime = useMemo((): MoneyRuntime | null => {
    if (props.repair === undefined) return null;
    const users = props.users ?? [];
    return moneyRuntimeOf(
      props.repair,
      (userId) => users.find((user) => user.id === userId)?.name ?? null,
    );
  }, [props.repair, props.users]);
  // Kas is a tab for whoever counts the drawer or reads the store's money; others see no tabs.
  const showsKas =
    moneyRuntime !== null &&
    (moneyRuntime.hasPermission(MONEY_PERMISSION.read) ||
      moneyRuntime.hasPermission(MONEY_PERMISSION.countCash));
  // The list reads the methods as the payment step does, so it also needs `receive`.
  const canManageAccounts =
    moneyRuntime !== null &&
    moneyRuntime.hasPermission(MONEY_PERMISSION.receive) &&
    (moneyRuntime.hasPermission(MONEY_PERMISSION.manageAccounts) ||
      moneyRuntime.hasPermission(MONEY_PERMISSION.manageCentralAccounts));
  const currentUser = useMemo(() => {
    if (props.session === null) return null;
    const found = (props.users ?? []).find((user) => user.id === props.session?.userId);
    return found === undefined
      ? null
      : {
          id: found.id,
          initials: initialsOf(found.name),
          name: found.name,
          roleKeys: found.roleKeys,
        };
  }, [props.session, props.users]);

  const tab: HomeTab =
    showsKas && currentUser !== null && homeTab.userId === currentUser.id ? homeTab.tab : 'repair';
  const selectTab = useCallback(
    (next: HomeTab): void => setHomeTab({ userId: currentUser?.id ?? '', tab: next }),
    [currentUser],
  );
  /**
   * The home surface's back/leave with tabs. On Servisan it is repair's own. On Kas, back closes an
   * open Kas step or returns to Servisan (never an app exit from the second tab), and leaving home
   * still asks about a half-done intake on the hidden Servisan, after showing it.
   */
  const repairNavRef = useRef<SurfaceNav | null>(null);
  const kasNavRef = useRef<SurfaceNav | null>(null);
  const tabRef = useRef<HomeTab>(tab);
  const selectTabRef = useRef(selectTab);
  selectTabRef.current = selectTab;
  const syncHomeNav = useCallback((): void => {
    registerSurfaceNav(
      tabRef.current === 'repair'
        ? repairNavRef.current
        : {
            handleBack: () => {
              const kas = kasNavRef.current;
              if (kas !== null) return kas.handleBack();
              selectTabRef.current('repair');
              return true;
            },
            requestLeave: (proceed) => {
              const toServisan = (): void => {
                const repair = repairNavRef.current;
                if (repair === null) {
                  proceed();
                  return;
                }
                selectTabRef.current('repair');
                repair.requestLeave(proceed);
              };
              // A half-typed Kas step asks first, then the intake behind it.
              const kas = kasNavRef.current;
              if (kas === null) toServisan();
              else kas.requestLeave(toServisan);
            },
          },
    );
  }, [registerSurfaceNav]);
  const registerRepairNav = useCallback(
    (nav: SurfaceNav | null): void => {
      repairNavRef.current = nav;
      syncHomeNav();
    },
    [syncHomeNav],
  );
  // A Kas step holds what was typed only while it shows, so the tabs give way to its own back.
  const [kasStepOpen, setKasStepOpen] = useState(false);
  const registerKasNav = useCallback(
    (nav: SurfaceNav | null): void => {
      kasNavRef.current = nav;
      setKasStepOpen(nav !== null);
      syncHomeNav();
    },
    [syncHomeNav],
  );
  useEffect(() => {
    tabRef.current = tab;
    syncHomeNav();
  }, [tab, syncHomeNav]);

  // The shell's edge-to-edge insets, resolved once per render and applied at BOTH `bolusi-app-shell`
  // returns below — so the capture zone and the main zone can never drift on the top inset. The top
  // inset is read here (not at module scope) because `RNStatusBar.currentHeight` is not reliably ready
  // at bundle-eval; see `androidStatusBarInset`.
  const shellStyle = [styles.shell, { paddingTop: topInset(safeArea) }];

  // The chrome for a capture or signature surface: the sync chip goes to Sync Status the way every
  // other screen's does; the avatar slot stays empty so the identity cannot switch mid-capture.
  const modalSyncChip = (
    <SyncChip
      state={chip}
      pendingCount={props.sync.pendingOperationCount}
      progressPercent={setupPercent}
      accessibilityLabels={syncChipAccessibilityLabels({
        pendingCount: props.sync.pendingOperationCount,
        firstSyncPercent: setupPercent,
      })}
      onPress={openSyncStatus}
    />
  );

  /*
   * THE CAPTURE OR SIGNATURE SURFACE COVERS THE SCREEN, BUT ONLY INSIDE THE SHELL ZONE.
   *
   * It is an OVERLAY above the zone, never a replacement for it. The screen that asked for the photo
   * (a repair step holding the photos taken so far, the intake wizard, the notes editor) awaits the
   * capture's promise in its own state, so it must stay mounted underneath: returning the camera
   * INSTEAD of the zone unmounted it, and the photo resolved into a screen that no longer existed.
   * Guarded by `the screen that asked for the photo stays mounted` in
   * `test/live-shell-dead-controls.test.tsx`.
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
  const capture = zone.kind === 'shell' ? captureSurface : null;
  const signing = zone.kind === 'shell' ? signatureSurface : null;
  const scanning = zone.kind === 'shell' ? scanSurface : null;
  const modal =
    capture !== null ? (
      <CaptureScreen
        // Already-localized, per `CaptureScreenProps.title`. `media.action.takePhoto` is the
        // catalog's own name for this action ("Ambil Foto") — no new key, no hardcoded string.
        title={capture.title ?? t('media.action.takePhoto')}
        state={capture.state}
        preview={capture.preview}
        syncChip={modalSyncChip}
        avatar={<View testID="capture-no-avatar" />}
        onShutter={capture.onShutter}
        onRetake={capture.onRetake}
        onUsePhoto={capture.onUsePhoto}
        onRetry={capture.onRetry}
        onBack={capture.onBack}
      />
    ) : signing !== null ? (
      <SignaturePadScreen
        title={signing.title}
        state={signing.state}
        strokes={signing.strokes}
        syncChip={modalSyncChip}
        avatar={<View testID="signature-no-avatar" />}
        onStrokeStart={signing.onStrokeStart}
        onStrokeMove={signing.onStrokeMove}
        onStrokeEnd={signing.onStrokeEnd}
        onClear={signing.onClear}
        onSave={signing.onSave}
        onRetry={signing.onRetry}
        onBack={signing.onBack}
        onPadLayout={signing.onPadLayout}
      />
    ) : scanning !== null ? (
      <ScanScreen
        state={scanning.state}
        preview={scanning.preview}
        syncChip={modalSyncChip}
        avatar={<View testID="scan-no-avatar" />}
        onBack={scanning.onBack}
      />
    ) : null;

  return (
    <View testID="bolusi-app-shell" style={shellStyle}>
      {/* Dark icons: the app is light-only (app.config.ts), even when the phone is in dark mode. */}
      <StatusBar style="dark" />
      <View
        // A new system font size remounts the screens. Re-measuring in place does not hold on
        // Android: the next React commit brings back its own text nodes, measured at the old size,
        // so text drew at the new size inside old boxes (QA runs on PR #45). Fresh nodes measure
        // at the new size. MainActivity tells JS the new scale (withActivityConfigChanges.ts).
        // Work in progress survives: drafts live in the workspace above.
        key={`font-${fontScale}`}
        style={styles.zone}
        // Hidden from touch and screen readers while the overlay covers it, but still mounted.
        pointerEvents={modal === null ? 'auto' : 'none'}
        accessibilityElementsHidden={modal !== null}
        importantForAccessibility={modal === null ? 'auto' : 'no-hide-descendants'}
      >
        {renderZone(zone, {
          enrollment: (revoked) => (
            <EnrollmentScreen
              state={{ ...enrollment, revoked }}
              onChange={(patch) => setEnrollment((previous) => ({ ...previous, ...patch }))}
              onLogin={runLogin}
              onEnroll={runEnroll}
              // §8.5 step 3: the owner taps Continue on the success step. `finish` fires the deferred
              // `onEnrolled` (zone flip + loop/push start); resetting the wizard state is just hygiene for
              // a future re-enroll, since the zone has already handed off to the switcher (task 201).
              onFinish={() => {
                props.enrollment.finish();
                setEnrollment(initialEnrollmentState());
                // Same re-derivation hazard as the back path: the zone hands off to the switcher, and a
                // still-set `reenrolling` would immediately pull it back into the wizard (task 168).
                setReenrolling(false);
              }}
              onBack={goBack}
              discardPrompt={discardPrompt}
              onConfirmDiscard={() => {
                setDiscardPrompt(false);
                setEnrollment((previous) => ({
                  ...initialEnrollmentState(revoked),
                  phone: previous.phone,
                }));
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
              // §8.2's empty-roster recovery, LIVE since task 168 / D27 (which amends D23 §3). D23 §3
              // removed this control because nothing could service it: reaching Device Enrolment from
              // an `active` device needed a new input on `resolveZone`, and completing it left the old
              // registration `active` server-side. Both are now built — `reenrolling` feeds the gate
              // (device status, lock and pending PIN all still beat it), and the enrol request carries
              // `replacesDeviceId` so the server revokes the outgoing device in the same transaction.
              //
              // Still not a stub: the handler is REAL, and `EmptyState` renders the CTA only because
              // one exists. §5's "a control that cannot work must not render" is satisfied by the
              // control now working, not by hiding it.
              onReenroll={() => setReenrolling(true)}
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
              pendingCount={props.sync.pendingOperationCount}
              onOpenSync={openSyncStatus}
              currentUserId={switcherZone.mode === 'lock' ? null : sessionUserId}
              lockedUserIds={lockedUserIds(props.users, props.pinRow, props.now)}
            />
          ),
          pin: (pinZone) => {
            const signIn = (pin: string): void => {
              // Clear the pending PIN target only on a CONFIRMED unlock. On a wrong PIN the pad
              // stays exactly where it is (its own `state` renders the failure), which is why this
              // waits for the result rather than clearing optimistically — an optimistic clear
              // would drop a failed attempt straight into the shell.
              const submitted = props.onSubmitPin(pinZone.userId, pin);
              if (submitted !== undefined) {
                void submitted.then((opened) => {
                  if (!opened) {
                    setWrongPins((prior) => ({
                      userId: pinZone.userId,
                      count: prior.userId === pinZone.userId ? prior.count + 1 : 1,
                    }));
                  }
                  if (!opened) {
                    setWrongPins((prior) => ({
                      userId: pinZone.userId,
                      count: prior.userId === pinZone.userId ? prior.count + 1 : 1,
                    }));
                  }
                  if (opened) {
                    // The switch completed (§6.3's ops are appended inside `onSubmitPin`). Retire both
                    // the pending target AND the switch intent, so the gate lands on the incoming
                    // user's shell rather than re-rendering the roster over their session (task 143).
                    setPinFor(null);
                    setSwitching(false);
                  }
                });
              }
            };
            const user = userOf(props.users, pinZone.userId);
            const tap = user === undefined ? null : tapTarget(user);
            // §6.6: the enrolling owner with no PIN yet makes one, then is signed in with it. Anyone
            // else with no PIN is told to ask an owner (PinScreen's `needsFirstPin` state).
            if (
              tap?.kind === 'firstPinSetup' &&
              user !== undefined &&
              props.onSetFirstPin !== undefined
            ) {
              return (
                <PinSetupScreen
                  userId={pinZone.userId}
                  userName={user.name}
                  roleKeys={user.roleKeys}
                  onSetFirstPin={props.onSetFirstPin}
                  onSignIn={signIn}
                  onBack={() => setPinFor(null)}
                  syncChip={chip}
                  pendingCount={props.sync.pendingOperationCount}
                  onOpenSync={openSyncStatus}
                />
              );
            }
            const wrong = wrongPins.userId === pinZone.userId ? wrongPins.count : 0;
            return (
              <PinScreen
                key={`${pinZone.userId}:${wrong}`}
                userId={pinZone.userId}
                userName={nameOf(props.users, pinZone.userId)}
                roleKeys={user?.roleKeys}
                needsFirstPin={tap?.kind === 'askOwnerForPin'}
                row={props.pinRow(pinZone.userId)}
                now={props.now}
                lastAttempt={wrong > 0 ? 'wrong' : 'none'}
                onSubmit={signIn}
                onSwitchUser={() => setPinFor(null)}
                syncChip={chip}
                pendingCount={props.sync.pendingOperationCount}
                onOpenSync={openSyncStatus}
              />
            );
          },
          shell: (shellZone) => {
            // Switching user, or re-enrolling (which ends the session), unmounts the home surface
            // kept under Sync Status, so go back to it first and let its discard question run where
            // the person can see it.
            const leaveSyncStatusThen = (proceed: () => void): void => {
              if (syncReturn !== 'home') {
                proceed();
                return;
              }
              setRoute('home');
              leaveHome(proceed);
            };
            const syncStatus =
              shellZone.route === 'syncStatus' ? (
                <SyncStatusScreen
                  input={props.sync}
                  currentUser={currentUser}
                  onBack={() => setRoute(syncReturn)}
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
                  onOpenSwitcher={() => leaveSyncStatusThen(() => setSwitching(true))}
                  onReenroll={() => leaveSyncStatusThen(() => setReenrolling(true))}
                />
              ) : null;
            if (syncStatus !== null && syncReturn !== 'home') return syncStatus;
            // The chip on a settings page or the parts list: tapping it leaves through the page's guard.
            const routeSyncChip = (
              <SyncChip
                state={chip}
                pendingCount={props.sync.pendingOperationCount}
                accessibilityLabels={syncChipAccessibilityLabels({
                  pendingCount: props.sync.pendingOperationCount,
                })}
                onPress={() => leaveHome(() => setRoute('syncStatus'))}
              />
            );
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
                  onOpenChangePin={() => setRoute('changePin')}
                  // Owner-only: offered ONLY when the acting user may unlock or reset a colleague's PIN
                  // (`auth.pin_unlock` / `auth.user_reset_pin`); otherwise the row is absent.
                  onOpenStaffPins={
                    props.canUnlock || props.canReset ? () => setRoute('staffPins') : undefined
                  }
                  onOpenStaff={props.staff === undefined ? undefined : () => setRoute('staff')}
                  onOpenLimits={
                    props.staff?.canSetLimits === true ? () => setRoute('limits') : undefined
                  }
                  // The role editor is the main owner's alone.
                  onOpenRoles={
                    props.staff?.tenantAdmin === true ? () => setRoute('roles') : undefined
                  }
                  lockedStaffCount={
                    [...lockedUserIds(props.users, props.pinRow, props.now)].filter(
                      (id) => id !== currentUser.id,
                    ).length
                  }
                  // Each row for whoever may change it here: the store's settings for owners, the
                  // phone's paper for anyone who prints.
                  modules={[
                    {
                      section: tn('repair.board.title'),
                      testID: 'settings-section-repair',
                      rows: [
                        ...(canSetIntakeOptions
                          ? [
                              {
                                icon: 'list' as const,
                                title: tn('repair.options.title'),
                                summary: tn('repair.options.summary'),
                                onOpen: () => setRoute('intakeOptions'),
                                testID: 'settings-intake-options',
                              },
                            ]
                          : []),
                        ...(canSetCancelFees
                          ? [
                              {
                                icon: 'money' as const,
                                title: tn('repair.fees.title'),
                                summary: tn('repair.fees.summary'),
                                onOpen: () => setRoute('cancelFees'),
                                testID: 'settings-cancel-fees',
                              },
                            ]
                          : []),
                        ...(canSetUncollectedDays
                          ? [
                              {
                                icon: 'clock' as const,
                                title: tn('repair.uncollected.title'),
                                summary: tn('repair.uncollected.summary'),
                                onOpen: () => setRoute('uncollectedDays'),
                                testID: 'settings-uncollected-days',
                              },
                            ]
                          : []),
                        ...(canSetPrintSettings
                          ? [
                              {
                                icon: 'print' as const,
                                title: tn('repair.printSettings.title'),
                                summary: tn('repair.printSettings.summary'),
                                onOpen: () => setRoute('printSettings'),
                                testID: 'settings-print-settings',
                              },
                            ]
                          : []),
                        // The phone's own paper: anyone who prints here may set it.
                        ...(props.repair?.printing !== undefined
                          ? [
                              {
                                icon: 'paper' as const,
                                title: tn('repair.paper.title'),
                                summary: tn('repair.paper.phoneSummary'),
                                onOpen: () => setRoute('printPaper'),
                                testID: 'settings-print-paper',
                              },
                            ]
                          : []),
                      ],
                    },
                    {
                      section: tm('money.kas.title'),
                      testID: 'settings-section-money',
                      rows: canManageAccounts
                        ? [
                            {
                              icon: 'paymentMethods' as const,
                              title: tm('money.methods.title'),
                              summary: tm('money.methods.summary'),
                              onOpen: () => setRoute('paymentMethods'),
                              testID: 'settings-payment-methods',
                            },
                          ]
                        : [],
                    },
                  ]}
                  syncChip={chip}
                  pendingCount={props.sync.pendingOperationCount}
                  onOpenSync={openSyncStatus}
                />
              );
            }
            if (
              (shellZone.route === 'intakeOptions' ||
                shellZone.route === 'cancelFees' ||
                shellZone.route === 'uncollectedDays' ||
                shellZone.route === 'printSettings' ||
                shellZone.route === 'printPaper') &&
              props.repair !== undefined
            ) {
              return (
                <RepairSettingsRoute
                  page={shellZone.route}
                  runtime={props.repair}
                  syncChip={routeSyncChip}
                  onClose={backToSettings}
                  onRegisterSurfaceNav={registerSurfaceNav}
                />
              );
            }
            if (shellZone.route === 'paymentMethods' && moneyRuntime !== null) {
              return (
                <PaymentMethodsRoute
                  runtime={moneyRuntime}
                  syncChip={routeSyncChip}
                  onClose={backToSettings}
                  onRegisterSurfaceNav={registerSurfaceNav}
                />
              );
            }
            if (shellZone.route === 'parts' && props.repair?.inventory !== undefined) {
              return (
                <PartsRoute
                  runtime={props.repair.inventory}
                  syncChip={routeSyncChip}
                  onClose={closeParts}
                  onRegisterSurfaceNav={registerSurfaceNav}
                />
              );
            }
            if (shellZone.route === 'changePin') {
              // Reached from Settings (task 186a). `onChangePin` runs the real `auth.changePin` flow
              // through the session controller and REJECTS with its DomainError; the screen maps it.
              // Back / done returns to Settings — the surface it was opened from (see `backTarget`).
              return (
                <ChangePinScreen
                  person={currentUser ?? undefined}
                  onChangePin={props.onChangePin}
                  onClose={() => setRoute('settings')}
                />
              );
            }
            if (shellZone.route === 'staffPins') {
              // The owner's "PIN karyawan": unlock a locked PIN or have a colleague make a new one, each
              // offered only with its permission (core enforces both, plus the §6.6 privileged-target
              // rule). The list is loaded on entry (the effect above); back returns to Settings.
              return (
                <StaffPinScreen
                  canUnlock={props.canUnlock}
                  canReset={props.canReset}
                  loading={pinTargets.loading}
                  error={pinTargets.error}
                  users={pinTargets.users}
                  actorUserId={sessionUserId ?? ''}
                  onClearLockout={clearLockout}
                  onResetPin={resetPin}
                  onReload={loadPinTargets}
                  startWith={staffPinFor}
                  onClose={() => {
                    setRoute(staffPinFor === null ? 'settings' : 'staff');
                    setStaffPinFor(null);
                  }}
                  onRegisterSurfaceNav={registerSurfaceNav}
                />
              );
            }
            if (shellZone.route === 'staff' && props.staff !== undefined && currentUser !== null) {
              // The owner's "Karyawan": add, change and deactivate staff, online. A new person's first
              // PIN is made in "PIN karyawan", opened at their hand-over and returning here.
              const staff = props.staff;
              return (
                <StaffScreen
                  actor={{ userId: currentUser.id, tenantAdmin: staff.tenantAdmin }}
                  load={staff.load}
                  onCreate={staff.onCreate}
                  onUpdate={staff.onUpdate}
                  onSetActive={staff.onSetActive}
                  onMakePin={
                    props.canReset
                      ? (userId) => {
                          setStaffPinFor(userId);
                          setRoute('staffPins');
                        }
                      : undefined
                  }
                  onClose={() => setRoute('settings')}
                  onRegisterSurfaceNav={registerSurfaceNav}
                />
              );
            }
            if (shellZone.route === 'limits' && props.staff !== undefined && currentUser !== null) {
              // The store owner's "Batas wewenang": a limited role's amounts here, online.
              const staff = props.staff;
              return (
                <LimitsScreen
                  actor={{ userId: currentUser.id, tenantAdmin: staff.tenantAdmin }}
                  load={staff.load}
                  onSave={staff.onSetLimits}
                  onClose={() => setRoute('settings')}
                  onRegisterSurfaceNav={registerSurfaceNav}
                />
              );
            }
            if (shellZone.route === 'roles' && props.staff?.tenantAdmin === true) {
              // The main owner's "Tugas karyawan": the store roles and their switches, online.
              const staff = props.staff;
              return (
                <RolesScreen
                  load={staff.load}
                  onCreate={staff.onCreateRole}
                  onUpdate={staff.onUpdateRole}
                  onDelete={staff.onDeleteRole}
                  onClose={() => setRoute('settings')}
                  onRegisterSurfaceNav={registerSurfaceNav}
                />
              );
            }
            const homeSurface = (): React.JSX.Element => {
              // `home` is the module surface (task 96): the notes screens, when a live `NotesRuntime` is
              // available. The session IS wired now (task 119); `props.notes` is `undefined` only when there
              // is no runtime at all — an unenrolled device, or the Node/test harness with no media pipeline
              // (`CaptureHost`: "null on a device with no media pipeline (never enrolled)"). In that case it
              // stays the empty shell rather than a placeholder string — a hardcoded "coming soon" is exactly
              // the copy the label catalog exists to prevent (07-i18n).
              if (props.notes === undefined && props.repair === undefined) {
                return <View testID="shell-home" style={FILL} />;
              }
              // The header chrome every home surface shares (§8.1).
              const homeSyncChip = (
                <SyncChip
                  state={chip}
                  pendingCount={props.sync.pendingOperationCount}
                  progressPercent={setupPercent}
                  accessibilityLabels={syncChipAccessibilityLabels({
                    relative:
                      props.sync.state.lastSuccessfulSyncAt === null
                        ? t('core.status.empty')
                        : formatRelative(props.now - props.sync.state.lastSuccessfulSyncAt),
                    pendingCount: props.sync.pendingOperationCount,
                    firstSyncPercent: setupPercent,
                  })}
                  // No leave guard: Sync Status keeps the surface mounted, so nothing is lost.
                  onPress={openSyncStatus}
                />
              );
              const homeAvatar =
                currentUser === null ? (
                  <View testID="notes-no-avatar" />
                ) : (
                  // THE HEADER CHROME (§8.1): the avatar, which opens the account menu: switch user
                  // (the User Switcher) and Settings. It is the ONLY producer of `route: 'settings'`.
                  //
                  // Settings holds the language toggle, the owner's intake lists, the PIN and
                  // notification rows and the device readout. On an Indonesian-first product the
                  // language rows are the ONLY way out of a wrong locale (07-i18n §1.2), so both menu
                  // rows carry an icon that reads by shape: a cog and a person swap.
                  //
                  // THE AVATAR → SWITCHER HOP §8.1 DESCRIBES (task 143) now goes through the menu.
                  // `setSwitching(true)` produces the switcher zone from a live session, and
                  // `backTarget` returns to `home` (this surface's route) when the switch is abandoned.
                  // Both rows go through `leaveHome` (task 145), so an open editor's discard gate runs
                  // before either leaves the surface.
                  <AvatarButton
                    userId={currentUser.id}
                    initials={currentUser.initials}
                    accessibilityLabel={t('core.account.menu')}
                    onPress={() => setAccountMenu(true)}
                  />
                );
              // Repair is the slice-1 home; notes stays the home on a build without it.
              if (props.repair !== undefined) {
                const repairHome = (
                  <RepairHome
                    runtime={props.repair}
                    // The clock itself, not this render's reading: an intake can sit open for hours.
                    now={props.clock ?? systemClock.now}
                    onRegisterSurfaceNav={registerRepairNav}
                    restoredDraft={restoredIntakeDraft}
                    onDraftChange={publishIntakeDraft}
                    onOpenSyncStatus={openSyncStatus}
                    syncChip={homeSyncChip}
                    avatar={homeAvatar}
                  />
                );
                if (!showsKas || moneyRuntime === null) return repairHome;
                // Servisan stays mounted behind Kas, so a half-done intake survives a look at the
                // drawer. Kas holds nothing worth keeping, so it is only there while it shows.
                return (
                  <View style={FILL}>
                    <View style={tab === 'repair' ? FILL : HIDDEN}>{repairHome}</View>
                    {tab === 'kas' ? (
                      <KasHome
                        runtime={moneyRuntime}
                        now={props.clock ?? systemClock.now}
                        syncChip={homeSyncChip}
                        avatar={homeAvatar}
                        onRegisterSurfaceNav={registerKasNav}
                      />
                    ) : null}
                    {tab === 'kas' && kasStepOpen ? null : (
                      <TabBar
                        tabs={[
                          { key: 'repair', label: tn('repair.board.title'), icon: 'repair' },
                          { key: 'kas', label: tm('money.kas.title'), icon: 'money' },
                        ]}
                        selected={tab}
                        onSelect={selectTab}
                        testID="shell-tabs"
                      />
                    )}
                  </View>
                );
              }
              if (props.notes === undefined) return <View testID="shell-home" style={FILL} />;
              return (
                <NotesHome
                  runtime={props.notes}
                  now={props.now}
                  // The surface publishes its internal back/leave here (task 145) — see `leaveHome`/`goBack`.
                  onRegisterSurfaceNav={registerSurfaceNav}
                  // SEC-AUTH-08 retention (task 155): the draft this user had in flight when they last
                  // locked (owner-checked above, so it is theirs), and the write-back that keeps it
                  // current. On a clean editor `restoredNotesDraft` is null and nothing is restored.
                  restoredDraft={restoredNotesDraft}
                  onDraftChange={publishNotesDraft}
                  onOpenSyncStatus={openSyncStatus}
                  syncChip={homeSyncChip}
                  avatar={homeAvatar}
                />
              );
            };
            // Sync Status opened from home sits OVER the home surface instead of replacing it: the
            // surface keeps its own state (the open servisan, its step, anything typed), so Back lands
            // exactly where the person was. Same element shape on both routes, so React keeps it mounted.
            return (
              <>
                <View
                  key="home"
                  testID="shell-home-surface"
                  style={syncStatus === null ? FILL : HIDDEN}
                  accessibilityElementsHidden={syncStatus !== null}
                  importantForAccessibility={syncStatus === null ? 'auto' : 'no-hide-descendants'}
                >
                  {homeSurface()}
                </View>
                {syncStatus}
              </>
            );
          },
        })}
      </View>
      {accountMenu && currentUser !== null && zone.kind === 'shell' ? (
        <Sheet
          title={currentUser.name}
          subtitle={roleLabel(currentUser.roleKeys) || undefined}
          leading={
            <Avatar
              userId={currentUser.id}
              initials={currentUser.initials}
              size="row"
              testID="account-menu-avatar"
            />
          }
          closeLabel={t('core.action.close')}
          onClose={() => setAccountMenu(false)}
          testID="account-menu"
        >
          <View style={styles.menuRows}>
            <ListRow
              leading={<Icon name="switchUser" size={size.iconInline} color={color.text} />}
              primaryText={t('core.account.switchUser')}
              onPress={() => {
                setAccountMenu(false);
                leaveHome(() => setSwitching(true));
              }}
              testID="account-menu-switch-user"
            />
            {props.repair?.inventory?.hasPermission(INVENTORY_PERMISSION.read) === true ? (
              <ListRow
                leading={<Icon name="parts" size={size.iconInline} color={color.text} />}
                primaryText={ti('inventory.list.title')}
                onPress={() => {
                  setAccountMenu(false);
                  leaveHome(() => setRoute('parts'));
                }}
                testID="shell-open-parts"
              />
            ) : null}
            <ListRow
              leading={<Icon name="settings" size={size.iconInline} color={color.text} />}
              primaryText={t('core.settings.title')}
              onPress={() => {
                setAccountMenu(false);
                leaveHome(() => setRoute('settings'));
              }}
              testID="shell-open-settings"
            />
          </View>
        </Sheet>
      ) : null}
      {props.onAnswerNotifications != null &&
      zone.kind === 'shell' &&
      !accountMenu &&
      modal === null ? (
        // On the work screen, after unlock, with the reason before the OS asks (never at boot).
        <ConfirmSheet
          tone="primary"
          title={t('push.permission.title')}
          message={t('push.permission.message')}
          confirmLabel={t('push.permission.allow')}
          onConfirm={() => props.onAnswerNotifications?.(true)}
          cancelLabel={t('push.permission.later')}
          onCancel={() => props.onAnswerNotifications?.(false)}
          testID="notification-ask"
        />
      ) : null}
      {modal === null ? null : <View style={[StyleSheet.absoluteFill, shellStyle]}>{modal}</View>}
    </View>
  );
}

/** Users whose PIN is locked on this device, read from the same lockout machine as the PIN pad. */
function lockedUserIds(
  users: readonly SwitcherUser[] | null,
  pinRow: (userId: string) => PinAttemptRow | null,
  now: number,
): ReadonlySet<string> {
  return new Set(
    (users ?? [])
      .filter((user) => pinView(pinRow(user.id), now, 'none').kind === 'lockedOut')
      .map((user) => user.id),
  );
}

function userOf(users: readonly SwitcherUser[] | null, userId: string): SwitcherUser | undefined {
  return (users ?? []).find((user) => user.id === userId);
}

function nameOf(users: readonly SwitcherUser[] | null, userId: string): string {
  return userOf(users, userId)?.name ?? '';
}

/**
 * VALUE equality between a stored draft (opaque `unknown` off the workspace) and the editor's freshly
 * built one (task 155). This is the guard that makes an unchanged re-publish a no-op — see
 * `publishNotesDraft`. A media ref is identified by `mediaId` + `sha256` (its signed identity, 06 §6),
 * so key-order or object-identity differences after a restore round-trip do not read as a change.
 */
function sameNotesDraft(stored: unknown, next: NoteDraft | null): boolean {
  if (stored === null || stored === undefined) return next === null;
  if (next === null) return false;
  const a = stored as NoteDraft;
  return (
    a.mode === next.mode &&
    a.noteId === next.noteId &&
    a.title === next.title &&
    a.body === next.body &&
    sameMediaRef(a.mediaRef, next.mediaRef)
  );
}

function sameMediaRef(a: NoteDraft['mediaRef'], b: NoteDraft['mediaRef']): boolean {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  return a.mediaId === b.mediaId && a.sha256 === b.sha256;
}

/** The home surface's tabs, shown when the person may see Kas. */
type HomeTab = 'repair' | 'kas';

const FILL = { flex: 1 } as const;
const HIDDEN = { display: 'none' } as const;

/**
 * Shell routes whose module surface keeps its own stack and publishes a `SurfaceNav` (task 145), so
 * hardware back asks the surface first: the repair/notes home, and the owner's repair settings.
 */
const MODULE_SURFACE_ROUTES: ReadonlySet<ShellRoute> = new Set([
  'home',
  'intakeOptions',
  'cancelFees',
  'uncollectedDays',
  'staff',
  'staffPins',
  'limits',
  'roles',
  'printSettings',
  'printPaper',
  'parts',
  'paymentMethods',
]);

/**
 * Fallback status-bar inset (dp) for the rare render where `RNStatusBar.currentHeight` is not yet
 * populated. 24 dp is the standard Android status-bar height; over-insetting by a hairline is harmless,
 * under-insetting occludes a control (see `androidStatusBarInset`), so the fallback errs high, never 0.
 */
const ANDROID_STATUS_BAR_FALLBACK_DP = 24;

/**
 * Android 15 (Expo SDK 57 / RN 0.81, targetSdk 35) enforces edge-to-edge: the app draws under the
 * system status bar, whose window sits z-above ours and eats any touch that lands in it. The header
 * chrome (sync chip, language chip, avatar) is laid out at y=0, so at center it falls under the
 * status bar and is un-tappable — invisible to prop-level render tests, caught only on-device.
 * Inset the shell by the status-bar height so the header (and body) render below it. This is the
 * fallback behind the live safe-area inset (`topInset`), for a render before the insets arrive.
 *
 * READ AT RENDER, never at module-eval. `RNStatusBar.currentHeight` is a native constant marshalled
 * across the bridge; on a cold launch it is not reliably populated the instant the JS bundle evaluates.
 * A module-scope `const STATUS_BAR_INSET = RNStatusBar.currentHeight ?? 0` (the shape this replaced)
 * froze whatever was there at import — on the emulator lane that was 0, so the shell got `paddingTop: 0`,
 * the header drew under the status bar, and its language chip was occluded, absent from the a11y
 * hierarchy, and un-tappable (flow 06 flaked; the same run's warmer flow 03 inset correctly and passed).
 * Calling this per render moves the read past bundle-eval so the constant is populated in the normal
 * case, and the non-zero fallback guarantees the header is never un-inset even on a render where the
 * value is still missing. Reading here (not at module scope) also means importing `App` performs no
 * native member read (task 207).
 */
function androidStatusBarInset(): number {
  if (Platform.OS !== 'android') return 0;
  const measured = RNStatusBar.currentHeight;
  return typeof measured === 'number' && measured > 0 ? measured : ANDROID_STATUS_BAR_FALLBACK_DP;
}

/**
 * The shell's top inset. The live safe-area inset when the entry provides one: it follows a tablet
 * turning, where the status bar's height changes and `currentHeight`, read once at launch, does not
 * (a header launched in landscape slid under the taller portrait status bar). The status-bar read is
 * the fallback for a render before the insets arrive, and where there is no provider.
 */
function topInset(safeArea: EdgeInsets | null): number {
  if (safeArea !== null && safeArea.top > 0) return safeArea.top;
  return androidStatusBarInset();
}

const styles = StyleSheet.create({
  /**
   * The app shell: fills the screen and clears the system nav bar so the bottom-docked primary action
   * stays tappable under edge-to-edge (§8.1). The TOP inset is applied per render via
   * `topInset()` (see its docblock) — a static `paddingTop` here would freeze a possibly-
   * unpopulated status-bar height at module-eval.
   *
   * `NAV_BAR_INSET` now lives in `@bolusi/ui` (`platform-insets.ts`), where its docblock explains the
   * 48 dp figure. It moved because surfaces mounted OUTSIDE this shell — the ConfirmSheet overlay —
   * need the same measurement and were silently missing it (task 205).
   */
  // Painted, so the bands under the status and navigation bars match the screens.
  shell: { flex: 1, paddingBottom: NAV_BAR_INSET, backgroundColor: color.surface },
  zone: { flex: 1 },
  /** The header-right group's own spacing rule (§1.4 `touch.gap`) — adjacent targets never touch. */
  // The menu's rows run edge to edge, like every list.
  menuRows: { marginHorizontal: -space.lg },
});
