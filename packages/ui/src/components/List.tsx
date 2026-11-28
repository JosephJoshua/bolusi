/** Virtualized list with shared loading, empty, error and unauthorized states.
 * Rows may have different heights; let FlatList measure them instead of supplying guessed offsets.
 */
import { useCallback, type ReactElement } from 'react';
import { FlatList, StyleSheet, View, type ListRenderItem } from 'react-native';

import { useDataArriving } from '../arrival.js';
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
  /** Keep it stable (`useCallback`) and the rows memoized, or every screen render redraws them all. */
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
  // Stable while `renderRow` is, so a screen re-render with the same items re-renders no rows.
  const renderItem = useCallback<ListRenderItem<TItem>>(({ item }) => renderRow(item), [renderRow]);
  // A new device's first sync is still bringing the rows: an empty list then is loading, not news.
  const arriving = useDataArriving();
  const shown: ListState<TItem> = state.kind === 'empty' && arriving ? { kind: 'loading' } : state;
  switch (shown.kind) {
    case 'loading':
      return (
        <View testID={`${testID}.loading`} style={styles.root}>
          <LoadingState variant="skeleton" />
        </View>
      );
    case 'empty':
      return (
        <View testID={`${testID}.empty`} style={styles.root}>
          <EmptyState {...shown.empty} />
        </View>
      );
    case 'error':
      return (
        <View testID={`${testID}.error`} style={styles.root}>
          <ErrorState {...shown.error} />
        </View>
      );
    case 'unauthorized':
      return (
        <View testID={`${testID}.unauthorized`} style={styles.root}>
          <UnauthorizedState {...shown.unauthorized} />
        </View>
      );
    case 'ready':
      return (
        <FlatList
          testID={testID}
          style={styles.root}
          data={shown.items as TItem[]}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
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
