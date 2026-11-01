/**
 * ChipRow — a row of choice chips that scrolls sideways, for lists whose length the shop or the
 * catalog decides (colours, quick brands, accessories). Wrapped chips would push the rest of the
 * form down by a line for every few choices; a row keeps one line's height however many there are.
 * Like PhotoStrip, it runs to the screen edges so the cut-off last chip shows there is more.
 */
import type { ReactNode } from 'react';
import { ScrollView, StyleSheet } from 'react-native';

import { bleedMargins, bleedPadding, useBleed } from '../layout.js';
import { space } from '../tokens.js';

export interface ChipRowProps {
  /** ToggleChip or Chip elements, in order. */
  readonly children: ReactNode;
  readonly testID?: string | undefined;
}

// It bleeds through the screen's gutter (`useBleed`), and only the outer one beside another column.
const styles = StyleSheet.create({
  scroller: { flexGrow: 0 },
  row: { gap: space.sm, alignItems: 'center' },
});

export function ChipRow({ children, testID = 'ui.chipRow' }: ChipRowProps): React.JSX.Element {
  const bleed = useBleed();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      // A tap on a chip lands even while a field above still holds the keyboard.
      keyboardShouldPersistTaps="handled"
      style={[styles.scroller, bleedMargins(bleed)]}
      contentContainerStyle={[styles.row, bleedPadding(bleed)]}
      testID={testID}
    >
      {children}
    </ScrollView>
  );
}
