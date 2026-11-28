// The PC's part grade picker, on intake and when the repair types change: one row of grades per
// picked repair type that asks for one, and the warranty the picked grade gives beside it.
import { ToggleChip } from '@bolusi/ui-web';

import type { GradeQuestion } from '../flows.js';
import { tn } from '../i18n.js';
import type { GradePicks } from '../intake-options.js';
import { optionLabel } from '../labels.js';

export function GradePicker({
  questions,
  picks,
  onPick,
  error,
  testId,
}: {
  readonly questions: readonly GradeQuestion[];
  readonly picks: GradePicks;
  readonly onPick: (typeId: string, gradeId: string) => void;
  /** Shown under the first type still without a grade. */
  readonly error?: string | undefined;
  readonly testId: string;
}): React.JSX.Element | null {
  if (questions.length === 0) return null;
  const firstMissing = questions.find(
    ({ type, choices }) => !choices.some((choice) => choice.id === picks[type.id]),
  );
  return (
    <div className="mt-4 flex flex-col gap-4" data-testid={testId}>
      {questions.map(({ type, choices }) => {
        const picked = choices.find((choice) => choice.id === picks[type.id]);
        return (
          <div key={type.id} role="group" aria-labelledby={`${testId}.${type.id}.label`}>
            <p id={`${testId}.${type.id}.label`} className="mb-2 text-small text-text-muted">
              {tn('repair.condition.grade', { name: optionLabel('repairTypes', type) })}
            </p>
            <div className="flex flex-wrap items-center gap-2" data-testid={`${testId}.${type.id}`}>
              {choices.map((choice) => (
                <ToggleChip
                  key={choice.id}
                  label={optionLabel('grades', choice)}
                  selected={picked?.id === choice.id}
                  onToggle={() => onPick(type.id, choice.id)}
                />
              ))}
              {picked !== undefined ? (
                <span className="ml-2 text-small text-text-muted">
                  {picked.warrantyDays === 0
                    ? tn('repair.options.noWarranty')
                    : tn('repair.options.warranty', { count: picked.warrantyDays })}
                </span>
              ) : null}
            </div>
            {picked === undefined && error !== undefined && firstMissing?.type.id === type.id ? (
              <p role="alert" className="mt-1 text-small text-danger">
                {error}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
