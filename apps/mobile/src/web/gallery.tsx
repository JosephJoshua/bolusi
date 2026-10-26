/**
 * The screen × state registry the react-native-web visual harness renders (task 116).
 *
 * Each entry renders ONE real screen component (imported, never modified — the harness RENDERS the
 * shipping screens, it does not fork them) in ONE state, wrapped in `ApproxFrame` so every screenshot
 * carries the "RNW browser approximation — NOT device-verified" label and a stable outer testID the
 * Playwright suite navigates by (`?screen=<screen>&state=<state>`).
 *
 * Most entries are STATIC (fixed demo props → a deterministic state for the four-states screenshots).
 * A few are INTERACTIVE wrappers (`PinInteractive`, `SettingsInteractive`, `EnrollmentInteractive`)
 * that hold the small piece of React state a genuine interaction needs — a PIN key press, an ID↔EN
 * language toggle, opening the discard `ConfirmSheet` — so the browser-rendered screen actually
 * RESPONDS and the suite can assert real DOM changes rather than "a screenshot was taken".
 */
/* eslint-disable bolusi/no-hardcoded-strings --
 * This is a DEV-ONLY visual harness (task 116), never shipped and never in the native bundle. Its
 * strings — demo screen titles, seeded names, and harness chrome ("harness: back", the camera
 * placeholder) — must NOT go through @bolusi/i18n: the catalog is for shipping UI and is guarded by
 * the id/en parity gate (07-i18n §7.3), which pollution with dev copy would corrupt. The REAL screens
 * this harness renders resolve every user-visible label through the catalog, unchanged. */
import { getLocale, setLocale, type Locale } from '@bolusi/i18n';
import type { PinAttemptRow } from '@bolusi/core';
import { border, color, space, type } from '@bolusi/ui';
import { useReducer, useState, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import App from '../../App.js';
import { CaptureScreen, type CaptureScreenState } from '../media/CaptureScreen.js';
import { SignaturePadScreen, type SignaturePadState } from '../media/SignaturePadScreen.js';
import {
  initialEnrollmentState,
  needsDiscardConfirm,
  type EnrollmentState,
  type EnrollmentStep,
} from '../screens/enrollment/model.js';
import { EnrollmentScreen } from '../screens/enrollment/EnrollmentScreen.js';
import { ChangePinScreen } from '../screens/pin/ChangePinScreen.js';
import type { PinTargetUser } from '../screens/pin/pin-target.js';
import type { SwitcherUser } from '../screens/switcher/model.js';
import { PinScreen } from '../screens/pin/PinScreen.js';
import { PinSetupScreen } from '../screens/pin/PinSetupScreen.js';
import { StaffPinScreen } from '../screens/pin/StaffPinScreen.js';
import { SettingsScreen } from '../screens/settings/SettingsScreen.js';
import { SyncStatusScreen } from '../screens/sync-status/SyncStatusScreen.js';
import { SwitcherScreen } from '../screens/switcher/SwitcherScreen.js';
import type { AppProps } from '../../App.js';

import { DEMO_REPAIR_ROLES, demoRepairRuntime, type DemoRepairRole } from './repair-demo.js';
import {
  DEMO_DEVICE_INFO,
  DEMO_LOGIN,
  DEMO_PIN_ROWS,
  DEMO_REJECTED_OP_ID,
  DEMO_USERS,
  HARNESS_NOW,
  SYNC_STATUS_STATES,
  demoSyncInput,
  demoNotesRuntime,
  fakeEnrollmentController,
} from './seed.js';

function noop(): void {
  /* harness stub — the shipping wiring lives in Root.tsx / the screens' callers. */
}

const CURRENT_USER = { id: 'u-andi', initials: 'AP' } as const;
/** The same person as Settings shows them: name and role. */
const CURRENT_PERSON = { id: 'u-andi', name: 'Andi Pratama', roleKeys: ['main_owner'] } as const;

/** A busy store's roster: enough staff that the switcher grows a search box, with long names. */
const MANY_STAFF: readonly SwitcherUser[] = [
  ...DEMO_USERS,
  ...[
    'Yohanis Mandowen',
    'Maria Kogoya',
    'Petrus Yikwa',
    'Ester Mandowen',
    'Agustinus Wenda',
    'Fransiska Rumbiak',
    'Kristian Tabuni',
    'Natalia Wamafma Rumbekwan',
    'Lukas Enembe',
    'Selfina Ayomi',
  ].map((name, index) => ({
    id: `u-staff-${String(index)}`,
    name,
    photoMediaId: null,
    lastActiveAt: index < 4 ? HARNESS_NOW - (index + 5) * 3_600_000 : null,
    needsFirstPin: false,
    roleKeys: index % 3 === 0 ? ['technician'] : ['cashier'],
  })),
];

/** A ReactNode slot the harness fills where a screen wants a chip/avatar it does not screenshot. */
function slot(testID: string): ReactNode {
  return <View testID={testID} />;
}

/**
 * The mandatory label every artifact carries (task 116 / design-system): a thin top strip stating
 * this is the browser approximation, never the device lane. Rendered in the DOM so it is captured in
 * every screenshot and assertable by the suite.
 */
function ApproxFrame({
  screen,
  state,
  children,
}: {
  readonly screen: string;
  readonly state: string;
  readonly children: ReactNode;
}): React.JSX.Element {
  return (
    <View testID={`web-harness-${screen}-${state}`} style={styles.frame}>
      <View testID="rnw-approx-label" style={styles.label}>
        <Text style={styles.labelText}>RNW browser approximation — NOT device-verified</Text>
      </View>
      <View style={styles.body}>{children}</View>
    </View>
  );
}

// ── Interactive wrappers ─────────────────────────────────────────────────────────────────────────

/**
 * PIN pad — the pad is internally stateful (buffers key presses, exposes progress as the entry
 * region's `aria-valuenow`), so the interaction assertion (`tap a key → count goes up`) works with no
 * wrapper state. The wrapper adds only a visible proof of the value's ONE egress: `onComplete` fires
 * on the 6th digit and the harness shows a marker — never the PIN itself (PinPad's contract: the
 * entered value has exactly one egress and is never rendered as text).
 */
function PinInteractive(): React.JSX.Element {
  const [submitted, setSubmitted] = useState(false);
  return (
    <View style={styles.body}>
      <PinScreen
        userId="u-andi"
        userName="Andi Pratama"
        row={null}
        now={HARNESS_NOW}
        lastAttempt="none"
        onSubmit={() => setSubmitted(true)}
        onSwitchUser={noop}
        syncChip="synced"
        pendingCount={0}
        onOpenSync={noop}
      />
      {submitted ? <Text testID="pin-submitted">PIN submitted (value never rendered)</Text> : null}
    </View>
  );
}

/**
 * Settings with a LIVE language toggle. `onSelectLocale` calls the real `setLocale` (i18next
 * `changeLanguage`, applied synchronously — `initAsync: false`) and forces a re-render, exactly what
 * `Root.tsx` does on a device. So tapping the English row switches every `t()` label from Indonesian
 * to English — the ID↔EN interaction the suite asserts.
 */
function SettingsInteractive(): React.JSX.Element {
  const [, force] = useReducer((n: number) => n + 1, 0);
  const locale: Locale = getLocale();
  return (
    <SettingsScreen
      locale={locale}
      onSelectLocale={(next) => {
        setLocale(next);
        force();
      }}
      onOpenNotificationSettings={noop}
      device={DEMO_DEVICE_INFO}
      currentUser={CURRENT_PERSON}
      onBack={noop}
      onOpenSwitcher={noop}
      onOpenChangePin={noop}
      onOpenStaffPins={noop}
      lockedStaffCount={1}
      repair={{
        section: 'Servisan',
        rows: [
          {
            icon: 'list',
            title: 'Pilihan saat terima HP',
            summary: 'Cek fungsi, kelengkapan, sisi HP yang difoto',
            onOpen: noop,
            testID: 'settings-intake-options',
          },
          {
            icon: 'money',
            title: 'Biaya pembatalan',
            summary: 'Dibayar pelanggan kalau servisan dibatalkan',
            onOpen: noop,
            testID: 'settings-cancel-fees',
          },
        ],
      }}
      syncChip="synced"
      pendingCount={0}
      onOpenSync={noop}
    />
  );
}

/**
 * The enrollment wizard, driven far enough to open the real discard `ConfirmSheet`. The harness
 * "back" control runs the SAME gate the shell runs on a device (`needsDiscardConfirm` — a back press
 * on typed input asks first, §8.1); when it fires, `discardPrompt` flips and the screen renders its
 * real `ConfirmSheet`. Confirm resets the wizard, cancel dismisses the sheet — both the real handlers.
 */
function EnrollmentInteractive({
  revoked,
  step,
  over = {},
}: {
  readonly revoked: boolean;
  readonly step: EnrollmentStep;
  /** A case on top of the step: one store, a picked store, a failed attempt. */
  readonly over?: Partial<EnrollmentState>;
}): React.JSX.Element {
  const [state, setState] = useState<EnrollmentState>(() => ({ ...initial(), ...over }));
  function initial(): EnrollmentState {
    const base = initialEnrollmentState(revoked);
    if (step === 'confirm') {
      return {
        ...base,
        step,
        login: DEMO_LOGIN,
        // Two stores: nothing is preselected, as in the app (App.tsx runLogin).
        selectedStoreId: null,
      };
    }
    if (step === 'done') {
      return {
        ...base,
        step,
        login: DEMO_LOGIN,
        selectedStoreId: DEMO_LOGIN.stores[0]?.id ?? null,
      };
    }
    return base;
  }
  const [discardPrompt, setDiscardPrompt] = useState(false);
  return (
    <View style={styles.body}>
      <EnrollmentScreen
        state={state}
        onChange={(patch) => setState((s) => ({ ...s, ...patch }))}
        onLogin={() =>
          setState((s) => ({
            ...s,
            step: 'confirm',
            login: DEMO_LOGIN,
            selectedStoreId: null,
          }))
        }
        onEnroll={() => setState((s) => ({ ...s, step: 'done' }))}
        onFinish={() => setState(initialEnrollmentState())}
        onBack={() => {
          if (needsDiscardConfirm(state)) setDiscardPrompt(true);
        }}
        discardPrompt={discardPrompt}
        onConfirmDiscard={() => {
          setDiscardPrompt(false);
          setState(initialEnrollmentState(revoked));
        }}
        onCancelDiscard={() => setDiscardPrompt(false)}
      />
      {/* Harness-only affordance: web has no Android hardware-back, so this triggers the shell's real
          back gate. It is NOT part of the screen — it stands in for the platform back button. */}
      <Text
        testID="harness-enroll-back"
        accessibilityRole="button"
        onPress={() => {
          if (needsDiscardConfirm(state)) setDiscardPrompt(true);
        }}
        style={styles.harnessButton}
      >
        harness: back
      </Text>
    </View>
  );
}

/**
 * App-mode: the FULL prop-driven `App` (its RootNavigator gate → real screens), fed the demo seed.
 * `session: null` lands on the User Switcher (the enrolled-device happy path); a `session` value
 * lands on the shell home surface — which, since task 119, IS the notes module surface: `App.notes`
 * receives a `NotesRuntime`, so `app/shell` now screenshots the real `NotesList` over demo data
 * instead of the empty `shell-home` placeholder it used to render. Proves the whole navigation gate
 * renders real screens from fake data, not just isolated components.
 */
function AppMode({
  session,
  repairRole,
}: {
  readonly session: AppProps['session'];
  /** Puts the repair module on the home surface, signed in as this demo role. */
  readonly repairRole?: DemoRepairRole;
}): React.JSX.Element {
  const [, force] = useReducer((n: number) => n + 1, 0);
  // One runtime per mount, so a create/edit interaction accumulates instead of resetting each render.
  const [notes] = useState(() => demoNotesRuntime());
  const [repair] = useState(() =>
    repairRole === undefined ? undefined : demoRepairRuntime(repairRole),
  );
  return (
    <App
      device="active"
      users={DEMO_USERS}
      usersError={null}
      pinRow={() => null}
      now={HARNESS_NOW}
      session={session}
      notes={notes}
      repair={repair}
      locked={false}
      sync={demoSyncInput()}
      onSyncNow={noop}
      onRetryMedia={noop}
      onRetryUsers={noop}
      onSubmitPin={noop}
      onChangePin={() => Promise.resolve()}
      canUnlock
      listPinTargets={() => Promise.resolve([])}
      onClearLockout={() => Promise.resolve()}
      canReset
      onResetPin={() => Promise.resolve()}
      onSelectLocale={(next) => {
        setLocale(next);
        force();
      }}
      locale={getLocale()}
      deviceInfo={DEMO_DEVICE_INFO}
      enrollment={fakeEnrollmentController()}
    />
  );
}

// ── The registry ─────────────────────────────────────────────────────────────────────────────────

export interface HarnessEntry {
  readonly screen: string;
  readonly state: string;
  readonly render: () => React.JSX.Element;
}

/** A `PinAttemptRow` that is unlocked-but-just-wrong (failures < 3) — drives the pad's `wrong` view. */
const PIN_WRONG_ROW: PinAttemptRow = {
  userId: 'u-andi',
  deviceId: DEMO_DEVICE_INFO.deviceId,
  consecutiveFailures: 2,
  windowStartedAt: HARNESS_NOW - 60_000,
  notBefore: null,
};

function pinScreen(
  state: string,
  row: PinAttemptRow | null,
  lastAttempt: 'none' | 'wrong',
  needsFirstPin = false,
): React.JSX.Element {
  return (
    <ApproxFrame screen="pin" state={state}>
      <PinScreen
        userId="u-andi"
        userName="Andi Pratama"
        roleKeys={['main_owner']}
        needsFirstPin={needsFirstPin}
        row={row}
        now={HARNESS_NOW}
        lastAttempt={lastAttempt}
        onSubmit={noop}
        onSwitchUser={noop}
        syncChip="synced"
        pendingCount={0}
        onOpenSync={noop}
      />
    </ApproxFrame>
  );
}

function captureScreen(state: string, kind: CaptureScreenState): React.JSX.Element {
  return (
    <ApproxFrame screen="capture" state={state}>
      <CaptureScreen
        title="Foto kerusakan"
        state={kind}
        // A camera cannot be faked meaningfully in a browser — a real photo here would be a lie
        // (task 116: "render a clearly-labelled placeholder — do not fake a photo").
        preview={
          <View testID="capture-web-placeholder" style={styles.cameraPlaceholder}>
            <Text style={styles.cameraPlaceholderText}>
              Camera preview unavailable on web (device-only) — RNW approximation
            </Text>
          </View>
        }
        syncChip={slot('harness-capture-chip')}
        avatar={slot('harness-capture-avatar')}
        onShutter={noop}
        onRetake={noop}
        onUsePhoto={noop}
        onRetry={noop}
        onBack={noop}
      />
    </ApproxFrame>
  );
}

function signatureScreen(state: string, kind: SignaturePadState): React.JSX.Element {
  return (
    <ApproxFrame screen="signature" state={state}>
      <SignaturePadScreen
        title="Tanda tangan pelanggan"
        state={kind}
        strokes={[]}
        syncChip={slot('harness-sig-chip')}
        avatar={slot('harness-sig-avatar')}
        onStrokeStart={noop}
        onStrokeMove={noop}
        onStrokeEnd={noop}
        onClear={noop}
        onSave={noop}
        onRetry={noop}
        onBack={noop}
      />
    </ApproxFrame>
  );
}

function switcherScreen(
  state: string,
  screenState: Parameters<typeof SwitcherScreen>[0]['state'],
  mode: 'choose' | 'lock' = 'choose',
): React.JSX.Element {
  const locked: ReadonlySet<string> = new Set(['u-yosua']);
  return (
    <ApproxFrame screen="switcher" state={state}>
      <SwitcherScreen
        state={screenState}
        mode={mode}
        onBack={mode === 'lock' ? null : noop}
        onSelect={noop}
        onRetry={noop}
        onUnauthorizedBack={noop}
        syncChip="synced"
        pendingCount={0}
        onOpenSync={noop}
        currentUserId={mode === 'lock' ? null : 'u-andi'}
        lockedUserIds={locked}
      />
    </ApproxFrame>
  );
}

function syncScreen(
  state: string,
  input: ReturnType<typeof demoSyncInput>,
  /** The §8.4-item-4 disclosure, open for this op id (task 130). `null` renders the collapsed list. */
  expandedRejectedOpId: string | null = null,
): React.JSX.Element {
  return (
    <ApproxFrame screen="sync-status" state={state}>
      <SyncStatusScreen
        input={input}
        currentUser={CURRENT_USER}
        onBack={noop}
        onSyncNow={noop}
        onOpenRejected={noop}
        onRetryMedia={noop}
        onOpenSwitcher={noop}
        expandedRejectedOpId={expandedRejectedOpId}
      />
    </ApproxFrame>
  );
}

/** The acting owner for the PIN-management demos, excluded from reset targets. */
const PIN_ADMIN_ACTOR = 'u-ocep';

/** A store's directory for the owner PIN screens: the acting owner, a locked colleague, an open one. */
const PIN_TARGETS: readonly PinTargetUser[] = [
  { id: PIN_ADMIN_ACTOR, name: 'Ocep Wanggai', lockedOut: false },
  { id: 'u-ani', name: 'Ani Koibur', roleKeys: ['staff'], lockedOut: true },
  { id: 'u-budi', name: 'Budi Rumbewas', roleKeys: ['staff'], lockedOut: false },
  {
    id: 'u-maria',
    name: 'Maria Wenda',
    roleKeys: ['staff'],
    lockedOut: false,
    needsFirstPin: true,
  },
];

function changePinScreen(state: string): React.JSX.Element {
  return (
    <ApproxFrame screen="change-pin" state={state}>
      <ChangePinScreen
        person={CURRENT_PERSON}
        onChangePin={() => Promise.resolve()}
        onClose={noop}
      />
    </ApproxFrame>
  );
}

function staffPinScreen(
  state: string,
  opts: { canUnlock: boolean; canReset: boolean; users: readonly PinTargetUser[] },
): React.JSX.Element {
  return (
    <ApproxFrame screen="staff-pins" state={state}>
      <StaffPinScreen
        canUnlock={opts.canUnlock}
        canReset={opts.canReset}
        loading={false}
        error={null}
        users={opts.users}
        actorUserId={PIN_ADMIN_ACTOR}
        onClearLockout={() => Promise.resolve()}
        onResetPin={() => Promise.resolve()}
        onReload={noop}
        onClose={noop}
      />
    </ApproxFrame>
  );
}

/** A new staff member making their first PIN. */
function pinSetupScreen(state: string): React.JSX.Element {
  return (
    <ApproxFrame screen="pin-setup" state={state}>
      <PinSetupScreen
        userId="u-budi"
        userName="Budi Santoso"
        roleKeys={['staff']}
        onSetFirstPin={() => Promise.resolve()}
        onSignIn={noop}
        onBack={noop}
        syncChip="synced"
        pendingCount={0}
        onOpenSync={noop}
      />
    </ApproxFrame>
  );
}

export const ENTRIES: readonly HarnessEntry[] = [
  // Switcher — the four §5 states + the data-backed happy path.
  {
    screen: 'switcher',
    state: 'loading',
    render: () => switcherScreen('loading', { kind: 'loading' }),
  },
  { screen: 'switcher', state: 'empty', render: () => switcherScreen('empty', { kind: 'empty' }) },
  {
    screen: 'switcher',
    state: 'error',
    render: () => switcherScreen('error', { kind: 'error', code: 'UNEXPECTED' }),
  },
  {
    screen: 'switcher',
    state: 'unauthorized',
    render: () => switcherScreen('unauthorized', { kind: 'unauthorized' }),
  },
  {
    screen: 'switcher',
    state: 'ready',
    render: () => switcherScreen('ready', { kind: 'ready', users: DEMO_USERS }),
  },
  {
    screen: 'switcher',
    state: 'many',
    render: () => switcherScreen('many', { kind: 'ready', users: MANY_STAFF }),
  },
  {
    screen: 'switcher',
    state: 'lock',
    render: () => switcherScreen('lock', { kind: 'ready', users: DEMO_USERS }, 'lock'),
  },

  // PIN — the pad's real states + the interactive pad.
  { screen: 'pin', state: 'entry', render: () => pinScreen('entry', DEMO_PIN_ROWS.clean, 'none') },
  { screen: 'pin', state: 'wrong', render: () => pinScreen('wrong', PIN_WRONG_ROW, 'wrong') },
  {
    screen: 'pin',
    state: 'needsFirstPin',
    render: () => pinScreen('needsFirstPin', DEMO_PIN_ROWS.clean, 'none', true),
  },
  {
    screen: 'pin',
    state: 'delayed',
    render: () => pinScreen('delayed', DEMO_PIN_ROWS.delayed, 'none'),
  },
  {
    screen: 'pin',
    state: 'lockedOut',
    render: () => pinScreen('lockedOut', DEMO_PIN_ROWS.lockedOut, 'none'),
  },
  {
    screen: 'pin',
    state: 'interactive',
    render: () => (
      <ApproxFrame screen="pin" state="interactive">
        <PinInteractive />
      </ApproxFrame>
    ),
  },

  // Change PIN — the interactive current → new → repeat → done flow (task 138 item 1).
  { screen: 'change-pin', state: 'interactive', render: () => changePinScreen('interactive') },

  // First PIN for someone who has none (api/02-auth §6.6).
  { screen: 'pin-setup', state: 'interactive', render: () => pinSetupScreen('interactive') },

  // Staff PINs (owner) — one list for unlock and reset. Unauthorized ≠ Empty: a non-owner sees the
  // lock, not a blank list. Ready leaves out the acting owner and puts locked PINs first.
  {
    screen: 'staff-pins',
    state: 'unauthorized',
    render: () =>
      staffPinScreen('unauthorized', { canUnlock: false, canReset: false, users: PIN_TARGETS }),
  },
  {
    screen: 'staff-pins',
    state: 'empty',
    render: () =>
      staffPinScreen('empty', {
        canUnlock: true,
        canReset: true,
        users: PIN_TARGETS.filter((user) => user.id === PIN_ADMIN_ACTOR),
      }),
  },
  {
    screen: 'staff-pins',
    state: 'ready',
    render: () => staffPinScreen('ready', { canUnlock: true, canReset: true, users: PIN_TARGETS }),
  },
  {
    screen: 'staff-pins',
    state: 'many',
    render: () =>
      staffPinScreen('many', {
        canUnlock: true,
        canReset: true,
        users: [
          ...PIN_TARGETS,
          ...MANY_STAFF.map((user, index) => ({
            id: user.id,
            name: user.name,
            lockedOut: index === 6,
          })),
        ],
      }),
  },

  // Settings — the live ID↔EN language toggle.
  {
    screen: 'settings',
    state: 'ready',
    render: () => (
      <ApproxFrame screen="settings" state="ready">
        <SettingsInteractive />
      </ApproxFrame>
    ),
  },

  // Sync-status — healthy, offline-but-safe, saved-here, actively-syncing, needs-attention.
  {
    screen: 'sync-status',
    state: 'allSent',
    render: () => syncScreen('allSent', SYNC_STATUS_STATES.allSent()),
  },
  {
    screen: 'sync-status',
    state: 'savedHere',
    render: () => syncScreen('savedHere', SYNC_STATUS_STATES.savedHere()),
  },
  {
    screen: 'sync-status',
    state: 'photosPending',
    render: () => syncScreen('photosPending', SYNC_STATUS_STATES.photosPending()),
  },
  {
    screen: 'sync-status',
    state: 'offline',
    render: () => syncScreen('offline', SYNC_STATUS_STATES.offline()),
  },
  {
    screen: 'sync-status',
    state: 'syncing',
    render: () => syncScreen('syncing', SYNC_STATUS_STATES.syncing()),
  },
  {
    screen: 'sync-status',
    state: 'attention',
    render: () => syncScreen('attention', SYNC_STATUS_STATES.attention()),
  },
  {
    // The rejected row with its technical detail disclosed (task 130). Rendered to PIXELS because
    // this is copy stacked under a `danger` section on a 360 dp screen, and "does the server's own
    // sentence fit and stay subordinate to the row above it" is a question no assertion answers.
    screen: 'sync-status',
    state: 'rejectedDetail',
    render: () => syncScreen('rejectedDetail', SYNC_STATUS_STATES.attention(), DEMO_REJECTED_OP_ID),
  },

  // Enrollment — steps + revoked banner + the interactive discard ConfirmSheet.
  {
    screen: 'enrollment',
    state: 'credentials',
    render: () => (
      <ApproxFrame screen="enrollment" state="credentials">
        <EnrollmentInteractive revoked={false} step="credentials" />
      </ApproxFrame>
    ),
  },
  {
    screen: 'enrollment',
    state: 'confirm',
    render: () => (
      <ApproxFrame screen="enrollment" state="confirm">
        <EnrollmentInteractive revoked={false} step="confirm" />
      </ApproxFrame>
    ),
  },
  {
    screen: 'enrollment',
    state: 'done',
    render: () => (
      <ApproxFrame screen="enrollment" state="done">
        <EnrollmentInteractive revoked={false} step="done" />
      </ApproxFrame>
    ),
  },
  {
    screen: 'enrollment',
    state: 'confirmPicked',
    render: () => (
      <ApproxFrame screen="enrollment" state="confirmPicked">
        <EnrollmentInteractive
          revoked={false}
          step="confirm"
          over={{ selectedStoreId: DEMO_LOGIN.stores[1]?.id ?? null, deviceName: 'HP Kasir 1' }}
        />
      </ApproxFrame>
    ),
  },
  {
    screen: 'enrollment',
    state: 'confirmOneStore',
    render: () => (
      <ApproxFrame screen="enrollment" state="confirmOneStore">
        <EnrollmentInteractive
          revoked={false}
          step="confirm"
          over={{
            login: { ...DEMO_LOGIN, stores: DEMO_LOGIN.stores.slice(0, 1) },
            selectedStoreId: DEMO_LOGIN.stores[0]?.id ?? null,
          }}
        />
      </ApproxFrame>
    ),
  },
  {
    screen: 'enrollment',
    state: 'wrongPassword',
    render: () => (
      <ApproxFrame screen="enrollment" state="wrongPassword">
        <EnrollmentInteractive
          revoked={false}
          step="credentials"
          over={{
            loginIdentifier: 'maju',
            password: 'salah-sandi-1',
            failure: { kind: 'credentials' },
          }}
        />
      </ApproxFrame>
    ),
  },
  {
    screen: 'enrollment',
    state: 'offline',
    render: () => (
      <ApproxFrame screen="enrollment" state="offline">
        <EnrollmentInteractive
          revoked={false}
          step="credentials"
          over={{
            loginIdentifier: 'maju',
            password: 'sandi-benar-1',
            failure: { kind: 'offline' },
          }}
        />
      </ApproxFrame>
    ),
  },
  {
    screen: 'enrollment',
    state: 'notOwner',
    render: () => (
      <ApproxFrame screen="enrollment" state="notOwner">
        <EnrollmentInteractive
          revoked={false}
          step="credentials"
          over={{
            loginIdentifier: 'kasir',
            password: 'sandi-benar-1',
            failure: { kind: 'notPermitted' },
          }}
        />
      </ApproxFrame>
    ),
  },
  {
    screen: 'enrollment',
    state: 'revoked',
    render: () => (
      <ApproxFrame screen="enrollment" state="revoked">
        <EnrollmentInteractive revoked step="credentials" />
      </ApproxFrame>
    ),
  },

  // Capture (media) — loading / unauthorized / error / ready, camera as a labelled placeholder.
  {
    screen: 'capture',
    state: 'loading',
    render: () => captureScreen('loading', { kind: 'permission_pending' }),
  },
  {
    screen: 'capture',
    state: 'unauthorized',
    render: () => captureScreen('unauthorized', { kind: 'permission_denied' }),
  },
  {
    screen: 'capture',
    state: 'ready',
    render: () => captureScreen('ready', { kind: 'ready', band: 'normal' }),
  },
  {
    screen: 'capture',
    state: 'error',
    render: () => captureScreen('error', { kind: 'failed', code: 'CAPTURE_FAILED' }),
  },
  {
    screen: 'capture',
    state: 'lowStorage',
    render: () => captureScreen('lowStorage', { kind: 'refused_low_storage' }),
  },

  // Signature (media) — loading / unauthorized / ready / error.
  {
    screen: 'signature',
    state: 'loading',
    render: () => signatureScreen('loading', { kind: 'loading' }),
  },
  {
    screen: 'signature',
    state: 'unauthorized',
    render: () => signatureScreen('unauthorized', { kind: 'unauthorized' }),
  },
  {
    screen: 'signature',
    state: 'ready',
    render: () => signatureScreen('ready', { kind: 'ready' }),
  },
  {
    screen: 'signature',
    state: 'error',
    render: () => signatureScreen('error', { kind: 'failed', code: 'SIGN_FAILED' }),
  },

  // App-mode — the full RootNavigator gate over the demo seed.
  {
    screen: 'app',
    state: 'switcher',
    render: () => (
      <ApproxFrame screen="app" state="switcher">
        <AppMode session={null} />
      </ApproxFrame>
    ),
  },
  {
    screen: 'app',
    state: 'shell',
    render: () => (
      <ApproxFrame screen="app" state="shell">
        <AppMode session={{ userId: 'u-andi' }} />
      </ApproxFrame>
    ),
  },

  // Repair — the full App with the repair module home, one entry per role. The flows behind the
  // board (ticket, steps, intake, handover) are reached by tapping, over an in-memory runtime.
  ...(Object.keys(DEMO_REPAIR_ROLES) as DemoRepairRole[]).map((role) => ({
    screen: 'repair',
    state: role,
    render: () => (
      <ApproxFrame screen="repair" state={role}>
        <AppMode session={{ userId: DEMO_REPAIR_ROLES[role].userId }} repairRole={role} />
      </ApproxFrame>
    ),
  })),
];

export function findEntry(screen: string, state: string): HarnessEntry | undefined {
  return ENTRIES.find((entry) => entry.screen === screen && entry.state === state);
}

const styles = StyleSheet.create({
  frame: { flex: 1, backgroundColor: color.surface },
  body: { flex: 1 },
  label: {
    backgroundColor: color.danger,
    paddingVertical: space.xs,
    paddingHorizontal: space.sm,
    alignItems: 'center',
  },
  labelText: { ...type.caption, color: color.onDanger, fontWeight: '700' },
  harnessButton: {
    ...type.bodySm,
    color: color.primary,
    textAlign: 'center',
    paddingVertical: space.sm,
    textDecorationLine: 'underline',
  },
  cameraPlaceholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
    borderWidth: border.focus,
    borderColor: color.border,
    borderStyle: 'dashed',
  },
  cameraPlaceholderText: { ...type.bodySm, color: color.textMuted, textAlign: 'center' },
});
