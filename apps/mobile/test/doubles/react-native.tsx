/**
 * Runtime double for `react-native` in `@bolusi/mobile`'s test lane (aliased in `vitest.config.ts`).
 *
 * IT COMPOSES `@bolusi/ui`'s DOUBLE RATHER THAN COPYING IT (CLAUDE.md §2.8). That double is the
 * repo's one answer to "RN 0.86 is Flow source esbuild cannot parse, and @testing-library/react-native
 * hard-peers on jest" — read its header for the full rationale and, more importantly, its honest
 * limits. Re-exporting keeps ONE definition of every primitive: a fidelity fix there (notably the
 * deliberate FIDELITY RULE that `Pressable` does NOT swallow `onPress` when disabled, so our own
 * components must gate it) reaches this lane automatically instead of drifting.
 *
 * The reach into another package's `test/` directory is deliberate and test-lane only: `@bolusi/ui`
 * is a CONTENDED package (CLAUDE.md §4) that task 24 must not edit, so exporting the double from its
 * public surface — the alternative — was not available. `tsc` still resolves the REAL `react-native`
 * types for both packages, so every prop these screens pass stays compiler-checked against real RN.
 *
 * WHAT THIS FILE ADDS on top: the two platform surfaces the SHELL needs and a component library does
 * not. Both are recorded rather than real, because a test must never wait on a native event.
 *
 * INHERITED LIMITS — do not claim these are tested here: no Yoga layout (every dimension assertion
 * reads a declared STYLE value, never a measured frame — which is exactly why the banner-truncation
 * item in this task's acceptance is an on-device check and cannot be faked in this lane), no real
 * gestures, no native a11y bridging, no font scaling.
 */
export {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  Vibration,
  View,
} from '../../../../packages/ui/test/doubles/react-native.js';

type BackHandlerSubscription = { remove(): void };
type BackListener = () => boolean;

/**
 * `BackHandler` double. The registered listeners are exposed through `__emitHardwareBack` so a test
 * can drive Android's hardware back deterministically (T-6: no real native event, no sleep).
 *
 * Real RN semantics preserved: listeners run in REVERSE registration order (most recently
 * registered first) and the first one returning `true` consumes the event. That ordering is the
 * whole contract — it is what makes "hardware back equals the header back action" (design-system
 * §8.1) true for the screen on top rather than the screen underneath — so the double must not
 * simplify it.
 *
 * ── KNOWN DIVERGENCES FROM REAL RN 0.86 — DO NOT "ALIGN" THE TESTS TO THEM (task 150 item 3) ──────
 * Read against the shipped source, not the docs: `react-native@0.86.0`,
 * `Libraries/Utilities/BackHandler.android.js`. Three differences, all deliberate, none fixed here:
 *
 *  1. **RN DEDUPES on add; this double does not.** RN's `addEventListener` is
 *     `if (_backPressSubscriptions.indexOf(handler) === -1) { push(handler) }`, so registering the
 *     SAME function reference twice yields ONE entry. This double pushes unconditionally, so it
 *     yields two. The divergence is strictly in the SAFE direction and that is the reason it stays:
 *     the double can only ever hold MORE entries than the platform, never fewer, so
 *     `useHardwareBack.test.tsx`'s "subscribed exactly once" can produce a false RED (a hook that
 *     double-registers reds here while Android would silently dedupe) but never a false GREEN. A
 *     future reader who "fixes" this to match RN would be deleting a guard against a duplicate
 *     registration that the platform happens to paper over — the test would still pass on a hook
 *     that is wrong. Keep the double strict; the cost is a red we would want to see anyway.
 *  2. **RN passes a `HardwareBackPressEvent` argument.** RN constructs one per press and calls
 *     `_backPressSubscriptions[i](event)`; `__emitHardwareBack` calls with no argument. Inert today
 *     because `useHardwareBack`'s handlers are `() => boolean` and read no argument — it stops being
 *     inert the moment a handler reads the event, at which point this double must grow one.
 *  3. **RN ignores `eventName` on add.** RN's `addEventListener` never inspects `eventName`; it
 *     registers for anything. This double early-returns an inert subscription for any name other
 *     than `hardwareBackPress`. NOTE the direction is the OPPOSITE of (1) and (2): here the double
 *     holds FEWER entries than the platform, so against a `toBe(false)` assertion in
 *     `useHardwareBack.test.tsx` an unregistered listener reads as "nothing consumed" — a false
 *     GREEN, not a false red. What keeps it inert is not the direction but the caller: production
 *     passes only `'hardwareBackPress'` (`useHardwareBack.ts`), so the branch is never taken. If a
 *     caller ever passes another name, this double must register it like RN does, or the test that
 *     covers that caller is green for the wrong reason.
 */
const backListeners: BackListener[] = [];

export const BackHandler = {
  addEventListener(event: string, listener: BackListener): BackHandlerSubscription {
    if (event !== 'hardwareBackPress') return { remove: () => undefined };
    backListeners.push(listener);
    return {
      remove: () => {
        const index = backListeners.indexOf(listener);
        if (index >= 0) backListeners.splice(index, 1);
      },
    };
  },
};

/** Drive a hardware-back press. Returns true iff a listener consumed it (RN's own semantics). */
export function __emitHardwareBack(): boolean {
  for (let index = backListeners.length - 1; index >= 0; index -= 1) {
    if (backListeners[index]?.()) return true;
  }
  return false;
}

/** Clear registered listeners between tests — leaked listeners make suites order-dependent. */
export function __resetHardwareBack(): void {
  backListeners.length = 0;
}
