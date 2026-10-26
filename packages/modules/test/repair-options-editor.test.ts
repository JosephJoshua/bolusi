// The owner's list editor as pure state: what a row saves as, which problems it shows where, and
// that saving an untouched list sends nothing.
import { describe, expect, test } from 'vitest';

import {
  DEFAULT_INTAKE_OPTIONS,
  NOTHING_HIDDEN,
  type IntakeOption,
  type IntakeOptionSettings,
} from '../src/repair/intake-options.js';
import {
  addRow,
  changedHidden,
  changedItems,
  editorFor,
  editorProblems,
  moveRow,
  removeRow,
  updateRow,
  type BuiltInName,
} from '../src/repair/options-editor.js';

const NAMES: Record<string, string> = { screen: 'Layar', touch: 'Sentuhan', front: 'Depan' };
const builtInName: BuiltInName = (o) => (o.label === null ? (NAMES[o.id] ?? null) : null);
const nameOf = (o: IntakeOption) => o.label ?? NAMES[o.id] ?? o.id;

const settings: IntakeOptionSettings = {
  lists: {
    ...DEFAULT_INTAKE_OPTIONS,
    checks: [
      { id: 'screen', label: null },
      { id: 'touch', label: null },
    ],
  },
  hidden: { ...NOTHING_HIDDEN, checks: ['touch'] },
};

describe('the list editor', () => {
  test('rows start as the saved list with built-in names and this store’s hiding', () => {
    const state = editorFor('checks', settings, builtInName);
    expect(state.rows).toStrictEqual([
      { key: 'screen', id: 'screen', text: 'Layar', hidden: false },
      { key: 'touch', id: 'touch', text: 'Sentuhan', hidden: true },
    ]);
    expect(changedItems(state, settings.lists.checks, builtInName)).toBeNull();
    expect(changedHidden(state, settings.hidden.checks)).toBeNull();
  });

  test('a built-in keeps a null label until renamed; added rows save with no id', () => {
    let state = editorFor('checks', settings, builtInName);
    state = updateRow(state, 'touch', { text: 'Layar sentuh' });
    const added = addRow(state);
    state = updateRow(added.state, added.key, { text: 'Face ID' });
    expect(changedItems(state, settings.lists.checks, builtInName)).toStrictEqual([
      { id: 'screen', label: null },
      { id: 'touch', label: 'Layar sentuh' },
      { id: null, label: 'Face ID' },
    ]);
  });

  test('moving and removing rows changes the saved order', () => {
    let state = editorFor('checks', settings, builtInName);
    expect(moveRow(state, 'screen', -1)).toBe(state);
    state = moveRow(state, 'screen', 1);
    expect(state.rows.map((r) => r.id)).toStrictEqual(['touch', 'screen']);
    state = removeRow(state, 'touch');
    expect(changedItems(state, settings.lists.checks, builtInName)).toStrictEqual([
      { id: 'screen', label: null },
    ]);
  });

  test('problems point at the row to fix: empty, too long, and the later duplicate', () => {
    let state = editorFor('checks', settings, builtInName);
    const one = addRow(state);
    const two = addRow(one.state);
    const three = addRow(two.state);
    state = updateRow(three.state, one.key, { text: '' });
    state = updateRow(state, two.key, { text: 'x'.repeat(61) });
    state = updateRow(state, three.key, { text: ' layar ' });
    const problems = editorProblems(state, builtInName, nameOf);
    expect([...problems.rows]).toStrictEqual([
      [one.key, 'emptyLabel'],
      [two.key, 'labelTooLong'],
      [three.key, 'duplicate'],
    ]);
  });

  test('ready-by rows are days or “unknown”, saved soonest first', () => {
    let state = editorFor('readyBy', { ...settings }, builtInName);
    const seven = addRow(state);
    state = updateRow(seven.state, seven.key, { text: '7' });
    const bad = addRow(state);
    state = updateRow(bad.state, bad.key, { text: 'besok' });
    expect(editorProblems(state, builtInName, nameOf).rows.get(bad.key)).toBe('badReadyBy');

    state = removeRow(state, bad.key);
    state = moveRow(state, seven.key, -1);
    expect(
      changedItems(state, settings.lists.readyBy, builtInName)?.map((i) => i.id),
    ).toStrictEqual(['0', '1', '3', '7', 'unknown']);
  });

  test('hiding every saved item of a must-have list is a list problem', () => {
    let state = editorFor('photoAngles', settings, builtInName);
    for (const row of state.rows) state = updateRow(state, row.key, { hidden: true });
    expect(editorProblems(state, builtInName, nameOf).list).toContain('hidesAll');
    expect(changedHidden(state, [])).toStrictEqual(state.rows.map((r) => r.id));

    state = removeRow(state, state.rows[0]!.key);
    for (const row of state.rows) state = removeRow(state, row.key);
    expect(editorProblems(state, builtInName, nameOf).list).toStrictEqual(['empty']);
  });
});
