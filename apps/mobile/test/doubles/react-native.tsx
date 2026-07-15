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
