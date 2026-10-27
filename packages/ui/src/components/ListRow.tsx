/**
 * ListRow (design-system §3.4) — the default collection surface.
 *
 * Text wraps instead of truncating (design guide §4/§9): a long name or a 1.3x font grows the row
 * from its 64 dp default rather than cutting a word off.
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
  /**
   * Set on a row that is one choice of several (the store a device joins): the row becomes a radio,
   * and the chosen one shows a check and bold text, so the choice never rides on colour alone.
   * Only meaningful with `onPress`.
   */
  readonly selected?: boolean | undefined;
  /** The primary text is the thing to find (a person's name), so it is bold. */
  readonly emphasis?: boolean | undefined;
  /** A status under the text (a chip), so it never squeezes a long name the way a trailing chip does. */
  readonly below?: ReactNode;
  readonly testID?: string | undefined;
}

const styles = StyleSheet.create({
  base: {
    minHeight: touch.row,
    paddingVertical: space.sm,
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
  primarySelected: { fontWeight: '600' },
  secondary: { ...type.bodySm, color: color.textMuted },
  below: { flexDirection: 'row', marginTop: space.xs },
  trailing: { flexDirection: 'row', alignItems: 'center', marginLeft: space.sm },
});

export function ListRow({
  primaryText,
  secondaryText,
  leading,
  trailing,
  onPress,
  showChevron = false,
  selected,
  emphasis = false,
  below,
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
          style={[styles.primary, selected === true || emphasis ? styles.primarySelected : null]}
        >
          {primaryText}
        </Text>
        {secondaryText === undefined ? null : (
          <Text testID={`${testID}.secondary`} style={styles.secondary}>
            {secondaryText}
          </Text>
        )}
        {below === undefined ? null : (
          <View testID={`${testID}.below`} style={styles.below}>
            {below}
          </View>
        )}
      </View>

      {trailing === undefined && !showChevron && selected !== true ? null : (
        <View testID={`${testID}.trailing`} style={styles.trailing}>
          {trailing}
          {selected === true ? (
            <View testID={`${testID}.check`}>
              <Icon name="check" size={size.iconInline} color={color.primary} />
            </View>
          ) : null}
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
      accessibilityRole={selected === undefined ? 'button' : 'radio'}
      accessibilityLabel={primaryText}
      {...(selected === undefined ? {} : { accessibilityState: { checked: selected, selected } })}
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
