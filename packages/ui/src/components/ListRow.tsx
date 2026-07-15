/**
 * ListRow (design-system §3.4) — the default collection surface.
 *
 * The fixed height is a PERFORMANCE CONTRACT, not a style choice (§3.4, §7): `FlatList` gets
 * `getItemLayout` from it, which is what keeps long lists cheap on the 2 GB target (§0). A row
 * that grows to fit its content silently removes that guarantee — hence single-line text with
 * tail ellipsis rather than wrapping.
 */
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { border, color, size, space, touch, type } from '../tokens.js';
import { Icon } from './Icon.js';

export interface ListRowProps {
  /** Already-localized primary text. */
  readonly primaryText: string;
  /** Already-localized secondary text (timestamp, preview, meta). */
  readonly secondaryText?: string | undefined;
  /** Leading slot: icon or avatar, `size.avatarRow` (§3.4). */
  readonly leading?: ReactNode;
  /** Trailing slot: typically a SyncStatusChip (§3.5). */
  readonly trailing?: ReactNode;
  readonly onPress?: (() => void) | undefined;
  /** §3.4: a chevron marks a row that navigates. Only meaningful with `onPress`. */
  readonly showChevron?: boolean | undefined;
  readonly testID?: string | undefined;
}

const styles = StyleSheet.create({
  base: {
    height: touch.row,
    minHeight: touch.rowMin,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    borderBottomWidth: border.hairline,
    borderBottomColor: color.border,
  },
  leading: {
    width: size.avatarRow,
    height: size.avatarRow,
    marginRight: space.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  texts: { flex: 1, justifyContent: 'center' },
  primary: { ...type.body, color: color.text },
  secondary: { ...type.bodySm, color: color.textMuted },
  trailing: { flexDirection: 'row', alignItems: 'center', marginLeft: space.sm },
});

export function ListRow({
  primaryText,
  secondaryText,
  leading,
  trailing,
  onPress,
  showChevron = false,
  testID = 'ui.listRow',
}: ListRowProps): React.JSX.Element {
  const content = (
    <>
      {leading === undefined ? null : (
        <View testID={`${testID}.leading`} style={styles.leading}>
          {leading}
        </View>
      )}

      <View style={styles.texts}>
        <Text
          testID={`${testID}.primary`}
          numberOfLines={1}
          ellipsizeMode="tail"
          style={styles.primary}
        >
          {primaryText}
        </Text>
        {secondaryText === undefined ? null : (
          <Text
            testID={`${testID}.secondary`}
            numberOfLines={1}
            ellipsizeMode="tail"
            style={styles.secondary}
          >
            {secondaryText}
          </Text>
        )}
      </View>

      {trailing === undefined && !showChevron ? null : (
        <View testID={`${testID}.trailing`} style={styles.trailing}>
          {trailing}
          {showChevron ? (
            <Icon name="chevron" size={size.iconInline} color={color.textMuted} />
          ) : null}
        </View>
      )}
    </>
  );

  if (onPress === undefined) {
    return (
      <View testID={testID} style={styles.base}>
        {content}
      </View>
    );
  }

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={primaryText}
      onPress={onPress}
      android_ripple={{ color: color.surfaceAlt }}
      style={({ pressed }) => [
        styles.base,
        { backgroundColor: pressed ? color.surfaceAlt : color.surface },
      ]}
    >
      {content}
    </Pressable>
  );
}
