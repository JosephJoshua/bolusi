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
import { PinScreen } from '../screens/pin/PinScreen.js';
import { SettingsScreen } from '../screens/settings/SettingsScreen.js';
import { SyncStatusScreen } from '../screens/sync-status/SyncStatusScreen.js';
import { SwitcherScreen } from '../screens/switcher/SwitcherScreen.js';
import type { AppProps } from '../../App.js';

import {
  DEMO_DEVICE_INFO,
  DEMO_LOGIN,
  DEMO_PIN_ROWS,
  DEMO_USERS,
  HARNESS_NOW,
  SYNC_STATUS_STATES,
  demoSyncInput,
  fakeEnrollmentController,
} from './seed.js';

function noop(): void {
  /* harness stub — the shipping wiring lives in Root.tsx / the screens' callers. */
}

const CURRENT_USER = { id: 'u-andi', initials: 'AP' } as const;

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
      currentUser={CURRENT_USER}
      onBack={noop}
      onOpenSwitcher={noop}
      syncChip="synced"
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
}: {
  readonly revoked: boolean;
  readonly step: EnrollmentStep;
}): React.JSX.Element {
  const [state, setState] = useState<EnrollmentState>(() => {
    const base = initialEnrollmentState(revoked);
    if (step === 'confirm') {
      return {
        ...base,
        step,
        login: DEMO_LOGIN,
        selectedStoreId: DEMO_LOGIN.stores[0]?.id ?? null,
      };
    }
    if (step === 'done') return { ...base, step, login: DEMO_LOGIN };
    return base;
  });
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
            selectedStoreId: DEMO_LOGIN.stores[0]?.id ?? null,
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
 * lands on the shell home surface (where the task-96 notes screens will render once merged — the web
 * entry renders the RootNavigator, so they appear automatically). Proves the whole navigation gate
 * renders real screens from fake data, not just isolated components.
 */
function AppMode({ session }: { readonly session: AppProps['session'] }): React.JSX.Element {
  const [, force] = useReducer((n: number) => n + 1, 0);
  return (
    <App
      device="active"
      users={DEMO_USERS}
      usersError={null}
      pinRow={() => null}
      now={HARNESS_NOW}
      session={session}
      locked={false}
      sync={demoSyncInput()}
      onSyncNow={noop}
      onSubmitPin={noop}
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
): React.JSX.Element {
  return (
    <ApproxFrame screen="pin" state={state}>
      <PinScreen
        userId="u-andi"
        userName="Andi Pratama"
        row={row}
        now={HARNESS_NOW}
        lastAttempt={lastAttempt}
        onSubmit={noop}
        onSwitchUser={noop}
        syncChip="synced"
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
  return (
    <ApproxFrame screen="switcher" state={state}>
      <SwitcherScreen
        state={screenState}
        mode={mode}
        onBack={mode === 'lock' ? null : noop}
        onSelect={noop}
        onEnroll={noop}
        onRetry={noop}
        syncChip="synced"
        onOpenSync={noop}
      />
    </ApproxFrame>
  );
}

function syncScreen(state: string, input: ReturnType<typeof demoSyncInput>): React.JSX.Element {
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
    state: 'lock',
    render: () => switcherScreen('lock', { kind: 'ready', users: DEMO_USERS }, 'lock'),
  },

  // PIN — the pad's real states + the interactive pad.
  { screen: 'pin', state: 'entry', render: () => pinScreen('entry', DEMO_PIN_ROWS.clean, 'none') },
  { screen: 'pin', state: 'wrong', render: () => pinScreen('wrong', PIN_WRONG_ROW, 'wrong') },
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

  // Sync-status — healthy, offline-but-safe, saved-here, needs-attention.
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
    state: 'offline',
    render: () => syncScreen('offline', SYNC_STATUS_STATES.offline()),
  },
  {
    screen: 'sync-status',
    state: 'attention',
    render: () => syncScreen('attention', SYNC_STATUS_STATES.attention()),
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
