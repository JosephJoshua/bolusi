/**
 * TabBar — the app's top-level places (Servisan, Kas) along the bottom edge, one tap apart. The
 * chosen tab is drawn in the primary colour with a bold label, so it never rides on colour alone.
 * Shown only when a person has more than one place to go.
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
  readonly testID?: string | undefined;
}

const styles = StyleSheet.create({
  bar: {
    borderTopWidth: border.hairline,
    borderTopColor: color.border,
    backgroundColor: color.surface,
  },
  // On a tablet the tabs sit under the content's column, not at the far edges of the screen.
  tabs: { flexDirection: 'row', width: '100%', maxWidth: size.contentMax, alignSelf: 'center' },
  tab: {
    flex: 1,
    minHeight: size.header,
    paddingVertical: space.xs,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
  },
  pressed: { backgroundColor: color.surfaceAlt },
  label: { ...type.caption, color: color.textMuted },
  labelSelected: { color: color.primary, fontWeight: '700' },
});

export function TabBar<K extends string>({
  tabs,
  selected,
  onSelect,
  testID = 'ui.tabBar',
}: TabBarProps<K>): React.JSX.Element {
  return (
    <View style={styles.bar} testID={testID}>
      <View style={styles.tabs} accessibilityRole="tablist">
        {tabs.map((tab) => {
          const chosen = tab.key === selected;
          return (
            <Pressable
              key={tab.key}
              accessibilityRole="tab"
              accessibilityState={{ selected: chosen }}
              accessibilityLabel={tab.label}
              onPress={() => onSelect(tab.key)}
              style={({ pressed }) => [styles.tab, pressed && styles.pressed]}
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
