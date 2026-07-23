/**
 * The Android hardware-back SUBSCRIPTION LIFECYCLE (task 132 item 2).
 *
 * `zone.test.ts` proves the DECISION (`backTarget`) and `RootNavigator.test.tsx` proves every zone
 * renders — but until this file existed nothing exercised `useHardwareBack` at all, and its header
 * made a behavioural claim that no test had ever put a load on: *"the subscription is re-created
 * whenever `handler` changes … a stale closure left registered would answer for a screen that is no
 * longer on top."* CLAUDE.md §2.11: a comment is a hypothesis, not evidence. These tests are the
 * evidence, and the header's claim is exactly what the middle two assert.
 *
 * ── WHY THE CLAIM IS LOAD-BEARING IN PRODUCTION, NOT DECORATIVE ──────────────────────────────────
 * `App.tsx:144` passes a `useCallback` whose deps are `[zone, enrollment]`, so the handler identity
 * CHANGES on every navigation. If the effect captured it once, hardware back would keep running the
 * closure built for the previous zone — navigating from a screen the user already left. That is a
 * wrong-screen navigation, not a crash, so nothing else in the suite would see it.
 *
 * ── WHAT THIS LANE CAN AND CANNOT ANSWER (state it, or a green implies coverage it does not have) ─
 * These tests run in Node against `test/doubles/react-native.tsx`'s hand-written `BackHandler`, whose
 * semantics mirror the DOCUMENTED contract for react-native 0.86 ("Event subscriptions are called in
 * reverse order; if one returns true, earlier subscriptions are not called. If no subscription
 * returns true … the default back button functionality to exit the app is invoked").
 *   - CAN prove: that `useHardwareBack` USES that API correctly — one subscription per mounted
 *     component, re-created (old one REMOVED, not merely shadowed) when `handler` changes, and gone
 *     after unmount. Every defect in the hook itself is visible here.
 *   - CANNOT prove: that Android's real `BackHandler` behaves as documented, that the native
 *     `DeviceEventManagerModule` bridge delivers `hardwareBackPress` at all, or anything about
 *     predictive back / `onBackPressed` dispatch on a real device. "Typed and compiling" is not
 *     "running on the target": the ordering rule this lane assumes is the double's re-statement of
 *     the docs, not a measurement of the platform. Only L6 (on-device) can close that.
 *
 * ── TWO LIMITS THE ABOVE UNDERSTATES (task 150 item 5) ────────────────────────────────────────────
 *  A. **The double is STRICTER than shipped RN 0.86, so "subscribed exactly once" measures the
 *     DOUBLE's policy, not Android's.** RN's `addEventListener` dedupes on add
 *     (`if (_backPressSubscriptions.indexOf(handler) === -1) push` —
 *     `react-native@0.86.0/Libraries/Utilities/BackHandler.android.js`); the double pushes
 *     unconditionally. So a hook that registered the same reference twice reds here and would be
 *     invisible on device. That is a false-RED risk only, never a false-green — see the divergence
 *     note in `test/doubles/react-native.tsx`, and do not relax this test to match the platform.
 *
 *  B. **Predictive back may invalidate the ORDERING PREMISE, not merely be an untested path.** The
 *     line above names predictive back as something this lane cannot exercise. It is worse than
 *     that, and the claim was checked at the platform docs and against the shipped source rather
 *     than assumed (CLAUDE.md §2.11):
 *       - Android 16 (API 36) behaviour change, verbatim: "For apps targeting Android 16 (API level
 *         36) or higher and running on an Android 16 or higher device, the predictive back system
 *         animations … are enabled by default. Additionally, `onBackPressed` is not called and
 *         `KeyEvent.KEYCODE_BACK` is not dispatched anymore."
 *         (developer.android.com/about/versions/16/behavior-changes-16). Note the polarity: since
 *         Android 16 the manifest flag `android:enableOnBackInvokedCallback` is the temporary
 *         OPT-OUT, not the opt-in it was on Android 13/14 — so the new dispatch model is the
 *         DEFAULT for a targetSdk-36 build, not a path someone has to switch on.
 *       - RN 0.86 therefore does NOT deliver `hardwareBackPress` from `onBackPressed` on such a
 *         build. `ReactActivity.java` registers an `androidx.activity.OnBackPressedCallback` on the
 *         activity's `OnBackPressedDispatcher`, gated on `AndroidVersion.isAtLeastTargetSdk36`, and
 *         says so in its own comment: "Due to enforced predictive back on targetSdk 36,
 *         'onBackPressed()' is disabled by default. Using a workaround to trigger it manually." The
 *         JS array this file models sits BEHIND that single shim callback.
 *     What that costs us: the reverse-order rule WITHIN the JS array is unchanged (RN still iterates
 *     `_backPressSubscriptions` backwards), so the assertions above stay meaningful. What is NOT
 *     modelled is the JS stack's POSITION and liveness in the native dispatcher — it is one callback
 *     among several (`ReactModalHostView` registers its own `OnBackPressedCallback(true)` on a
 *     shown Modal's dispatcher, entirely outside this array), and RN's shim disables and re-enables
 *     itself mid-dispatch. That path has already shipped a real defect in the exact version we
 *     depend on: RN 0.86's release notes carry a fix for `BackHandler` callbacks on Android API 36+
 *     that "stopped working after an app was resumed from the background", repaired by re-registering
 *     during `onHostResume`. A whole-lane green here would not have moved.
 *     The app pins no `targetSdkVersion` (no committed `android/`, no `expo-build-properties`
 *     override in `app.config.ts`), so the effective target comes from Expo SDK 57's prebuild
 *     template and is not determinable from this repo — which is the reason to treat the shim path
 *     as LIVE rather than hypothetical. Only an L6 on-device run settles it, and task 148 currently
 *     blocks any Android build at all.
 */
import { describe, expect, test, beforeEach } from 'vitest';

import { render } from '../../../../packages/ui/test/render.js';
import { __emitHardwareBack, __resetHardwareBack } from '../../test/doubles/react-native.js';

import { useHardwareBack } from './useHardwareBack.js';

/** The smallest thing that can own the subscription: a component that is nothing BUT the hook. */
function Probe({ handler }: { readonly handler: () => boolean }): null {
  useHardwareBack(handler);
  return null;
}

/**
 * A handler that records that it ran and answers `consume`.
 *
 * `consume: false` is the interesting case and the reason the log exists: a listener that DECLINES
 * lets the event bubble to the ones registered before it, which is the only way a leaked stale
 * subscription can be observed. A consuming handler would hide it (RN stops at the first `true`).
 */
function handlerNamed(log: string[], name: string, consume: boolean): () => boolean {
  return () => {
    log.push(name);
    return consume;
  };
}

describe('useHardwareBack — the Android BackHandler subscription lifecycle (task 132)', () => {
  beforeEach(() => {
    // Listeners leak across files otherwise, and a leaked one makes this suite order-dependent —
    // the exact bug class under test would then be able to hide inside the harness.
    __resetHardwareBack();
  });

  test('mounting registers the handler — a press reaches it and is CONSUMED when it answers true', () => {
    const log: string[] = [];
    render(<Probe handler={handlerNamed(log, 'a', true)} />);

    expect(__emitHardwareBack()).toBe(true);
    expect(log).toEqual(['a']);
  });

  test('a handler that declines is still registered — the press falls through to Android', () => {
    // The oracle for every "nothing answered" assertion below (T-14b): `__emitHardwareBack() ===
    // false` has TWO causes — no listener, or a listener that declined. This pins the second, so a
    // later `false` cannot be read as "unsubscribed" when it merely means "declined".
    const log: string[] = [];
    render(<Probe handler={handlerNamed(log, 'a', false)} />);

    expect(__emitHardwareBack()).toBe(false);
    expect(log).toEqual(['a']);
  });

  test('changing `handler` re-creates the subscription — the NEW handler answers, not the stale one', () => {
    // The header's claim, directly. With the effect keyed on `[]` instead of `[handler]`, `a` stays
    // registered and `b` never is: the press is answered by the closure of the screen the user left.
    const log: string[] = [];
    const screen = render(<Probe handler={handlerNamed(log, 'a', true)} />);

    // T-14b: prove `a` is genuinely live BEFORE asserting anything about its absence.
    expect(__emitHardwareBack()).toBe(true);
    expect(log).toEqual(['a']);
    log.length = 0;

    screen.rerender(<Probe handler={handlerNamed(log, 'b', true)} />);

    expect(__emitHardwareBack()).toBe(true);
    expect(log).toEqual(['b']);
  });

  test('the stale subscription is REMOVED, not merely shadowed — a declining new handler finds nothing behind it', () => {
    // The test above cannot see a missing cleanup: `b` is registered last, so RN's reverse order
    // runs it first and its `true` consumes the press before a leaked `a` could run. Making the new
    // handler DECLINE removes that cover — the event now bubbles, so a leaked `a` runs and consumes.
    const log: string[] = [];
    const screen = render(<Probe handler={handlerNamed(log, 'a', true)} />);

    expect(__emitHardwareBack()).toBe(true); // fixture proven live (T-14b)
    expect(log).toEqual(['a']);
    log.length = 0;

    screen.rerender(<Probe handler={handlerNamed(log, 'b', false)} />);

    expect(__emitHardwareBack()).toBe(false); // nothing consumed ⇒ Android's default exit
    expect(log).toEqual(['b']); // and the stale closure never ran
  });

  test('a STABLE handler is subscribed exactly once across re-renders — no duplicate registration', () => {
    // A declining handler runs on every registration, so the call COUNT is the subscription count:
    // an effect that re-subscribed without cleaning up would log `a` once per render.
    const log: string[] = [];
    const stable = handlerNamed(log, 'a', false);
    const screen = render(<Probe handler={stable} />);
    screen.rerender(<Probe handler={stable} />);
    screen.rerender(<Probe handler={stable} />);

    expect(__emitHardwareBack()).toBe(false);
    expect(log).toEqual(['a']);
  });

  test('unmounting removes the subscription — the press falls through to Android instead', () => {
    const log: string[] = [];
    const screen = render(<Probe handler={handlerNamed(log, 'a', true)} />);

    // T-14b again, and it matters most here: without this line the assertions after the unmount
    // would pass identically if the hook had never registered anything at all.
    expect(__emitHardwareBack()).toBe(true);
    expect(log).toEqual(['a']);
    log.length = 0;

    screen.unmount();

    expect(__emitHardwareBack()).toBe(false);
    expect(log).toEqual([]);
  });
});
