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

export const View = hostComponent('View');
export const Text = hostComponent('Text');
export const TextInput = hostComponent('TextInput');
export const ActivityIndicator = hostComponent('ActivityIndicator');
export const ScrollView = hostComponent('ScrollView');

/**
 * Renders every item rather than a window. That is deliberate and its limits must be understood:
 * REAL virtualization is RN's job and is not under test here. What IS under test — and what this
 * double preserves exactly — is that `List` WIRES the windowing contract (`getItemLayout`,
 * `windowSize`, `removeClippedSubviews`) and renders each item through `renderItem`. Those props
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

export const Platform = { OS: 'android', select: (spec: AnyProps): unknown => spec['android'] };
