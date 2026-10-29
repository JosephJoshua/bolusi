/**
 * Runtime double for `react-native`, aliased in `vitest.config.ts` (test lane ONLY).
 *
 * WHY THIS EXISTS (read before trusting a test in this package):
 * `react-native` 0.86 ships Flow-typed source that Node/esbuild cannot parse, so the real package
 * cannot be imported under vitest without a Babel transform pipeline. The obvious alternative,
 * `@testing-library/react-native@14`, declares a HARD peer dependency on `jest >=29` — this repo is
 * vitest-only (08-stack §5.4), so adopting it would drag a second test runner into the toolchain.
 *
 * The split we chose instead:
 *   - TYPES come from the REAL `react-native` (tsc resolves the real package — this file is never
 *     in the tsconfig `include`). So prop names/shapes are compiler-checked against real RN.
 *   - RUNTIME comes from this double, which renders each RN primitive to a host node of the same
 *     name with props passed through UNCHANGED.
 *
 * WHAT THIS BUYS: every assertion in this package is about props our own components compute —
 * `testID`, `accessibilityRole`, `accessibilityState`, and the StyleSheet objects the components
 * build from tokens. Those pass through a host boundary untouched, so the double cannot make a
 * wrong component look right.
 *
 * WHAT THIS DOES NOT COVER (honest limits — do not claim these are tested):
 *   - Real Yoga layout. Every dimension assertion here reads a STYLE value, never a measured frame.
 *   - Real gesture recognition, native accessibility bridging, RTL, font scaling.
 *   - `android_ripple`, `hitSlop` are asserted as declared props, not as real hit geometry.
 * Those belong to the on-device suite (testing-guide §2.6, L6), not here.
 *
 * FIDELITY RULE: this double is deliberately DUMBER than real RN in one direction that matters.
 * Real `Pressable` swallows `onPress` when `disabled`; this double does NOT. That is intentional:
 * it forces our components to gate `onPress` themselves rather than lean on RN, so "disabled means
 * not pressable" is a property of OUR code that a test can actually witness. Never "fix" this by
 * teaching the double to swallow presses — that would move the behavior under test into the fake.
 */
import React from 'react';

type AnyProps = Record<string, unknown>;

/** Render a plain host node of `type`, passing every prop through untouched. */
function hostComponent(type: string) {
  const Component = React.forwardRef<unknown, AnyProps>(function Host(props, ref) {
    return React.createElement(type, { ...props, ref });
  });
  Component.displayName = type;
  return Component;
}

/**
 * Where a test says a view sits in the window, by testID: what `measureInWindow` reports for it.
 * A view with none set never answers, as a view that has not been laid out yet.
 */
export const windowLayout = new Map<string, { y: number; height: number }>();
/** Where a view sits inside the content it is measured against (`measureLayout`), by testID. */
export const contentLayout = new Map<string, { y: number; height: number }>();
export const View = React.forwardRef<unknown, AnyProps>(function View(props, ref) {
  React.useImperativeHandle(ref, () => ({
    measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) => {
      const layout = windowLayout.get(String(props['testID']));
      if (layout !== undefined) done(0, layout.y, 0, layout.height);
    },
    measureLayout: (
      _relativeTo: unknown,
      done: (x: number, y: number, width: number, height: number) => void,
    ): void => {
      const layout = contentLayout.get(String(props['testID']));
      if (layout !== undefined) done(0, layout.y, 0, layout.height);
    },
  }));
  return React.createElement('View', props);
});
View.displayName = 'View';
export const Text = hostComponent('Text');
export const TextInput = hostComponent('TextInput');
export const ActivityIndicator = hostComponent('ActivityIndicator');
/** Every `scrollTo` a ScrollView was asked for, newest last. */
export const scrollCalls: { y: number }[] = [];
export const ScrollView = React.forwardRef<unknown, AnyProps>(function ScrollView(props, ref) {
  React.useImperativeHandle(ref, () => ({
    scrollTo: (to: { y: number }) => scrollCalls.push({ y: to.y }),
  }));
  return React.createElement('ScrollView', props);
});
ScrollView.displayName = 'ScrollView';
export const Switch = hostComponent('Switch');
/** A host node: lifting content above the keyboard is native layout, not under test here. */
export const KeyboardAvoidingView = hostComponent('KeyboardAvoidingView');

/**
 * Renders every item rather than a window. That is deliberate and its limits must be understood:
 * REAL virtualization is RN's job and is not under test here. What IS under test — and what this
 * double preserves exactly — is that `List` WIRES the windowing configuration (`windowSize`,
 * `removeClippedSubviews`) and renders each item through `renderItem`. Those props
 * pass through to the host node untouched, so a test can assert them.
 * Windowing behaviour itself belongs to the on-device suite (testing-guide §2.6).
 */
export const FlatList = React.forwardRef<unknown, AnyProps>(function FlatList(props, ref) {
  const { data, renderItem, keyExtractor, ...rest } = props as {
    data?: readonly unknown[];
    renderItem?: (info: { item: unknown; index: number }) => React.ReactNode;
    keyExtractor?: (item: unknown, index: number) => string;
  };
  return React.createElement(
    'FlatList',
    { ...rest, data, renderItem, keyExtractor, ref },
    (data ?? []).map((item, index) =>
      React.createElement(
        React.Fragment,
        { key: keyExtractor ? keyExtractor(item, index) : index },
        renderItem?.({ item, index }),
      ),
    ),
  );
});

/**
 * Mirrors the subset of RN's `Pressable` contract our components use: render-prop `children` and
 * `style` receive `{ pressed }`, and `onPressIn`/`onPressOut` drive that state — which is how a
 * test exercises the design-system `pressed` state (design-system §3.1) without a test-only prop
 * on the component. `onPress`/`disabled` pass through verbatim (see FIDELITY RULE above).
 */
export const Pressable = React.forwardRef<unknown, AnyProps>(function Pressable(props, ref) {
  const { children, style, onPressIn, onPressOut, ...rest } = props as {
    children?: unknown;
    style?: unknown;
    onPressIn?: (event: unknown) => void;
    onPressOut?: (event: unknown) => void;
  };
  const [pressed, setPressed] = React.useState(false);
  const state = { pressed };

  return React.createElement(
    'Pressable',
    {
      ...rest,
      ref,
      style: typeof style === 'function' ? (style as (s: typeof state) => unknown)(state) : style,
      onPressIn: (event: unknown) => {
        setPressed(true);
        onPressIn?.(event);
      },
      onPressOut: (event: unknown) => {
        setPressed(false);
        onPressOut?.(event);
      },
    },
    typeof children === 'function'
      ? (children as (s: typeof state) => React.ReactNode)(state)
      : (children as React.ReactNode),
  );
});

/**
 * `StyleSheet.create` is identity in modern RN (it returns the object, not an opaque id), and
 * `flatten` merges arrays left-to-right with later entries winning. Both are reimplemented here
 * exactly so style assertions read what the component actually declared.
 */
export const StyleSheet = {
  create: <T extends Record<string, object>>(styles: T): T => styles,
  flatten: (style: unknown): Record<string, unknown> => {
    if (!style) return {};
    if (Array.isArray(style)) {
      return style.reduce<Record<string, unknown>>(
        (acc, entry) => Object.assign(acc, StyleSheet.flatten(entry)),
        {},
      );
    }
    return style as Record<string, unknown>;
  },
  hairlineWidth: 1,
  absoluteFillObject: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
};

/** Recorded, never real — PinPad error feedback (design-system §3.3) must be observable in tests. */
export const Vibration = {
  vibrate: (): void => undefined,
};

/**
 * No on-screen keyboard in this lane: `emit` stands in for the system announcing one, so a test can
 * drive what the shell does when it opens. `dismiss` is recorded: a sheet dismisses the keyboard as
 * it opens, and tests count that.
 */
const keyboardListeners = new Map<string, Set<(event: unknown) => void>>();
export const Keyboard = {
  dismissCount: 0,
  dismiss(): void {
    Keyboard.dismissCount += 1;
  },
  addListener: (name: string, listener: (event: unknown) => void) => {
    const set = keyboardListeners.get(name) ?? new Set();
    set.add(listener);
    keyboardListeners.set(name, set);
    return { remove: () => set.delete(listener) };
  },
  emit: (name: string, event?: unknown): void => {
    for (const listener of keyboardListeners.get(name) ?? []) listener(event);
  },
};

/**
 * Recorded window metrics. A test sets `__windowMetrics` to see a narrow phone or a large system
 * font; nothing is measured.
 */
export const __windowMetrics = { width: 411, height: 914, scale: 2.625, fontScale: 1 };
export function useWindowDimensions(): typeof __windowMetrics {
  return { ...__windowMetrics };
}
/** The same recorded metrics for a non-hook read; the screen and the window are the same here. */
export const Dimensions = {
  get: (): typeof __windowMetrics => ({ ...__windowMetrics }),
  addEventListener: (): { remove: () => void } => ({ remove: () => {} }),
};

export const Platform = { OS: 'android', select: (spec: AnyProps): unknown => spec['android'] };

/**
 * `Animated` and `PanResponder`, enough for PhotoViewer to mount. No animation runs: a value is a
 * number holder and `start()` lands it at once. Gestures are not simulated (see the limits above).
 */
class AnimatedValue {
  constructor(public value: number) {}
  setValue(next: number): void {
    this.value = next;
  }
  /** A live, piecewise-linear mapping of this value; clamps when asked, like the real one. */
  interpolate(config: {
    inputRange: number[];
    outputRange: (number | string)[];
    extrapolate?: 'clamp' | 'extend';
  }): { readonly value: number | string } {
    const read = (): number => this.value;
    const { inputRange: input, outputRange: output } = config;
    return {
      get value(): number | string {
        const at = read();
        let seg = 0;
        while (seg < input.length - 2 && at > input[seg + 1]!) seg += 1;
        const [i0, i1] = [input[seg]!, input[seg + 1]!];
        const [o0, o1] = [output[seg]!, output[seg + 1]!];
        // Strings ("12deg") only land on their stops; nothing reads between them.
        if (typeof o0 === 'string' || typeof o1 === 'string') return at <= i0 ? o0 : o1;
        let t = (at - i0) / (i1 - i0);
        if (config.extrapolate === 'clamp') t = Math.min(1, Math.max(0, t));
        return o0 + t * (o1 - o0);
      },
    };
  }
}
const finished = (target: AnimatedValue, toValue: number) => ({
  start: (done?: (result: { finished: boolean }) => void): void => {
    target.setValue(toValue);
    done?.({ finished: true });
  },
  stop: (): void => {},
});
export const Animated = {
  View: hostComponent('Animated.View'),
  // A plain `Text` host, so the "text lives inside <Text>" rule still holds for it.
  Text: hostComponent('Text'),
  Value: AnimatedValue,
  spring: (target: AnimatedValue, config: { toValue: number }) => finished(target, config.toValue),
  timing: (target: AnimatedValue, config: { toValue: number }) => finished(target, config.toValue),
  parallel: (animations: readonly { start: (done?: () => void) => void }[]) => ({
    start: (done?: (result: { finished: boolean }) => void): void => {
      for (const animation of animations) animation.start();
      done?.({ finished: true });
    },
    stop: (): void => {},
  }),
  sequence: (animations: readonly { start: (done?: () => void) => void }[]) => ({
    start: (done?: (result: { finished: boolean }) => void): void => {
      for (const animation of animations) animation.start();
      done?.({ finished: true });
    },
    stop: (): void => {},
  }),
  /** A loop never ends on its own; here it lands one pass and stops. */
  loop: (animation: { start: (done?: () => void) => void }) => ({
    start: (): void => animation.start(),
    stop: (): void => {},
  }),
  delay: (): { start: (done?: () => void) => void; stop: () => void } => ({
    start: (done) => done?.(),
    stop: () => {},
  }),
};

/** Curves are opaque functions to a component; identity is enough to call them. */
const curve = (value: number): number => value;
export const Easing = {
  bezier: () => curve,
  linear: curve,
  out: () => curve,
  in: () => curve,
  inOut: () => curve,
  sin: curve,
};

/** The system "reduce motion" switch, off until a test flips it with `__setReduceMotion`. */
const reduceMotionListeners = new Set<(enabled: boolean) => void>();
let reduceMotion = false;
let heldAnswer: ((enabled: boolean) => void) | null = null;
let holdAnswer = false;
export const AccessibilityInfo = {
  isReduceMotionEnabled: (): Promise<boolean> =>
    holdAnswer
      ? new Promise((resolve) => {
          heldAnswer = resolve;
        })
      : Promise.resolve(reduceMotion),
  addEventListener: (_event: string, listener: (enabled: boolean) => void) => {
    reduceMotionListeners.add(listener);
    return { remove: () => reduceMotionListeners.delete(listener) };
  },
};
/** The system takes its time answering the first query until `__answerReduceMotion`. */
export function __holdReduceMotionAnswer(): void {
  holdAnswer = true;
}
export function __answerReduceMotion(enabled: boolean): void {
  holdAnswer = false;
  heldAnswer?.(enabled);
  heldAnswer = null;
}
export function __setReduceMotion(enabled: boolean): void {
  reduceMotion = enabled;
  for (const listener of reduceMotionListeners) listener(enabled);
}
export const PanResponder = {
  create: (handlers: AnyProps) => ({ panHandlers: {}, handlers }),
};
