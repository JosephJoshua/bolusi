// Changing a servisan's repair types and the part grade of each, the same on the phone and the PC.
// Saving an unchanged pick only closes the step. Each app only draws the choices.
import { useState } from 'react';

import { useActionRunner } from '../screen-kit/index.js';

import { gradeQuestions, gradesMissing, pickedGrades, type GradeQuestion } from './flows.js';
import {
  gradeOf,
  repairTypeChoices,
  storeIntakeOptions,
  type IntakeOption,
  type IntakeOptionLists,
} from './intake-options.js';
import type { TicketDetailRow } from './queries.js';
import { useIntakeOptionSettings, useRepairRuntime } from './runtime.js';

export function useRepairTypesPick(
  facts: { readonly ticketId: string; readonly current: TicketDetailRow['repairTypes'] },
  done: { readonly onDone: () => void; readonly onUnchanged: () => void },
) {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const settings = useIntakeOptionSettings();
  const { ticketId, current } = facts;
  const [picked, setPicked] = useState<readonly string[]>(() => current.map((type) => type.item));
  const [grades, setGrades] = useState<Readonly<Record<string, string>>>(() =>
    Object.fromEntries(
      current.flatMap((type) => {
        const grade = gradeOf(type);
        return grade === null ? [] : [[type.item, grade]];
      }),
    ),
  );
  const [showGradeError, setShowGradeError] = useState(false);
  const offered: IntakeOptionLists | null =
    settings.status === 'ready' ? storeIntakeOptions(settings.data) : null;
  const choices: IntakeOption[] =
    offered === null ? [] : repairTypeChoices(offered.repairTypes, current);
  const questions: GradeQuestion[] =
    offered === null ? [] : gradeQuestions(picked, offered.repairTypes, offered.grades);
  const missing = offered !== null && gradesMissing(picked, grades, offered);
  const changed =
    picked.length !== current.length ||
    picked.some(
      (id, i) => id !== current[i]!.item || (grades[id] ?? null) !== gradeOf(current[i]!),
    );
  const pickGrade = (typeId: string, gradeId: string): void =>
    setGrades((all) => ({ ...all, [typeId]: gradeId }));
  const submit = (): void => {
    if (offered === null) return;
    if (missing) {
      setShowGradeError(true);
      return;
    }
    if (!changed) {
      done.onUnchanged();
      return;
    }
    void runner
      .run(() =>
        runtime.run('setRepairTypes', {
          ticketId,
          repairTypes: [...picked],
          grades: pickedGrades(picked, grades, offered),
        }),
      )
      .then((result) => {
        if (result !== undefined) done.onDone();
      });
  };
  return {
    runner,
    settings,
    choices,
    picked,
    setPicked,
    questions,
    grades,
    pickGrade,
    gradeError: showGradeError && missing,
    submit,
  };
}
