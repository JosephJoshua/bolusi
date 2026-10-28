// The owner's repair settings on the counter PC, each a page of the PC's Settings: one intake list
// ("Pilihan saat terima HP"), the cancellation fees, when an uncollected phone is flagged and what
// the slips print. They run the same
// commands and pure form logic as the phone screens; only the layout is the desktop's (inline rows
// to type in, drag to reorder, one save bar). Each page tells Settings whether it holds unsaved
// changes, so leaving it asks first.
import { t } from '@bolusi/i18n';
import type { MediaRefMime } from '@bolusi/schemas';
import {
  Banner,
  Button,
  Card,
  Chip,
  ConfirmDialog,
  IconButton,
  Section,
  SettingsPanel,
  SortableList,
  Switch,
  TextArea,
  TextField,
  Tooltip,
} from '@bolusi/ui-web';
import { CircleCheck, ImagePlus, Plus, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { useActionRunner } from '../../screen-kit/index.js';
import { parseUncollectedDays } from '../constants.js';
import { repairAbilities, type RepairAbilities } from '../flows.js';
import { rebaseForm } from '../form-rebase.js';
import { tn, type RepairKey } from '../i18n.js';
import {
  READY_UNKNOWN,
  type IntakeOptionList,
  type IntakeOptionSettings,
} from '../intake-options.js';
import { builtInLabel, optionLabel } from '../labels.js';
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
  type EditorState,
  type ListProblem,
  type RowProblem,
} from '../options-editor.js';
import {
  printSettingsForm,
  printSettingsInput,
  samePrintSettingsField,
  samePrintSettingsForm,
  type PrintSettingsForm,
} from '../print-settings-form.js';
import type { CancelFees, PrintSettings } from '../queries.js';
import {
  useCancelFees,
  useIntakeOptionSettings,
  usePrintSettings,
  usePrintStoreName,
  useRepairRuntime,
  useRepairThumbnail,
  useUncollectedLimit,
} from '../runtime.js';
import { ActionError, MoneyField, QueryPanel } from './parts.js';

/** What every settings page takes from Settings. */
export interface RepairSettingsProps {
  /** Says whether the page holds unsaved changes, so Settings asks before leaving it. */
  readonly onDirtyChange?: ((dirty: boolean) => void) | undefined;
}

export const INTAKE_LIST_KEY: Readonly<Record<IntakeOptionList, RepairKey>> = {
  checks: 'repair.options.list.checks',
  accessories: 'repair.options.list.accessories',
  photoAngles: 'repair.options.list.photoAngles',
  brands: 'repair.options.list.brands',
  readyBy: 'repair.options.list.readyBy',
  repairTypes: 'repair.options.list.repairTypes',
};

const HINT_KEY: Readonly<Record<IntakeOptionList, RepairKey>> = {
  checks: 'repair.options.hint.checks',
  accessories: 'repair.options.hint.accessories',
  photoAngles: 'repair.options.hint.photoAngles',
  brands: 'repair.options.hint.brands',
  readyBy: 'repair.options.hint.readyBy',
  repairTypes: 'repair.options.hint.repairTypes',
};

const PROBLEM_KEY: Readonly<Record<RowProblem | ListProblem, RepairKey>> = {
  emptyLabel: 'repair.options.problem.emptyLabel',
  labelTooLong: 'repair.options.problem.labelTooLong',
  duplicate: 'repair.options.problem.duplicate',
  badReadyBy: 'repair.options.problem.badReadyBy',
  badWarranty: 'repair.options.problem.badWarranty',
  empty: 'repair.options.problem.empty',
  tooMany: 'repair.options.problem.tooMany',
  hidesAll: 'repair.options.problem.hidesAll',
};

/** Which repair settings pages this person may open here; the core still decides each save. */
export function repairSettingsAccess(abilities: RepairAbilities): {
  readonly intakeOptions: boolean;
  readonly cancelFees: boolean;
  readonly uncollected: boolean;
  readonly printSettings: boolean;
} {
  return {
    intakeOptions: abilities.manageIntakeOptions || abilities.hideIntakeOptions,
    cancelFees: abilities.setCancelFees,
    uncollected: abilities.setUncollectedDays,
    printSettings: abilities.setPrintSettings,
  };
}

/** Reports `dirty` to Settings as it changes, and clean again when the page goes. */
function useReportDirty(dirty: boolean, onDirtyChange: RepairSettingsProps['onDirtyChange']): void {
  const report = useRef(onDirtyChange);
  report.current = onDirtyChange;
  useEffect(() => {
    report.current?.(dirty);
  }, [dirty]);
  useEffect(() => () => report.current?.(false), []);
}

/**
 * Runs `onChange` when the live read brings new saved settings (another device's save, or this
 * page's own coming back), so an open form follows them: see `rebaseForm`.
 */
function useFollowSaved<T>(saved: T, onChange: (next: T) => void): void {
  const seen = useRef(saved);
  const latest = useRef(onChange);
  latest.current = onChange;
  useEffect(() => {
    if (seen.current === saved) return;
    seen.current = saved;
    latest.current(saved);
  }, [saved]);
}

/**
 * The bar at the bottom of a settings form: what the last save did, a way to drop the changes and
 * the save itself (Ctrl+S as well), which waits until something changed.
 */
export function SaveBar({
  dirty,
  busy,
  saved,
  onSave,
  onDiscard,
  saveLabel,
  testId,
}: {
  readonly dirty: boolean;
  readonly busy: boolean;
  /** The last save's confirmation, until the next edit. */
  readonly saved: string | null;
  readonly onSave: () => void;
  readonly onDiscard: () => void;
  readonly saveLabel: string;
  readonly testId: string;
}): React.JSX.Element {
  const save = useRef(onSave);
  save.current = onSave;
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's') {
        event.preventDefault();
        // Not from behind a dialog (the discard question, a picker): only the page in front saves.
        if (document.querySelector('[role="dialog"], [role="alertdialog"]') !== null) return;
        save.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <>
      {saved === null || dirty ? null : (
        <p
          role="status"
          className="mr-auto flex items-center gap-2 text-body text-on-success-bg"
          data-testid={`${testId}.saved`}
        >
          <CircleCheck size={18} aria-hidden className="shrink-0 text-success" />
          {saved}
        </p>
      )}
      {dirty ? (
        <Button
          label={tn('repair.desk.settings.discard')}
          variant="text"
          onClick={onDiscard}
          disabled={busy}
          data-testid={`${testId}.discard`}
        />
      ) : null}
      <Button
        label={saveLabel}
        variant="primary"
        shortcut="Ctrl+S"
        onClick={onSave}
        busy={busy}
        disabled={!dirty}
        data-testid={`${testId}.save`}
      />
    </>
  );
}

// ── Pilihan saat terima HP: one list ───────────────────────────────────────────────────────────

export function IntakeListSettings({
  list,
  onDirtyChange,
}: RepairSettingsProps & { readonly list: IntakeOptionList }): React.JSX.Element {
  const runtime = useRepairRuntime();
  const can = useMemo(() => repairAbilities(runtime.hasPermission), [runtime]);
  const [reload, setReload] = useState(0);
  const settings = useIntakeOptionSettings(reload);
  const testId = `repair.desk.options.${list}`;
  return (
    <SettingsPanel
      title={tn(INTAKE_LIST_KEY[list])}
      lead={`${tn(HINT_KEY[list])} ${tn(
        can.manageIntakeOptions ? 'repair.options.intro' : 'repair.options.introStore',
      )}`}
      testId={testId}
    >
      <QueryPanel query={settings} onRetry={() => setReload((n) => n + 1)}>
        {(data) => (
          <ListEditor
            key={list}
            list={list}
            settings={data}
            can={can}
            onDirtyChange={onDirtyChange}
            testId={testId}
          />
        )}
      </QueryPanel>
    </SettingsPanel>
  );
}

function ListEditor({
  list,
  settings,
  can,
  onDirtyChange,
  testId,
}: {
  readonly list: IntakeOptionList;
  /** The lists as they are now, kept live: a change from another device shows if nothing is typed. */
  readonly settings: IntakeOptionSettings;
  readonly can: RepairAbilities;
  readonly onDirtyChange: RepairSettingsProps['onDirtyChange'];
  readonly testId: string;
}): React.JSX.Element {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const builtInName: BuiltInName = (option) => builtInLabel(list, option.id);
  const [state, setState] = useState<EditorState>(() => editorFor(list, settings, builtInName));
  const [showProblems, setShowProblems] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);

  const manage = can.manageIntakeOptions;
  const hide = can.hideIntakeOptions;
  const changes = (against: IntakeOptionSettings, rows: EditorState) => ({
    items: manage ? changedItems(rows, against.lists[list], builtInName) : null,
    hidden: hide ? changedHidden(rows, against.hidden[list]) : null,
  });
  // What the rows are compared with: the latest of the live read and this page's own last save, so
  // a save shows as saved before its change has come back through the live query.
  const [base, setBase] = useState(settings);
  const { items, hidden } = changes(base, state);
  const dirty = items !== null || hidden !== null;
  const problems = editorProblems(state, builtInName, (option) => optionLabel(list, option));
  useReportDirty(dirty, onDirtyChange);

  // Untouched rows follow a change that syncs in; typed ones stay and are compared on save.
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

  const edit = (next: (current: EditorState) => EditorState): void => {
    setSaved(null);
    setState(next);
  };

  const save = (): void => {
    if (!dirty || runner.busy) return;
    if (hasProblems(problems)) {
      setShowProblems(true);
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
          // The list did save, and its new rows now have ids: show it as saved, so saving again
          // never adds them twice. What was to be hidden is chosen again.
          if (items !== null) {
            const fresh = await read();
            setBase(fresh);
            setState(editorFor(list, fresh, builtInName));
          }
          throw error;
        }
        return read();
      })
      .then((fresh) => {
        if (fresh === undefined) return;
        // New rows now have ids: start again from what was saved.
        setBase(fresh);
        setState(editorFor(list, fresh, builtInName));
        setShowProblems(false);
        setSaved(tn('repair.options.saved'));
      });
  };

  const add = (text = ''): void => {
    const added = addRow(state);
    edit(() => updateRow(added.state, added.key, { text }));
    if (text === '') setFocusKey(added.key);
  };

  const hasUnknown = state.rows.some((row) => row.id === READY_UNKNOWN);
  const reorderable = manage && list !== 'readyBy';
  const listProblems = showProblems ? problems.list : [];

  return (
    <div className="flex flex-1 flex-col gap-4">
      <div className="rounded-md border border-border bg-surface" data-testid={`${testId}.rows`}>
        <div
          className="flex items-center gap-3 border-b border-border px-3 py-2 text-small font-semibold text-text-muted"
          aria-hidden
        >
          {reorderable ? <span className="w-8 shrink-0" /> : null}
          <span className="min-w-0 flex-1">
            {tn(list === 'readyBy' ? 'repair.options.days' : 'repair.options.name')}
          </span>
          {list === 'repairTypes' ? (
            <>
              <span className="w-28 shrink-0">{tn('repair.options.warrantyDays')}</span>
              <span className="w-24 shrink-0">{tn('repair.options.videoShort')}</span>
            </>
          ) : null}
          {hide ? <span className="shrink-0">{tn('repair.options.showHere')}</span> : null}
          {manage ? <span className="w-8 shrink-0" /> : null}
        </div>
        <SortableList
          items={state.rows}
          keyOf={(row) => row.key}
          onMove={(from, to) => edit((s) => moveRow(s, from, to))}
          handleLabel={reorderable ? tn('repair.desk.options.dragHandle') : null}
          label={tn(INTAKE_LIST_KEY[list])}
          testId={`${testId}.order`}
          renderItem={(row, handle) => (
            <OptionRow
              list={list}
              row={row}
              manage={manage}
              hide={hide}
              handle={handle}
              focus={focusKey === row.key}
              problem={showProblems ? problems.rows.get(row.key) : undefined}
              onChange={(patch) => edit((s) => updateRow(s, row.key, patch))}
              onRemove={() => edit((s) => removeRow(s, row.key))}
              testId={`${testId}.row.${row.key}`}
            />
          )}
        />
      </div>
      {manage ? (
        <div className="-ml-2 flex flex-wrap gap-2">
          <Button
            label={tn('repair.options.add')}
            icon={Plus}
            variant="text"
            onClick={() => add()}
            data-testid={`${testId}.add`}
          />
          {list === 'readyBy' && !hasUnknown ? (
            <Button
              label={tn('repair.options.addUnknown')}
              icon={Plus}
              variant="text"
              onClick={() => add(READY_UNKNOWN)}
              data-testid={`${testId}.addUnknown`}
            />
          ) : null}
        </div>
      ) : null}
      {listProblems.map((problem) => (
        <Banner key={problem} tone="danger" message={tn(PROBLEM_KEY[problem])} />
      ))}
      <ActionError errorCode={runner.errorCode} onDismiss={runner.clearError} />
      <FormFooter>
        <SaveBar
          dirty={dirty}
          busy={runner.busy}
          saved={saved}
          onSave={save}
          onDiscard={() => {
            setShowProblems(false);
            setState(editorFor(list, base, builtInName));
          }}
          saveLabel={tn('repair.options.save')}
          testId={testId}
        />
      </FormFooter>
    </div>
  );
}

/**
 * One item, typed in place: its name (or a new ready-by row's days), whether this store shows it,
 * and removing it from every store. Someone who may only choose for this store sees the switch.
 */
function OptionRow({
  list,
  row,
  manage,
  hide,
  handle,
  focus,
  problem,
  onChange,
  onRemove,
  testId,
}: {
  readonly list: IntakeOptionList;
  readonly row: EditorRow;
  readonly manage: boolean;
  readonly hide: boolean;
  readonly handle: ReactNode;
  /** A row just added: the cursor goes to it, as the owner asked to type. */
  readonly focus: boolean;
  readonly problem: RowProblem | undefined;
  readonly onChange: (patch: Partial<EditorRow>) => void;
  readonly onRemove: () => void;
  readonly testId: string;
}): React.JSX.Element {
  // A ready-by choice is named by its days; only a new one (not "Belum tahu") is typed.
  const typed = manage && !(list === 'readyBy' && (row.id !== null || row.text === READY_UNKNOWN));
  const name =
    list === 'readyBy'
      ? optionLabel('readyBy', { id: row.id ?? row.text.trim(), label: null })
      : row.text;
  const problemText = problem === undefined ? undefined : tn(PROBLEM_KEY[problem]);
  return (
    <div
      className="flex items-start gap-3 border-b border-border px-3 py-2 last:border-b-0"
      data-testid={testId}
    >
      {handle === null ? null : <div className="pt-1">{handle}</div>}
      <div className="min-w-0 flex-1">
        {typed ? (
          <TextField
            label={tn(list === 'readyBy' ? 'repair.options.days' : 'repair.options.name')}
            // The column header names the field; the label stays for screen readers.
            className="[&>div:first-child]:sr-only"
            value={row.text}
            onChange={(event) => onChange({ text: event.target.value })}
            inputMode={list === 'readyBy' ? 'numeric' : undefined}
            maxLength={list === 'readyBy' ? 2 : 60}
            error={problemText}
            autoFocus={focus}
            data-testid={`${testId}.name`}
          />
        ) : (
          <div className="flex min-h-10 flex-col justify-center">
            <p className={row.hidden ? 'text-body text-text-muted' : 'text-body text-text'}>
              {name}
            </p>
            {problemText === undefined ? null : (
              <p role="alert" className="text-small text-danger">
                {problemText}
              </p>
            )}
          </div>
        )}
      </div>
      {list === 'repairTypes' ? (
        // Each type's terms: the warranty from pickup, and whether intake needs the ownership video.
        <>
          <div className="w-28 shrink-0">
            {manage ? (
              <TextField
                label={`${tn('repair.options.warrantyDays')}: ${name}`}
                className="[&>div:first-child]:sr-only"
                value={row.warranty}
                onChange={(event) => onChange({ warranty: event.target.value.replace(/\D/g, '') })}
                inputMode="numeric"
                maxLength={3}
                data-testid={`${testId}.warranty`}
              />
            ) : (
              <p className="flex min-h-10 items-center text-body text-text">
                {row.warranty === '' || row.warranty === '0'
                  ? tn('repair.options.noWarranty')
                  : tn('repair.options.warranty', { count: Number(row.warranty) })}
              </p>
            )}
          </div>
          <div className="flex h-10 w-24 shrink-0 items-center">
            <SwitchOnly
              label={`${tn('repair.options.needsVideo')}: ${name}`}
              checked={row.needsVideo}
              onChange={(needsVideo) => onChange({ needsVideo })}
              disabled={!manage}
              testId={`${testId}.needsVideo`}
            />
          </div>
        </>
      ) : null}
      {hide ? (
        <div className="flex h-10 shrink-0 items-center">
          {row.id === null ? (
            <Tooltip label={tn('repair.options.notSavedYet')}>
              <span tabIndex={0} className="rounded-xs" data-testid={`${testId}.new`}>
                <Chip label={tn('repair.desk.options.new')} icon={Sparkles} tone="info" />
              </span>
            </Tooltip>
          ) : (
            <SwitchOnly
              label={`${tn('repair.options.showHere')}: ${name}`}
              checked={!row.hidden}
              onChange={(shown) => onChange({ hidden: !shown })}
              testId={`${testId}.shown`}
            />
          )}
        </div>
      ) : null}
      {manage ? (
        <div className="flex h-10 shrink-0 items-center">
          <IconButton
            icon={Trash2}
            label={tn('repair.options.remove')}
            onClick={onRemove}
            size="sm"
            data-testid={`${testId}.remove`}
          />
        </div>
      ) : null}
    </div>
  );
}

/** A switch in a table cell, named for screen readers by its row. */
function SwitchOnly({
  label,
  checked,
  onChange,
  disabled = false,
  testId,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly disabled?: boolean;
  readonly testId: string;
}): React.JSX.Element {
  return (
    <Switch
      label={label}
      checked={checked}
      onChange={onChange}
      disabled={disabled}
      className="[&>label]:sr-only"
      testId={testId}
    />
  );
}

/** The save bar, pinned to the bottom of the settings view while the form scrolls. */
export function FormFooter({ children }: { readonly children: ReactNode }): React.JSX.Element {
  return (
    <div className="sticky bottom-0 z-10 -mx-6 -mb-6 mt-auto flex flex-wrap items-center justify-end gap-3 border-t border-border bg-surface px-6 py-3">
      {children}
    </div>
  );
}

// ── Biaya pembatalan ───────────────────────────────────────────────────────────────────────────

export function CancelFeesSettings({ onDirtyChange }: RepairSettingsProps): React.JSX.Element {
  const [reload, setReload] = useState(0);
  const fees = useCancelFees(reload);
  return (
    <SettingsPanel
      title={tn('repair.fees.title')}
      lead={tn('repair.fees.intro')}
      testId="repair.desk.fees"
    >
      <QueryPanel query={fees} onRetry={() => setReload((n) => n + 1)}>
        {(saved) => <FeesForm saved={saved} onDirtyChange={onDirtyChange} />}
      </QueryPanel>
    </SettingsPanel>
  );
}

function FeesForm({
  saved,
  onDirtyChange,
}: {
  readonly saved: CancelFees;
  readonly onDirtyChange: RepairSettingsProps['onDirtyChange'];
}): React.JSX.Element {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const [baseline, setBaseline] = useState(saved);
  const [fees, setFees] = useState<{ beforeWork: number | null; afterWork: number | null }>(saved);
  const [attempted, setAttempted] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const dirty = fees.beforeWork !== baseline.beforeWork || fees.afterWork !== baseline.afterWork;
  useReportDirty(dirty, onDirtyChange);
  useFollowSaved(saved, (next) => {
    setFees((current) => rebaseForm(current, baseline, next));
    setBaseline(next);
  });
  const testId = 'repair.desk.fees';

  const save = (): void => {
    if (!dirty || runner.busy) return;
    const { beforeWork, afterWork } = fees;
    if (beforeWork === null || afterWork === null) {
      setAttempted(true);
      return;
    }
    void runner
      .run(() => runtime.run('setCancelFees', { beforeWork, afterWork }))
      .then((result) => {
        if (result === undefined) return;
        setBaseline(result);
        setFees(result);
        setAttempted(false);
        setNotice(tn('repair.fees.saved'));
      });
  };

  const field = (key: 'beforeWork' | 'afterWork', label: RepairKey): React.JSX.Element => (
    <MoneyField
      label={tn(label)}
      value={fees[key]}
      onChange={(value) => {
        setNotice(null);
        setFees((current) => ({ ...current, [key]: value }));
      }}
      error={attempted && fees[key] === null ? tn('repair.fees.hint') : undefined}
      data-testid={`${testId}.${key}`}
    />
  );

  return (
    <div className="flex flex-1 flex-col gap-4">
      <Card>
        <div className="grid max-w-xl grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4">
          {field('beforeWork', 'repair.fees.beforeWork')}
          {field('afterWork', 'repair.fees.afterWork')}
        </div>
      </Card>
      <ActionError errorCode={runner.errorCode} onDismiss={runner.clearError} />
      <FormFooter>
        <SaveBar
          dirty={dirty}
          busy={runner.busy}
          saved={notice}
          onSave={save}
          onDiscard={() => {
            setAttempted(false);
            setFees(baseline);
          }}
          saveLabel={tn('repair.fees.save')}
          testId={testId}
        />
      </FormFooter>
    </div>
  );
}

// ── HP belum diambil ───────────────────────────────────────────────────────────────────────────

export function UncollectedSettings({ onDirtyChange }: RepairSettingsProps): React.JSX.Element {
  const [reload, setReload] = useState(0);
  const limit = useUncollectedLimit(reload);
  return (
    <SettingsPanel
      title={tn('repair.uncollected.title')}
      lead={tn('repair.uncollected.intro')}
      testId="repair.desk.uncollected"
    >
      <QueryPanel query={limit} onRetry={() => setReload((n) => n + 1)}>
        {(saved) => <UncollectedForm saved={saved.days} onDirtyChange={onDirtyChange} />}
      </QueryPanel>
    </SettingsPanel>
  );
}

function UncollectedForm({
  saved,
  onDirtyChange,
}: {
  readonly saved: number;
  readonly onDirtyChange: RepairSettingsProps['onDirtyChange'];
}): React.JSX.Element {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const [baseline, setBaseline] = useState(saved);
  const [text, setText] = useState(String(saved));
  const [attempted, setAttempted] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const days = parseUncollectedDays(text);
  const dirty = text !== String(baseline);
  useReportDirty(dirty, onDirtyChange);
  useFollowSaved(saved, (next) => {
    if (!dirty) setText(String(next));
    setBaseline(next);
  });
  const testId = 'repair.desk.uncollected';

  const save = (): void => {
    if (!dirty || runner.busy) return;
    if (days === null) {
      setAttempted(true);
      return;
    }
    void runner
      .run(() => runtime.run('setUncollectedDays', { days }))
      .then((result) => {
        if (result === undefined) return;
        setBaseline(result.days);
        setText(String(result.days));
        setAttempted(false);
        setNotice(tn('repair.uncollected.saved'));
      });
  };

  return (
    <div className="flex flex-1 flex-col gap-4">
      <Card>
        <div className="max-w-xs">
          <TextField
            label={tn('repair.uncollected.days')}
            hint={tn('repair.uncollected.hint')}
            value={text}
            onChange={(event) => {
              setNotice(null);
              setText(event.target.value.replace(/\D/g, '').slice(0, 3));
            }}
            inputMode="numeric"
            error={attempted && days === null ? tn('repair.uncollected.hint') : undefined}
            data-testid={`${testId}.days`}
          />
        </div>
      </Card>
      <ActionError errorCode={runner.errorCode} onDismiss={runner.clearError} />
      <FormFooter>
        <SaveBar
          dirty={dirty}
          busy={runner.busy}
          saved={notice}
          onSave={save}
          onDiscard={() => {
            setAttempted(false);
            setText(String(baseline));
          }}
          saveLabel={tn('repair.uncollected.save')}
          testId={testId}
        />
      </FormFooter>
    </div>
  );
}

// ── Tampilan nota ──────────────────────────────────────────────────────────────────────────────

export function SlipSettings({ onDirtyChange }: RepairSettingsProps): React.JSX.Element {
  const [reload, setReload] = useState(0);
  const settings = usePrintSettings(reload);
  return (
    <SettingsPanel
      title={tn('repair.printSettings.title')}
      lead={tn('repair.desk.settings.slipLead')}
      testId="repair.desk.slip"
    >
      <QueryPanel query={settings} onRetry={() => setReload((n) => n + 1)}>
        {(saved) => <SlipForm saved={saved} onDirtyChange={onDirtyChange} />}
      </QueryPanel>
    </SettingsPanel>
  );
}

function SlipForm({
  saved,
  onDirtyChange,
}: {
  readonly saved: PrintSettings;
  readonly onDirtyChange: RepairSettingsProps['onDirtyChange'];
}): React.JSX.Element {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const [baseline, setBaseline] = useState<PrintSettingsForm>(() => printSettingsForm(saved));
  const [form, setForm] = useState<PrintSettingsForm>(baseline);
  const [notice, setNotice] = useState<string | null>(null);
  const dirty = !samePrintSettingsForm(form, baseline);
  useReportDirty(dirty, onDirtyChange);
  useFollowSaved(saved, (next) => {
    const nextForm = printSettingsForm(next);
    setForm((current) => rebaseForm(current, baseline, nextForm, samePrintSettingsField));
    setBaseline(nextForm);
  });
  const storeName = usePrintStoreName();
  const testId = 'repair.desk.slip';

  const edit = (patch: Partial<PrintSettingsForm>): void => {
    setNotice(null);
    setForm((current) => ({ ...current, ...patch }));
  };

  const pickLogo = (): void => {
    const pick = runtime.pickPhoto;
    if (pick === undefined) return;
    void runner
      .run(() => pick({ title: tn('repair.printSettings.logoTitle') }))
      .then((picked) => {
        if (picked !== undefined && picked !== null) edit({ logo: picked.mediaRef });
      });
  };

  const save = (): void => {
    if (!dirty || runner.busy) return;
    void runner
      .run(() => runtime.run('setPrintSettings', printSettingsInput(form)))
      .then((result) => {
        if (result === undefined) return;
        setBaseline(form);
        setNotice(tn('repair.printSettings.saved'));
      });
  };

  return (
    <div className="flex flex-1 flex-col gap-6">
      <Card>
        <Section title={tn('repair.printSettings.header')} testId={`${testId}.header`}>
          {runtime.pickPhoto === undefined && form.logo === null ? null : (
            <div className="flex flex-col gap-3">
              <LogoRow
                logo={form.logo}
                canPick={runtime.pickPhoto !== undefined}
                disabled={runner.busy}
                onPick={pickLogo}
                onRemove={() => edit({ logo: null, logoOnDotMatrix: false })}
                testId={`${testId}.logo`}
              />
              {form.logo === null ? null : (
                <Switch
                  label={tn('repair.printSettings.logoOnDotMatrix')}
                  caption={tn('repair.printSettings.logoOnDotMatrixHint')}
                  checked={form.logoOnDotMatrix}
                  onChange={(logoOnDotMatrix) => edit({ logoOnDotMatrix })}
                  className="max-w-xl"
                  testId={`${testId}.logoOnDotMatrix`}
                />
              )}
            </div>
          )}
          <div className="grid max-w-xl gap-4">
            <TextField
              label={tn('repair.printSettings.name')}
              hint={
                storeName === ''
                  ? undefined
                  : tn('repair.printSettings.nameHint', { name: storeName })
              }
              value={form.name}
              onChange={(event) => edit({ name: event.target.value })}
              maxLength={100}
              spellCheck={false}
              data-testid={`${testId}.name`}
            />
            <TextArea
              label={tn('repair.printSettings.address')}
              value={form.address}
              onChange={(event) => edit({ address: event.target.value })}
              maxLength={300}
              rows={2}
              data-testid={`${testId}.address`}
            />
            <TextField
              label={tn('repair.printSettings.phone')}
              value={form.phone}
              onChange={(event) => edit({ phone: event.target.value })}
              maxLength={100}
              inputMode="tel"
              data-testid={`${testId}.phone`}
            />
          </div>
        </Section>
      </Card>
      <Card>
        <Section title={tn('repair.printSettings.terms')} testId={`${testId}.terms`}>
          <p className="-mt-2 text-small text-text-muted">{tn('repair.printSettings.termsHint')}</p>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-4">
            <TextArea
              label={tn('repair.printSettings.intakeTerms')}
              value={form.intakeTerms}
              onChange={(event) => edit({ intakeTerms: event.target.value })}
              maxLength={2000}
              rows={7}
              data-testid={`${testId}.intakeTerms`}
            />
            <TextArea
              label={tn('repair.printSettings.handoverTerms')}
              value={form.handoverTerms}
              onChange={(event) => edit({ handoverTerms: event.target.value })}
              maxLength={2000}
              rows={7}
              data-testid={`${testId}.handoverTerms`}
            />
          </div>
        </Section>
      </Card>
      <ActionError errorCode={runner.errorCode} onDismiss={runner.clearError} />
      <FormFooter>
        <SaveBar
          dirty={dirty}
          busy={runner.busy}
          saved={notice}
          onSave={save}
          onDiscard={() => setForm(baseline)}
          saveLabel={tn('repair.printSettings.save')}
          testId={testId}
        />
      </FormFooter>
    </div>
  );
}

function LogoRow({
  logo,
  canPick,
  disabled,
  onPick,
  onRemove,
  testId,
}: {
  readonly logo: PrintSettingsForm['logo'];
  readonly canPick: boolean;
  readonly disabled: boolean;
  readonly onPick: () => void;
  readonly onRemove: () => void;
  readonly testId: string;
}): React.JSX.Element {
  const thumbnail = useRepairThumbnail(
    logo === null ? null : { kind: 'signed', ...logo, mime: logo.mime as MediaRefMime },
  );
  return (
    <div className="flex flex-wrap items-center gap-4" data-testid={testId}>
      <div className="flex h-[72px] w-[120px] shrink-0 items-center justify-center rounded-sm bg-surface-alt p-2">
        {thumbnail.kind === 'ready' && logo !== null ? (
          <img
            src={thumbnail.uri}
            alt={tn('repair.printSettings.logoTitle')}
            className="size-full object-contain"
            data-testid={`${testId}.image`}
          />
        ) : (
          <span className="text-small text-text-muted">{tn('repair.printSettings.logo')}</span>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {canPick ? (
          <Button
            label={tn(
              logo === null ? 'repair.printSettings.pickLogo' : 'repair.printSettings.changeLogo',
            )}
            icon={logo === null ? ImagePlus : undefined}
            onClick={onPick}
            disabled={disabled}
            data-testid={`${testId}.pick`}
          />
        ) : null}
        {logo === null ? null : (
          <Button
            label={tn('repair.printSettings.removeLogo')}
            variant="dangerText"
            onClick={onRemove}
            disabled={disabled}
            data-testid={`${testId}.remove`}
          />
        )}
      </div>
    </div>
  );
}

/** Asks before Settings drops a page's unsaved changes. */
export function DiscardChangesDialog({
  open,
  onDiscard,
  onKeep,
}: {
  readonly open: boolean;
  readonly onDiscard: () => void;
  readonly onKeep: () => void;
}): React.JSX.Element {
  return (
    <ConfirmDialog
      open={open}
      title={tn('repair.options.discardTitle')}
      message={tn('repair.options.discardMessage')}
      confirmLabel={tn('repair.options.discard')}
      cancelLabel={tn('repair.options.keepEditing')}
      closeLabel={t('core.action.close')}
      destructive
      onConfirm={onDiscard}
      onCancel={onKeep}
      testId="desktop.settings.discard"
    />
  );
}
