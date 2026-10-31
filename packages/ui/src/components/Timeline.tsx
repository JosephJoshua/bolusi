/**
 * Timeline — what happened to a record, newest first. Each entry is a dot on a rail with what
 * happened in strong text and when and who underneath, so the eye runs down the events and only
 * reads the details it needs. The newest dot is filled; the rest are hollow, so "where it is now"
 * stands out without colour carrying the meaning alone (the newest entry is also first).
 */
import { Text } from '../text.js';
import { StyleSheet, View } from 'react-native';

import { border, color, radius, space, type } from '../tokens.js';

export interface TimelineEntry {
  readonly key: string;
  /** Already-localized: what happened. */
  readonly title: string;
  /** Already-localized: when, and by whom. */
  readonly meta: string;
  /** Already-localized: an optional note that came with the event. */
  readonly detail?: string | undefined;
}

export interface TimelineProps {
  /** Newest first. */
  readonly entries: readonly TimelineEntry[];
  readonly testID?: string | undefined;
}

const DOT = space.md;
const RAIL = space.xl;

const styles = StyleSheet.create({
  entry: { flexDirection: 'row' },
  railColumn: { width: RAIL, alignItems: 'center' },
  dot: {
    width: DOT,
    height: DOT,
    borderRadius: radius.full,
    borderWidth: border.focus,
    borderColor: color.primary,
    // Centres the dot on the title's first line.
    marginTop: (type.bodySm.lineHeight - DOT) / 2,
  },
  line: { flex: 1, width: border.focus, backgroundColor: color.border, marginTop: space.xs },
  body: { flex: 1, paddingBottom: space.lg, marginLeft: space.sm },
  title: { ...type.bodySm, fontWeight: '600', color: color.text },
  meta: { ...type.caption, color: color.textMuted },
  detail: { ...type.caption, color: color.text, marginTop: space.xs },
});

export function Timeline({ entries, testID = 'ui.timeline' }: TimelineProps): React.JSX.Element {
  return (
    <View testID={testID}>
      {entries.map((entry, index) => {
        const last = index === entries.length - 1;
        return (
          <View key={entry.key} style={styles.entry} testID={`${testID}.entry.${entry.key}`}>
            <View style={styles.railColumn}>
              <View
                style={[
                  styles.dot,
                  { backgroundColor: index === 0 ? color.primary : color.surface },
                ]}
              />
              {last ? null : <View style={styles.line} />}
            </View>
            <View style={[styles.body, last ? { paddingBottom: 0 } : null]}>
              <Text style={styles.title}>{entry.title}</Text>
              <Text style={styles.meta}>{entry.meta}</Text>
              {entry.detail === undefined ? null : (
                <Text style={styles.detail}>{entry.detail}</Text>
              )}
            </View>
          </View>
        );
      })}
    </View>
  );
}
