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

/** The screen padding the strip bleeds through (AppShell content uses `space.lg`). */
const BLEED = space.lg;

const styles = StyleSheet.create({
  scroller: { flexGrow: 0, marginHorizontal: -BLEED },
  row: { paddingHorizontal: BLEED, gap: space.md },
  // At least the photo's width, and wider for a caption that needs it (a large font, a long angle
  // name): a caption wraps between words and is never cut. Two photos wide at most, so a long
  // caption takes a second line instead of one very wide tile.
  tile: { minWidth: size.photoStrip, maxWidth: size.photoStrip * 2 },
  image: {
    width: size.photoStrip,
    height: size.photoStrip,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: color.surfaceAlt,
  },
  // No fixed lineHeight: on Android 15+ a one-word caption with one drew its last glyph on a
  // second, hidden line at font 2.0 ("Belakan"), the same bounds bug the segmented labels had.
  label: { ...type.caption, lineHeight: undefined, color: color.textMuted, marginTop: space.xs },
});

export function PhotoStrip({
  photos,
  onOpen,
  openLabel,
  testID = 'ui.photoStrip',
}: PhotoStripProps): React.JSX.Element {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.scroller}
      contentContainerStyle={styles.row}
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
          <Text style={styles.label}>{photo.label}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}
