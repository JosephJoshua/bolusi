/**
 * List (design-system §3.13) — the ONLY collection primitive. Screens never render a raw
 * `FlatList`, and never `.map()` rows.
 *
 * TWO REASONS THIS COMPONENT EXISTS, both structural rather than cosmetic:
 *
 * 1. VIRTUALIZATION IS NOT OPTIONAL, AND NOT A SCREEN'S DECISION. A `.map()` over a year of history
 *    (testing-guide §4.1 `SEED-200K`) dies on the 2 GB target (§0). Owning the primitive here means
 *    the windowing config is written once and correctly, and — the part that matters in a year —
 *    the virtualization ENGINE is a one-file swap instead of a 25-screen rewrite.
 * 2. THE FOUR MANDATORY STATES ARE ENFORCED BY THE TYPE, NOT BY A REVIEWER'S MEMORY. §5 requires
 *    every screen to ship loading/empty/error/unauthorized. Here `state` is a discriminated union,
 *    so a screen that forgets `unauthorized` does not render an empty list — it fails to compile.
 *    §5 says a screen missing any of the four fails review; this makes it fail the build instead.
 *
 * ENGINE CHOICE (verified against current docs at implementation, per 08 §2.1):
 *   - `FlatList` (chosen). Already virtualized, zero new dependencies, and fixed-height rows +
 *     `getItemLayout` is precisely its best case — it skips layout measurement entirely. Our rows
 *     ARE fixed height (§3.4 calls that a performance contract), and pages arrive via cursor
 *     pagination (04 §6), so the mounted window is small by construction.
 *   - `@shopify/flash-list` v2 (rejected for v0). v2 is new-architecture ONLY — it throws at runtime
 *     on old arch — which we satisfy, but it is a NATIVE dependency, and 08 §2.2 is explicit that
 *     "SDK 57 is fresh (July 2026); third-party libs may lag — check compat before adding any
 *     native dep". Its declared peer range (`react-native: '*'`) carries no compatibility signal for
 *     RN 0.86. Recycling buys most on variable-height rows, which we do not have.
 *   - `@legendapp/list` (pre-vetted SWAP TARGET). 100% TypeScript, no native module, drop-in
 *     FlatList API. If the on-device perf gate (testing-guide §4.2) fails on the 2 GB target, this
 *     is the swap — and because it lands in THIS file only, that swap is hours, not a refactor.
 *
 * Row height is `touch.row`, uniform. That is what makes `getItemLayout` legal; a variable-height
 * row would silently void it, so `ListRow`'s fixed height and this component are one contract.
 */
import type { ReactElement } from 'react';
import { useCallback } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';

import { touch } from '../tokens.js';
import { EmptyState, type EmptyStateProps } from './EmptyState.js';
import { ErrorState, type ErrorStateProps } from './ErrorState.js';
import { LoadingState } from './LoadingState.js';
import { UnauthorizedState, type UnauthorizedStateProps } from './UnauthorizedState.js';

/**
 * The §5 mandatory states, as data. `unauthorized` is a first-class member precisely because
 * FR-1036 forbids rendering a denial as an empty list.
 */
export type ListState<TItem> =
  | { readonly kind: 'loading' }
  | { readonly kind: 'empty'; readonly empty: EmptyStateProps }
  | { readonly kind: 'error'; readonly error: ErrorStateProps }
  | { readonly kind: 'unauthorized'; readonly unauthorized: UnauthorizedStateProps }
  | { readonly kind: 'ready'; readonly items: readonly TItem[] };

export interface ListProps<TItem> {
  readonly state: ListState<TItem>;
  readonly renderRow: (item: TItem) => ReactElement;
  readonly keyExtractor: (item: TItem) => string;
  /** Cursor pagination (04 §6 `nextCursor`). Omit when there is no further page. */
  readonly onEndReached?: (() => void) | undefined;
  readonly testID?: string | undefined;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});

/** §7 windowing config for the 2 GB target — written once, here, so no screen has to know it. */
const WINDOW_SIZE = 7;
const INITIAL_NUM_TO_RENDER = 10;

export function List<TItem>({
  state,
  renderRow,
  keyExtractor,
  onEndReached,
  testID = 'ui.list',
}: ListProps<TItem>): React.JSX.Element {
  // Uniform row height is the whole basis of `getItemLayout`: it lets FlatList jump to any offset
  // without measuring, which is what keeps scrolling cheap at 200k rows.
  const getItemLayout = useCallback(
    (_data: ArrayLike<TItem> | null | undefined, index: number) => ({
      length: touch.row,
      offset: touch.row * index,
      index,
    }),
    [],
  );

  switch (state.kind) {
    case 'loading':
      return (
        <View testID={`${testID}.loading`} style={styles.root}>
          <LoadingState variant="skeleton" />
        </View>
      );
    case 'empty':
      return (
        <View testID={`${testID}.empty`} style={styles.root}>
          <EmptyState {...state.empty} />
        </View>
      );
    case 'error':
      return (
        <View testID={`${testID}.error`} style={styles.root}>
          <ErrorState {...state.error} />
        </View>
      );
    case 'unauthorized':
      return (
        <View testID={`${testID}.unauthorized`} style={styles.root}>
          <UnauthorizedState {...state.unauthorized} />
        </View>
      );
    case 'ready':
      return (
        <FlatList
          testID={testID}
          style={styles.root}
          data={state.items as TItem[]}
          renderItem={({ item }) => renderRow(item)}
          keyExtractor={keyExtractor}
          getItemLayout={getItemLayout}
          windowSize={WINDOW_SIZE}
          initialNumToRender={INITIAL_NUM_TO_RENDER}
          // Android-only win on the §0 target: detaches offscreen views from the native hierarchy.
          removeClippedSubviews
          onEndReached={onEndReached}
          onEndReachedThreshold={0.5}
        />
      );
  }
}
