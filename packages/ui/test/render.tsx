/**
 * Test harness over `test-renderer` (React 19's maintained replacement for the deprecated
 * `react-test-renderer`). See `doubles/react-native.tsx` for why we render against doubles and what
 * that does NOT cover.
 *
 * Every helper here queries by `testID` / `accessibilityRole` / props — never by rendered copy
 * (testing-guide T-4). There is no `toMatchSnapshot` anywhere in this package (T-5).
 */
import type { ReactElement } from 'react';
import { act } from 'react';
import { StyleSheet } from 'react-native';
import { createRoot, type TestInstance } from 'test-renderer';

export interface RenderResult {
  readonly container: TestInstance;
  readonly rerender: (element: ReactElement) => void;
  readonly unmount: () => void;
  /** All host nodes matching `testID`. */
  readonly all: (testID: string) => TestInstance[];
  /** The single host node with `testID`; throws when absent or ambiguous. */
  readonly get: (testID: string) => TestInstance;
  /** `null` when absent — for asserting a component renders NOTHING. */
  readonly query: (testID: string) => TestInstance | null;
  readonly byRole: (role: string) => TestInstance[];
  /** Flattened style of the node with `testID`. */
  readonly styleOf: (testID: string) => Record<string, unknown>;
}

export function render(element: ReactElement): RenderResult {
  // `textComponentTypes` makes RN's real rule ("text must live inside <Text>") a test failure
  // rather than something that only surfaces on device.
  const root = createRoot({ textComponentTypes: ['Text'] });
  act(() => root.render(element));

  const all = (testID: string): TestInstance[] =>
    root.container.queryAll((node) => node.props['testID'] === testID);

  const query = (testID: string): TestInstance | null => all(testID)[0] ?? null;

  const get = (testID: string): TestInstance => {
    const found = all(testID);
    if (found.length !== 1) {
      throw new Error(`Expected exactly 1 node with testID ${testID}, found ${found.length}.`);
    }
    return found[0]!;
  };

  return {
    container: root.container,
    rerender: (next) => act(() => root.render(next)),
    unmount: () => act(() => root.unmount()),
    all,
    get,
    query,
    byRole: (role) => root.container.queryAll((node) => node.props['accessibilityRole'] === role),
    styleOf: (testID) => StyleSheet.flatten(get(testID).props['style']),
  };
}

/** Invoke a host node's handler inside `act` so state settles before the next assertion. */
export function fire(node: TestInstance, handler: string, ...args: unknown[]): void {
  const fn = node.props[handler] as ((...a: unknown[]) => void) | undefined;
  if (typeof fn !== 'function') {
    throw new Error(
      `Node has no ${handler} handler (props: ${Object.keys(node.props).join(', ')}).`,
    );
  }
  act(() => fn(...args));
}

/** True when the node declares no `onPress` — how we witness "disabled means not pressable". */
export function isUnwired(node: TestInstance, handler = 'onPress'): boolean {
  return node.props[handler] === undefined;
}

/** Every text string rendered inside `node`'s subtree, for never-echo style assertions. */
export function textsIn(node: TestInstance): string[] {
  const out: string[] = [];
  const walk = (current: TestInstance): void => {
    for (const child of current.children) {
      if (typeof child === 'string') out.push(child);
      else walk(child);
    }
  };
  walk(node);
  return out;
}

/** Every accessibility-facing string/value inside `node`'s subtree. */
export function a11yStringsIn(node: TestInstance): string[] {
  const out: string[] = [];
  const visit = (current: TestInstance): void => {
    const label = current.props['accessibilityLabel'];
    if (typeof label === 'string') out.push(label);
    const value = current.props['accessibilityValue'];
    if (value !== undefined && value !== null) out.push(JSON.stringify(value));
    for (const child of current.children) if (typeof child !== 'string') visit(child);
  };
  visit(node);
  return out;
}
