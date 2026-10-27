/**
 * IntakeOptionsScreen — the owner's lists the counter picks from at intake: condition checks,
 * accessories, photo angles, quick brands and ready-by choices. The owner edits each list for every
 * store (rename, reorder, add, remove); anyone allowed to at this store marks the items it doesn't
 * use. Each list is edited on its own screen and saved at once, so nothing half-done reaches the
 * counters, and leaving with unsaved changes asks first.
 */
import { t } from '@bolusi/i18n';
import {
  ConfirmSheet,
  ListRow,
  ReorderableList,
  SwitchRow,
  TextButton,
  TextInput,
  border,
  color,
  space,
  touch,
  type,
} from '@bolusi/ui';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useActionRunner, type DiscardGuard, type StepBack } from '../../screen-kit/index.js';

import { repairAbilities, type RepairAbilities } from '../flows.js';
import {
  INTAKE_OPTION_LISTS,
  READY_UNKNOWN,
  type IntakeOptionList,
  type IntakeOptionSettings,
} from '../intake-options.js';
import {
  addRow,
  changedHidden,
  changedItems,
  editorFor,
  editorProblems,
  hasProblems,
  moveRow,
  removeRow,
  updateRow,
  type BuiltInName,
  type EditorRow,
  type ListProblem,
  type RowProblem,
} from '../options-editor.js';

import { tn, type RepairKey } from '../i18n.js';
import { builtInLabel, optionLabel } from '../labels.js';
import { FlowScreen, QueryView, repairStyles, type RepairChrome } from './parts.js';
import { useIntakeOptionSettings, useRepairRuntime } from './runtime.js';

const LIST_KEY: Readonly<Record<IntakeOptionList, RepairKey>> = {
  checks: 'repair.options.list.checks',
  accessories: 'repair.options.list.accessories',
  photoAngles: 'repair.options.list.photoAngles',
  brands: 'repair.options.list.brands',
  readyBy: 'repair.options.list.readyBy',
};

const HINT_KEY: Readonly<Record<IntakeOptionList, RepairKey>> = {
  checks: 'repair.options.hint.checks',
  accessories: 'repair.options.hint.accessories',
  photoAngles: 'repair.options.hint.photoAngles',
  brands: 'repair.options.hint.brands',
  readyBy: 'repair.options.hint.readyBy',
};

const PROBLEM_KEY: Readonly<Record<RowProblem | ListProblem, RepairKey>> = {
  emptyLabel: 'repair.options.problem.emptyLabel',
  labelTooLong: 'repair.options.problem.labelTooLong',
  duplicate: 'repair.options.problem.duplicate',
  badReadyBy: 'repair.options.problem.badReadyBy',
  empty: 'repair.options.problem.empty',
  tooMany: 'repair.options.problem.tooMany',
  hidesAll: 'repair.options.problem.hidesAll',
};

export interface IntakeOptionsScreenProps {
  readonly chrome: RepairChrome;
  readonly onClose: () => void;
  readonly onRegisterDiscardGuard?: ((guard: DiscardGuard | null) => void) | undefined;
  /** Hardware back closes an open list first (through its discard confirm). */
  readonly onRegisterStepBack?: ((back: StepBack | null) => void) | undefined;
  readonly testID?: string | undefined;
}

export function IntakeOptionsScreen({
  chrome,
  onClose,
  onRegisterDiscardGuard,
  onRegisterStepBack,
  testID = 'repair.options',
}: IntakeOptionsScreenProps): React.JSX.Element {
  const runtime = useRepairRuntime();
  const can = useMemo(() => repairAbilities(runtime.hasPermission), [runtime]);
  const settings = useIntakeOptionSettings();
  const [open, setOpen] = useState<IntakeOptionList | null>(null);
  // The open list's own leave: its discard confirm when it has unsaved changes.
  const [listGuard, setListGuard] = useState<DiscardGuard | null>(null);
  const registerListGuard = useCallback(
    (guard: DiscardGuard | null) => setListGuard(() => guard),
    [],
  );

  useEffect(() => {
    onRegisterDiscardGuard?.(listGuard);
    return () => onRegisterDiscardGuard?.(null);
  }, [listGuard, onRegisterDiscardGuard]);

  useEffect(() => {
    onRegisterStepBack?.(() => {
      if (open === null) return false;
      if (listGuard === null) setOpen(null);
      else listGuard(() => setOpen(null));
      return true;
    });
    return () => onRegisterStepBack?.(null);
  });

  if (open !== null && settings.status === 'ready') {
    return (
      <ListEditor
        key={open}
        list={open}
        settings={settings.data}
        can={can}
        chrome={chrome}
        onDone={() => setOpen(null)}
        onRegisterGuard={registerListGuard}
        testID={`${testID}.list.${open}`}
      />
    );
  }

  return (
    <FlowScreen
      chrome={chrome}
      title={tn('repair.options.title')}
      onBack={onClose}
      busy={false}
      errorCode={null}
      onClearError={() => undefined}
      testID={testID}
    >
      <QueryView query={settings} onBack={onClose} onRetry={() => undefined} testID={testID}>
        {(data) => (
          <View>
            <Text style={repairStyles.muted}>
              {tn(can.manageIntakeOptions ? 'repair.options.intro' : 'repair.options.introStore')}
            </Text>
            <View style={styles.overview}>
              {INTAKE_OPTION_LISTS.map((list) => (
                <ListRow
                  key={list}
                  primaryText={tn(LIST_KEY[list])}
                  secondaryText={listSummary(data, list)}
                  showChevron
                  onPress={() => setOpen(list)}
                  testID={`${testID}.open.${list}`}
                />
              ))}
            </View>
          </View>
        )}
      </QueryView>
    </FlowScreen>
  );
}

/** "9 pilihan · 2 tidak dipakai di toko ini". */
function listSummary(settings: IntakeOptionSettings, list: IntakeOptionList): string {
  const ids = new Set(settings.lists[list].map((option) => option.id));
  const hidden = settings.hidden[list].filter((id) => ids.has(id)).length;
  const count = tn('repair.options.count', { count: ids.size });
  return hidden === 0 ? count : `${count} · ${tn('repair.options.hiddenCount', { count: hidden })}`;
}

function ListEditor({
  list,
  settings,
  can,
  chrome,
  onDone,
  onRegisterGuard,
  testID,
}: {
  readonly list: IntakeOptionList;
  readonly settings: IntakeOptionSettings;
  readonly can: RepairAbilities;
  readonly chrome: RepairChrome;
  readonly onDone: () => void;
  readonly onRegisterGuard: (guard: DiscardGuard | null) => void;
  readonly testID: string;
}): React.JSX.Element {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const builtInName: BuiltInName = (option) => builtInLabel(list, option.id);
  // Started from the lists as they were on opening; a change that syncs in meanwhile is compared
  // against on save, so saving never silently undoes it unless this list was edited too.
  const [state, setState] = useState(() => editorFor(list, settings, builtInName));
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showProblems, setShowProblems] = useState(false);
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);

  const manage = can.manageIntakeOptions;
  const hide = can.hideIntakeOptions;
  const items = manage ? changedItems(state, settings.lists[list], builtInName) : null;
  const hidden = hide ? changedHidden(state, settings.hidden[list]) : null;
  const dirty = items !== null || hidden !== null;
  const problems = editorProblems(state, builtInName, (option) => optionLabel(list, option));

  useEffect(() => {
    onRegisterGuard(dirty ? (proceed) => setPendingLeave(() => proceed) : null);
    return () => onRegisterGuard(null);
  }, [dirty, onRegisterGuard]);

  const leave = (): void => (dirty ? setPendingLeave(() => onDone) : onDone());

  const save = (): void => {
    if (hasProblems(problems)) {
      setShowProblems(true);
      const first = state.rows.find((row) => problems.rows.has(row.key));
      if (first !== undefined) setExpanded(first.key);
      return;
    }
    if (!dirty) {
      onDone();
      return;
    }
    void runner
      .run(async () => {
        // The list first: hiding then applies to the list as saved.
        if (items !== null) await runtime.run('changeIntakeOptions', { list, items });
        if (hidden !== null) await runtime.run('hideIntakeOptions', { list, hidden });
        return true;
      })
      .then((saved) => {
        if (saved === true) onDone();
      });
  };

  const add = (): void => {
    const added = addRow(state);
    setState(added.state);
    setExpanded(added.key);
  };
  const hasUnknown = state.rows.some((row) => row.id === READY_UNKNOWN);
  const reorderable = manage && list !== 'readyBy';

  return (
    <FlowScreen
      chrome={chrome}
      title={tn(LIST_KEY[list])}
      onBack={leave}
      primaryLabel={tn('repair.options.save')}
      onPrimary={save}
      busy={runner.busy}
      errorCode={runner.errorCode}
      onClearError={runner.clearError}
      overlay={
        pendingLeave === null ? null : (
          <ConfirmSheet
            title={tn('repair.options.discardTitle')}
            message={tn('repair.options.discardMessage')}
            confirmLabel={tn('repair.options.discard')}
            onConfirm={() => {
              const proceed = pendingLeave;
              setPendingLeave(null);
              proceed();
            }}
            cancelLabel={tn('repair.options.keepEditing')}
            onCancel={() => setPendingLeave(null)}
            testID={`${testID}.discard`}
          />
        )
      }
      testID={testID}
    >
      <Text style={repairStyles.muted}>{tn(HINT_KEY[list])}</Text>
      <View style={styles.rows} testID={`${testID}.rows`}>
        <ReorderableList
          items={state.rows}
          keyOf={(row) => row.key}
          onMove={(from, to) => setState((s) => moveRow(s, from, to))}
          handleLabel={tn('repair.options.dragHandle')}
          moveUpLabel={tn('repair.options.moveUp')}
          moveDownLabel={tn('repair.options.moveDown')}
          testID={`${testID}.order`}
          renderItem={(row, handle) => (
            <OptionRow
              list={list}
              row={row}
              expanded={manage && expanded === row.key}
              manage={manage}
              hide={hide}
              // An open row holds still while it is being edited, as on iOS.
              handle={reorderable && expanded !== row.key ? handle : null}
              problem={showProblems ? problems.rows.get(row.key) : undefined}
              onToggleExpanded={() => setExpanded((key) => (key === row.key ? null : row.key))}
              onChange={(patch) => setState((s) => updateRow(s, row.key, patch))}
              onRemove={() => {
                setState((s) => removeRow(s, row.key));
                setExpanded(null);
              }}
              testID={`${testID}.row.${row.key}`}
            />
          )}
        />
      </View>
      {manage ? (
        <View style={styles.adds}>
          <TextButton
            label={tn('repair.options.add')}
            icon="add"
            onPress={add}
            testID={`${testID}.add`}
          />
          {list === 'readyBy' && !hasUnknown ? (
            <TextButton
              label={tn('repair.options.addUnknown')}
              icon="add"
              onPress={() => {
                const added = addRow(state);
                setState(updateRow(added.state, added.key, { text: READY_UNKNOWN }));
              }}
              testID={`${testID}.addUnknown`}
            />
          ) : null}
        </View>
      ) : null}
      {showProblems
        ? problems.list.map((problem) => (
            <Text key={problem} style={styles.problem} testID={`${testID}.problem.${problem}`}>
              {tn(PROBLEM_KEY[problem])}
            </Text>
          ))
        : null}
    </FlowScreen>
  );
}

/**
 * One item: its name, and whether this store shows it. The owner taps it open to rename or remove
 * it and drags it by its handle to reorder; someone who may only choose for this store switches it
 * where it stands.
 */
function OptionRow({
  list,
  row,
  expanded,
  manage,
  hide,
  handle,
  problem,
  onToggleExpanded,
  onChange,
  onRemove,
  testID,
}: {
  readonly list: IntakeOptionList;
  readonly row: EditorRow;
  readonly expanded: boolean;
  readonly manage: boolean;
  readonly hide: boolean;
  readonly handle: ReactNode;
  readonly problem: RowProblem | undefined;
  readonly onToggleExpanded: () => void;
  readonly onChange: (patch: Partial<EditorRow>) => void;
  readonly onRemove: () => void;
  readonly testID: string;
}): React.JSX.Element {
  const newReady = list === 'readyBy' && row.id === null;
  // A ready-by choice is named by its days; one being added shows them as typed.
  const name =
    list === 'readyBy'
      ? newReady
        ? row.text === READY_UNKNOWN
          ? optionLabel('readyBy', { id: READY_UNKNOWN, label: null })
          : row.text.trim() === ''
            ? ''
            : optionLabel('readyBy', { id: row.text.trim(), label: null })
        : optionLabel('readyBy', { id: row.id!, label: null })
      : row.text;
  const editableName =
    manage && !(list === 'readyBy' && (row.id !== null || row.text === READY_UNKNOWN));
  const setShown = (shown: boolean): void => onChange({ hidden: !shown });

  if (expanded) {
    return (
      <View style={[styles.row, styles.expanded]} testID={testID}>
        {editableName ? (
          <TextInput
            label={tn(list === 'readyBy' ? 'repair.options.days' : 'repair.options.name')}
            value={row.text}
            onChangeText={(text) => onChange({ text })}
            keyboardType={list === 'readyBy' ? 'number-pad' : 'default'}
            errorMessage={problem === undefined ? undefined : tn(PROBLEM_KEY[problem])}
            autoFocus={row.id === null}
            testID={`${testID}.name`}
          />
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: true }}
            onPress={onToggleExpanded}
            style={styles.expandedTitle}
          >
            <Text style={styles.name}>{name}</Text>
          </Pressable>
        )}
        {hide ? (
          row.id === null ? (
            <Text style={[repairStyles.caption, styles.notSaved]}>
              {tn('repair.options.notSavedYet')}
            </Text>
          ) : (
            <View style={styles.useHere}>
              <SwitchRow
                label={tn('repair.options.showHere')}
                caption={tn('repair.options.showHereCaption')}
                value={!row.hidden}
                onValueChange={setShown}
                testID={`${testID}.shown`}
              />
            </View>
          )
        ) : null}
        <View style={styles.actions}>
          <TextButton
            label={tn('repair.options.done')}
            onPress={onToggleExpanded}
            testID={`${testID}.done`}
          />
          <TextButton
            label={tn('repair.options.remove')}
            icon="remove"
            tone="danger"
            onPress={onRemove}
            testID={`${testID}.remove`}
          />
        </View>
      </View>
    );
  }

  const caption =
    problem !== undefined ? (
      <Text style={styles.rowProblem}>{tn(PROBLEM_KEY[problem])}</Text>
    ) : row.hidden ? (
      <Text style={repairStyles.caption}>{tn('repair.options.hiddenHere')}</Text>
    ) : null;

  if (!manage) {
    // Only this store's choice to make: the switch is the row.
    return (
      <View style={[styles.row, styles.switchRow]} testID={testID}>
        {hide && row.id !== null ? (
          <SwitchRow
            label={name}
            caption={row.hidden ? tn('repair.options.hiddenHere') : undefined}
            value={!row.hidden}
            onValueChange={setShown}
            testID={`${testID}.shown`}
          />
        ) : (
          <Text style={styles.name}>{name}</Text>
        )}
      </View>
    );
  }

  return (
    <View style={[styles.row, styles.collapsed, handle === null ? null : styles.withHandle]}>
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityState={{ expanded: false }}
        accessibilityLabel={[name, row.hidden ? tn('repair.options.hiddenHere') : '']
          .filter((s) => s !== '')
          .join(', ')}
        accessibilityHint={t('core.action.edit')}
        onPress={onToggleExpanded}
        style={({ pressed }) => [styles.rowPress, pressed ? styles.pressed : null]}
      >
        <View style={styles.rowText}>
          <Text style={[styles.name, row.hidden ? styles.hiddenName : null]} numberOfLines={2}>
            {name === '' ? ' ' : name}
          </Text>
          {caption}
        </View>
        <Text style={styles.editLabel}>{t('core.action.edit')}</Text>
      </Pressable>
      {handle}
    </View>
  );
}

const styles = StyleSheet.create({
  overview: { marginTop: space.lg, marginHorizontal: -space.lg },
  rows: {
    marginTop: space.lg,
    // Rows run edge to edge so their dividers and pressed state span the screen, like the board.
    marginHorizontal: -space.lg,
    borderTopWidth: border.hairline,
    borderTopColor: color.border,
  },
  row: {
    paddingHorizontal: space.lg,
    borderBottomWidth: border.hairline,
    borderBottomColor: color.border,
    backgroundColor: color.surface,
  },
  collapsed: {
    minHeight: touch.rowMin,
    flexDirection: 'row',
    alignItems: 'center',
  },
  // The handle's own 48 dp box carries its padding, so the row gives it the right edge.
  withHandle: { paddingRight: space.xs },
  rowPress: {
    flex: 1,
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm,
  },
  pressed: { opacity: 0.6 },
  switchRow: { paddingVertical: 0 },
  expanded: { backgroundColor: color.surfaceAlt, paddingVertical: space.md },
  expandedTitle: { minHeight: touch.min, justifyContent: 'center' },
  rowText: { flex: 1 },
  name: { ...type.bodySm, color: color.text },
  hiddenName: { color: color.textMuted },
  rowProblem: { ...type.caption, color: color.danger, marginTop: space.xs },
  editLabel: { ...type.bodySm, fontWeight: '600', color: color.primary },
  useHere: { marginTop: space.sm },
  notSaved: { marginTop: space.md },
  actions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: space.sm,
    marginHorizontal: -space.sm,
  },
  adds: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: space.sm,
    marginHorizontal: -space.sm,
  },
  problem: { ...type.bodySm, color: color.danger, marginTop: space.sm },
});
