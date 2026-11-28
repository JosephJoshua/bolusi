// Editing one of the store's intake lists, the same on the phone and the PC. The rows are compared
// with the latest of the live read and this editor's own last save, so a save shows as saved
// before its change comes back, and untouched rows follow a change that syncs in. Saving writes
// the list first and then what is hidden; if hiding fails after the list saved, the editor starts
// again from the saved list so saving again never adds its new rows twice.
import { useEffect, useRef, useState } from 'react';

import { useActionRunner } from '../screen-kit/index.js';

import type { RepairAbilities } from './flows.js';
import type { IntakeOptionList, IntakeOptionSettings } from './intake-options.js';
import { builtInLabel, optionLabel } from './labels.js';
import {
  changedHidden,
  changedItems,
  editorFor,
  editorProblems,
  hasProblems,
  type BuiltInName,
  type EditorState,
} from './options-editor.js';
import { useRepairRuntime } from './runtime.js';

export function useOptionsEditor(
  list: IntakeOptionList,
  /** The lists as they are now, kept live. */
  settings: IntakeOptionSettings,
  can: Pick<RepairAbilities, 'manageIntakeOptions' | 'hideIntakeOptions'>,
) {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const builtInName: BuiltInName = (option) => builtInLabel(list, option.id);
  const [state, setState] = useState<EditorState>(() => editorFor(list, settings, builtInName));
  const [showProblems, setShowProblems] = useState(false);
  const manage = can.manageIntakeOptions;
  const hide = can.hideIntakeOptions;
  const changes = (against: IntakeOptionSettings, rows: EditorState) => ({
    items: manage ? changedItems(rows, against.lists[list], builtInName) : null,
    hidden: hide ? changedHidden(rows, against.hidden[list]) : null,
  });
  const [base, setBase] = useState(settings);
  const { items, hidden } = changes(base, state);
  const dirty = items !== null || hidden !== null;
  const problems = editorProblems(state, builtInName, (option) => optionLabel(list, option));

  const live = useRef(settings);
  useEffect(() => {
    if (live.current === settings) return;
    live.current = settings;
    const edited = changes(base, state);
    setBase(settings);
    if (edited.items === null && edited.hidden === null) {
      setState(editorFor(list, settings, builtInName));
    }
    // Only a new read decides; the rows are the ones on screen at that moment.
  }, [settings]);

  /** Starts again from what was saved: new rows now have ids. */
  const restart = (fresh: IntakeOptionSettings): void => {
    setBase(fresh);
    setState(editorFor(list, fresh, builtInName));
  };

  /**
   * Saves, or shows the problems (`onProblems`) when there are some; `onSaved` once both parts
   * landed. Nothing changed saves nothing and calls `onSaved` straight away.
   */
  const save = (done: { readonly onSaved: () => void; readonly onProblems?: () => void }): void => {
    if (runner.busy) return;
    if (hasProblems(problems)) {
      setShowProblems(true);
      done.onProblems?.();
      return;
    }
    if (!dirty) {
      done.onSaved();
      return;
    }
    void runner
      .run(async () => {
        const read = async () => (await runtime.query('intakeOptionSettings', {})).rows[0]!;
        // The list first: hiding then applies to the list as saved.
        if (items !== null) await runtime.run('changeIntakeOptions', { list, items });
        try {
          if (hidden !== null) await runtime.run('hideIntakeOptions', { list, hidden });
        } catch (error) {
          // The list did save: show it as saved. What was to be hidden is chosen again.
          if (items !== null) restart(await read());
          throw error;
        }
        return read();
      })
      .then((fresh) => {
        if (fresh === undefined) return;
        restart(fresh);
        setShowProblems(false);
        done.onSaved();
      });
  };

  return {
    runner,
    builtInName,
    state,
    setState,
    showProblems,
    problems,
    dirty,
    manage,
    hide,
    save,
    /** Back to the list as saved, typed changes gone. */
    discard: (): void => {
      setShowProblems(false);
      setState(editorFor(list, base, builtInName));
    },
  };
}
