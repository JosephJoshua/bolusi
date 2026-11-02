/**
 * PhotoStrip — a record's photos as one row of thumbnails that scrolls sideways, so ten photos take
 * the height of one. Each tile keeps its caption (which shot it is) and opens the photo full screen.
 * The row runs to the screen edges, so the last tile is cut off at the edge: that partial tile is
 * what tells a person there is more to swipe to.
 *
 * Images are passed in, since the platform owns image rendering (as in PhotoSlot).
 */
import type { ReactNode } from 'react';
import { Text } from '../text.js';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { color, radius, size, space, type } from '../tokens.js';
import { bleedMargins, bleedPadding, useBleed } from '../layout.js';

export interface PhotoStripItem {
  readonly key: string;
  /** Already-localized caption, e.g. "Depan", "Sebelum 1". */
  readonly label: string;
  readonly image: ReactNode;
}

export interface PhotoStripProps {
  readonly photos: readonly PhotoStripItem[];
  /** Opens the photo at `index` full screen. */
  readonly onOpen: (index: number) => void;
  /** Already-localized verb read before each caption, e.g. "Buka foto". */
  readonly openLabel: string;
  readonly testID?: string | undefined;
}

// It bleeds through the screen's gutter (`useBleed`), and only the outer one beside another column.
const styles = StyleSheet.create({
  scroller: { flexGrow: 0 },
  row: { gap: space.sm },
  tile: { width: size.photoStrip },
  image: {
    width: size.photoStrip,
    height: size.photoStrip,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: color.surfaceAlt,
  },
  label: { ...type.caption, color: color.textMuted, marginTop: space.xs },
});

export function PhotoStrip({
  photos,
  onOpen,
  openLabel,
  testID = 'ui.photoStrip',
}: PhotoStripProps): React.JSX.Element {
  const bleed = useBleed();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={[styles.scroller, bleedMargins(bleed)]}
      contentContainerStyle={[styles.row, bleedPadding(bleed)]}
      testID={testID}
    >
      {photos.map((photo, index) => (
        <Pressable
          key={photo.key}
          testID={`${testID}.${photo.key}`}
          accessibilityRole="imagebutton"
          accessibilityLabel={`${openLabel} ${photo.label}`}
          onPress={() => onOpen(index)}
          style={styles.tile}
        >
          <View style={styles.image}>{photo.image}</View>
          <Text style={styles.label} numberOfLines={1}>
            {photo.label}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}
