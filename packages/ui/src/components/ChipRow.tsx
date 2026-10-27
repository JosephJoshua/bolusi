/**
 * ChipRow — a row of choice chips that scrolls sideways, for lists whose length the shop or the
 * catalog decides (colours, quick brands, accessories). Wrapped chips would push the rest of the
 * form down by a line for every few choices; a row keeps one line's height however many there are.
 * Like PhotoStrip, it runs to the screen edges so the cut-off last chip shows there is more.
 */
import type { ReactNode } from 'react';
import { ScrollView, StyleSheet } from 'react-native';

import { space } from '../tokens.js';

export interface ChipRowProps {
  /** ToggleChip or Chip elements, in order. */
  readonly children: ReactNode;
  readonly testID?: string | undefined;
}

/** The screen padding the row bleeds through (AppShell content uses `space.lg`). */
const BLEED = space.lg;

const styles = StyleSheet.create({
  scroller: { flexGrow: 0, marginHorizontal: -BLEED },
  row: { paddingHorizontal: BLEED, gap: space.sm, alignItems: 'center' },
});

export function ChipRow({ children, testID = 'ui.chipRow' }: ChipRowProps): React.JSX.Element {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      // A tap on a chip lands even while a field above still holds the keyboard.
      keyboardShouldPersistTaps="handled"
      style={styles.scroller}
      contentContainerStyle={styles.row}
      testID={testID}
    >
      {children}
    </ScrollView>
  );
}
