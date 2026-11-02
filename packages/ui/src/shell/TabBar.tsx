/**
 * TabBar — the app's top-level places (Servisan, Kas), one tap apart. The chosen tab is drawn in
 * the primary colour with a bold label, so it never rides on colour alone. Shown only when a person
 * has more than one place to go, and only on a place's top level: a screen with a back arrow owns
 * the bottom for its own action.
 *
 * `bar` sits along the bottom, inside the screen's `AppShell` dock (`ShellTabsProvider`), which
 * draws the rule above it. `rail` stands down the left edge of a wide tablet, so the bottom is left
 * to the open servisan's action beside the board.
 */
import { Text } from '../text.js';
import { Pressable, StyleSheet, View } from 'react-native';

import { Icon, type IconName } from '../components/Icon.js';
import { border, color, size, space, type } from '../tokens.js';

export interface TabBarTab<K extends string> {
  readonly key: K;
  /** Already-localized. */
  readonly label: string;
  readonly icon: IconName;
}

export interface TabBarProps<K extends string> {
  readonly tabs: readonly TabBarTab<K>[];
  readonly selected: K;
  readonly onSelect: (key: K) => void;
  readonly variant?: 'bar' | 'rail' | undefined;
  readonly testID?: string | undefined;
}

/** Wide enough for "Servisan" at 1.3x on one line; a longer label wraps rather than clipping. */
const RAIL_WIDTH = 96;

const styles = StyleSheet.create({
  bar: { backgroundColor: color.surface },
  rail: {
    width: RAIL_WIDTH,
    backgroundColor: color.surface,
    borderRightWidth: border.hairline,
    borderRightColor: color.border,
    paddingTop: space.sm,
  },
  // On a tablet the tabs sit under the content's column, not at the far edges of the screen.
  tabs: { flexDirection: 'row', width: '100%', maxWidth: size.contentMax, alignSelf: 'center' },
  railTabs: { gap: space.xs },
  railTab: { minHeight: size.header + space.lg, paddingHorizontal: space.xs },
  tab: {
    flex: 1,
    minHeight: size.header,
    paddingVertical: space.xs,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
  },
  pressed: { backgroundColor: color.surfaceAlt },
  label: { ...type.caption, color: color.textMuted, textAlign: 'center' },
  labelSelected: { color: color.primary, fontWeight: '700' },
});

export function TabBar<K extends string>({
  tabs,
  selected,
  onSelect,
  variant = 'bar',
  testID = 'ui.tabBar',
}: TabBarProps<K>): React.JSX.Element {
  const rail = variant === 'rail';
  return (
    <View style={rail ? styles.rail : styles.bar} testID={testID}>
      <View style={rail ? styles.railTabs : styles.tabs} accessibilityRole="tablist">
        {tabs.map((tab) => {
          const chosen = tab.key === selected;
          return (
            <Pressable
              key={tab.key}
              accessibilityRole="tab"
              accessibilityState={{ selected: chosen }}
              accessibilityLabel={tab.label}
              onPress={() => onSelect(tab.key)}
              style={({ pressed }) => [
                styles.tab,
                rail && styles.railTab,
                pressed && styles.pressed,
              ]}
              testID={`${testID}.${tab.key}`}
            >
              <Icon name={tab.icon} size={24} color={chosen ? color.primary : color.textMuted} />
              <Text style={[styles.label, chosen && styles.labelSelected]}>{tab.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
