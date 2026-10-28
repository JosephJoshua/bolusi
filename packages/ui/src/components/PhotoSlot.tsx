/**
 * PhotoSlot — one requested photo in a guided capture ("Depan", "Belakang"). Empty, it is a large
 * camera target labelled with the shot it asks for; filled, it shows the image (passed in, since
 * the platform owns image rendering) with a check, and tapping it retakes. The label stays visible
 * in both states, so a person always knows which angle a tile is.
 */
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { border, color, radius, size, space, touch, type } from '../tokens.js';
import { Icon } from './Icon.js';

export interface PhotoSlotProps {
  /** Already-localized name of the shot. */
  readonly label: string;
  /** The rendered thumbnail, or null when the slot is still empty. */
  readonly image: ReactNode | null;
  /** Already-localized; read out with the label, e.g. "Ambil foto" / "Ambil ulang". */
  readonly actionLabel: string;
  /** What an empty slot asks for; a camera unless the slot takes something else (a signature). */
  readonly emptyIcon?: 'camera' | 'signature' | 'video' | undefined;
  /** Absent ⇒ the slot is read-only (a ticket's recorded evidence). */
  readonly onPress?: (() => void) | undefined;
  readonly testID?: string | undefined;
}

const styles = StyleSheet.create({
  tile: {
    aspectRatio: 1,
    minHeight: touch.primary,
    borderRadius: radius.md,
    borderWidth: border.hairline,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  image: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
  done: {
    position: 'absolute',
    top: space.xs,
    right: space.xs,
    borderRadius: radius.full,
    backgroundColor: color.successBg,
    padding: space.xs,
  },
  label: { ...type.caption, color: color.text, marginTop: space.xs, textAlign: 'center' },
});

export function PhotoSlot({
  label,
  image,
  actionLabel,
  emptyIcon = 'camera',
  onPress,
  testID = 'ui.photoSlot',
}: PhotoSlotProps): React.JSX.Element {
  const filled = image !== null;
  const body = (
    <>
      {filled ? (
        <View style={styles.image}>{image}</View>
      ) : (
        <Icon name={emptyIcon} size={size.iconState} color={color.textMuted} />
      )}
      {filled ? (
        <View style={styles.done} testID={`${testID}.done`}>
          <Icon name="check" size={size.iconChip} color={color.onSuccessBg} />
        </View>
      ) : null}
    </>
  );
  const tileStyle = [
    styles.tile,
    {
      backgroundColor: filled ? color.surface : color.surfaceAlt,
      borderColor: filled ? color.border : color.primary,
      borderStyle: filled ? ('solid' as const) : ('dashed' as const),
    },
  ];

  return (
    <View testID={testID}>
      {onPress === undefined ? (
        <View style={tileStyle}>{body}</View>
      ) : (
        <Pressable
          testID={`${testID}.press`}
          accessibilityRole="button"
          accessibilityLabel={`${label}. ${actionLabel}`}
          onPress={onPress}
          style={tileStyle}
        >
          {body}
        </Pressable>
      )}
      <Text style={styles.label} numberOfLines={2}>
        {label}
      </Text>
    </View>
  );
}
