/**
 * The part grade the customer agrees to for each picked repair type that asks for one, on intake
 * and when the repair types change: one row of grades per type, and the warranty the picked grade
 * gives under it, so the counter can tell the customer.
 */
import { ChipRow, Text, ToggleChip, color, space, type } from '@bolusi/ui';
import { StyleSheet, View } from 'react-native';

import type { GradeQuestion } from '../flows.js';
import { tn } from '../i18n.js';
import type { GradePicks } from '../intake-options.js';
import { optionLabel } from '../labels.js';

export function GradePicker({
  questions,
  picks,
  onPick,
  error,
  testID,
}: {
  readonly questions: readonly GradeQuestion[];
  readonly picks: GradePicks;
  readonly onPick: (typeId: string, gradeId: string) => void;
  /** Shown under the first type still without a grade. */
  readonly error?: string | undefined;
  readonly testID: string;
}): React.JSX.Element | null {
  if (questions.length === 0) return null;
  const firstMissing = questions.find(
    ({ type, choices }) => !choices.some((choice) => choice.id === picks[type.id]),
  );
  return (
    <View style={styles.questions}>
      {questions.map(({ type: repairType, choices }) => {
        const picked = choices.find((choice) => choice.id === picks[repairType.id]);
        return (
          <View key={repairType.id} testID={`${testID}.${repairType.id}`}>
            <Text style={styles.label}>
              {tn('repair.condition.grade', { name: optionLabel('repairTypes', repairType) })}
            </Text>
            <ChipRow>
              {choices.map((choice) => (
                <ToggleChip
                  key={choice.id}
                  label={optionLabel('grades', choice)}
                  selected={picked?.id === choice.id}
                  onToggle={() => onPick(repairType.id, choice.id)}
                  testID={`${testID}.${repairType.id}.${choice.id}`}
                />
              ))}
            </ChipRow>
            {picked !== undefined ? (
              <Text style={styles.caption}>
                {picked.warrantyDays === 0
                  ? tn('repair.options.noWarranty')
                  : tn('repair.options.warranty', { count: picked.warrantyDays })}
              </Text>
            ) : error !== undefined && firstMissing?.type.id === repairType.id ? (
              <Text style={styles.error} testID={`${testID}.error`}>
                {error}
              </Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  questions: { marginTop: space.md, gap: space.md },
  label: { ...type.caption, color: color.textMuted, marginBottom: space.xs },
  caption: { ...type.caption, color: color.textMuted, marginTop: space.xs },
  error: { ...type.caption, color: color.danger, marginTop: space.xs },
});
