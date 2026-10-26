/**
 * StepHeader — where a person is in a guided flow (intake, handover): "Langkah 2 dari 6" and the
 * step's title, over a segmented progress bar. The count is text, so progress never rides on the
 * bar's colour alone (§6.3).
 */
import { StyleSheet, Text, View } from 'react-native';

import { color, radius, space, type } from '../tokens.js';

export interface StepHeaderProps {
  /** 1-based. */
  readonly step: number;
  readonly total: number;
  /** Already-localized, e.g. "Langkah 2 dari 6". */
  readonly progressLabel: string;
  /** Already-localized step title. */
  readonly title: string;
  readonly testID?: string | undefined;
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', gap: space.xs, marginBottom: space.sm },
  segment: { flex: 1, height: space.xs, borderRadius: radius.full },
  progress: { ...type.caption, color: color.textMuted },
  title: { ...type.heading, color: color.text },
});

export function StepHeader({
  step,
  total,
  progressLabel,
  title,
  testID = 'ui.stepHeader',
}: StepHeaderProps): React.JSX.Element {
  return (
    <View testID={testID} accessibilityLabel={`${progressLabel}. ${title}`}>
      <View style={styles.bar}>
        {Array.from({ length: total }, (_, index) => (
          <View
            key={index}
            style={[
              styles.segment,
              { backgroundColor: index < step ? color.primary : color.border },
            ]}
          />
        ))}
      </View>
      <Text style={styles.progress} testID={`${testID}.progress`}>
        {progressLabel}
      </Text>
      <Text style={styles.title} testID={`${testID}.title`}>
        {title}
      </Text>
    </View>
  );
}
