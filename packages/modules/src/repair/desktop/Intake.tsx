// The counter's intake on one page: customer, device, condition, photos and price as sections the
// keyboard can Tab straight through, with a summary beside them that says what is still missing and
// holds the one action that opens the ticket (Ctrl+Enter). The draft is the phone's (flows.ts): the
// same checks, the same `openTicket` input, kept across an idle lock and released only on save or
// discard.
import { formatMoney, formatPhone, t } from '@bolusi/i18n';
import {
  Button,
  CaptureTile,
  ConfirmDialog,
  IconButton,
  PageHeader,
  SecretField,
  Skeleton,
  Segmented,
  TextArea,
  TextField,
  ToggleChip,
  controlClass,
} from '@bolusi/ui-web';
import { ArrowLeft, Check, Plus, Trash2, UserRound, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { useActionRunner } from '../../screen-kit/index.js';
import { CHECKLIST_STATES, type ChecklistState } from '../constants.js';
import {
  capturedThumbnailRef,
  chosenReady,
  emptyIntakeDraft,
  intakeDirty,
  intakeTotal,
  priceKinds,
  restOfChecksOk,
  stepProblems,
  toOpenTicketInput,
  acceptsRupiahText,
  parseRupiah,
  type IntakeDraft,
  type IntakeProblem,
  type IntakeStep,
  type PriceKind,
  type QuoteLineDraft,
} from '../flows.js';
import {
  DEFAULT_INTAKE_OPTIONS,
  storeIntakeOptions,
  type IntakeOption,
  type IntakeOptionLists,
} from '../intake-options.js';
import { REPAIR_PERMISSION } from '../constants.js';
import { tn, type RepairKey } from '../i18n.js';
import {
  CHECK_STATE_KEY,
  INTAKE_STEP_KEY,
  PRICE_KIND_KEY,
  optionLabel,
  readyLabel,
} from '../labels.js';
import { useIntakeOptionSettings, useRepairQuery, useRepairRuntime } from '../runtime.js';
import type { MediaRef } from '@bolusi/schemas';

import { ActionError, photoLabels, rupiahText, usePhotoState } from './parts.js';

/** The sections in page order; the phone's review step is the summary column here. */
const SECTIONS = [
  'customer',
  'device',
  'condition',
  'photos',
  'price',
] as const satisfies readonly IntakeStep[];
type Section = (typeof SECTIONS)[number];

const PROBLEM_KEY: Readonly<Record<IntakeProblem, RepairKey>> = {
  customerName: 'repair.problem.customerName',
  deviceBrand: 'repair.problem.deviceBrand',
  deviceModel: 'repair.problem.deviceModel',
  complaint: 'repair.problem.complaint',
  photos: 'repair.problem.photos',
  quoteLines: 'repair.problem.quoteLines',
  incompleteLine: 'repair.problem.incompleteLine',
  negativeTotal: 'repair.problem.negativeTotal',
};

/** Where the cursor goes for each problem, so "what is missing" is one keystroke from fixed. */
const PROBLEM_FIELD: Readonly<Record<IntakeProblem, string>> = {
  customerName: 'repair.desk.intake.name',
  deviceBrand: 'repair.desk.intake.brand',
  deviceModel: 'repair.desk.intake.model',
  complaint: 'repair.desk.intake.complaint',
  photos: 'repair.desk.intake.photos',
  quoteLines: 'repair.desk.intake.line.0.description',
  incompleteLine: 'repair.desk.intake.lines',
  negativeTotal: 'repair.desk.intake.lines',
};

const CHECK_TONE: Readonly<Record<ChecklistState, 'success' | 'danger' | 'neutral'>> = {
  ok: 'success',
  issue: 'danger',
  not_checked: 'neutral',
};

export interface IntakePageProps {
  /** Read when the ticket is opened, so a page left open for hours still dates it correctly. */
  readonly now: () => number;
  readonly restoredDraft?: IntakeDraft | null | undefined;
  readonly onDraftChange?: ((draft: IntakeDraft | null) => void) | undefined;
  readonly onOpened: (ticketId: string) => void;
  readonly onCancel: () => void;
}

export function IntakePage({
  now,
  restoredDraft,
  onDraftChange,
  onOpened,
  onCancel,
}: IntakePageProps): React.JSX.Element {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const [draft, setDraft] = useState<IntakeDraft>(() => restoredDraft ?? emptyIntakeDraft());
  const [showProblems, setShowProblems] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [photosExpired, setPhotosExpired] = useState(false);
  const [restoredOnce] = useState(restoredDraft ?? null);
  const pageRef = useRef<HTMLDivElement>(null);

  // The store's lists, live; if they cannot be read the built-in ones stand in, and the command
  // still checks the photos against the store's current list.
  const settings = useIntakeOptionSettings();
  const options = useMemo(
    () =>
      settings.status === 'ready' ? storeIntakeOptions(settings.data) : DEFAULT_INTAKE_OPTIONS,
    [settings],
  );
  const update = (patch: Partial<IntakeDraft>): void =>
    setDraft((current) => ({ ...current, ...patch }));
  const dirty = intakeDirty(draft);
  const problemsBy = useMemo(
    () =>
      Object.fromEntries(
        SECTIONS.map((section) => [section, stepProblems(draft, section, options)]),
      ),
    [draft, options],
  ) as Readonly<Record<Section, IntakeProblem[]>>;
  const problems = SECTIONS.flatMap((section) => problemsBy[section]);
  const problemText = (problem: IntakeProblem): string | undefined =>
    showProblems && problems.includes(problem) ? tn(PROBLEM_KEY[problem]) : undefined;

  // Write-through retention: every change, never on unmount (an unmount is what a lock looks like).
  useEffect(() => {
    onDraftChange?.(dirty ? draft : null);
  }, [dirty, draft, onDraftChange]);

  // A draft kept across a lock can outlive its photos (a capture no ticket refers to is deleted a
  // day after it was taken). Photos that no longer load are dropped so they are asked for again.
  useEffect(() => {
    if (restoredOnce === null) return;
    let live = true;
    void Promise.all(
      Object.values(restoredOnce.photos).map(async (ref) => {
        if (ref === undefined) return null;
        const state = await runtime
          .loadThumbnail(capturedThumbnailRef(ref))
          .catch(() => ({ kind: 'unavailable' }) as const);
        return state.kind === 'ready' ? null : ref.mediaId;
      }),
    ).then((results) => {
      const gone = new Set(results.filter((id): id is string => id !== null));
      if (!live || gone.size === 0) return;
      setDraft((current) => ({
        ...current,
        photos: Object.fromEntries(
          Object.entries(current.photos).filter(
            ([, ref]) => ref === undefined || !gone.has(ref.mediaId),
          ),
        ),
      }));
      setPhotosExpired(true);
    });
    return () => {
      live = false;
    };
  }, [restoredOnce, runtime]);

  const requestLeave = (): void => {
    if (!dirty) {
      onDraftChange?.(null);
      onCancel();
    } else setLeaving(true);
  };

  const focusProblem = (problem: IntakeProblem): void => {
    const target = pageRef.current?.querySelector<HTMLElement>(
      `[data-testid="${PROBLEM_FIELD[problem]}"]`,
    );
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    // A section (the photos, the price lines) hands focus to its first control.
    const control =
      target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
        ? target
        : target?.querySelector<HTMLElement>('input, textarea, button');
    control?.focus({ preventScroll: true });
  };

  const save = (): void => {
    if (settings.status === 'loading') return;
    if (problems.length > 0) {
      setShowProblems(true);
      focusProblem(problems[0]!);
      return;
    }
    void runner
      .run(() => runtime.run('openTicket', toOpenTicketInput(draft, options, now())))
      .then((opened) => {
        if (opened === undefined) return;
        onDraftChange?.(null);
        onOpened(opened.ticketId);
      });
  };
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // Not under a dialog (the discard question): its own buttons answer it.
      if (document.querySelector('[role="dialog"], [role="alertdialog"]') !== null) return;
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        saveRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const takePhoto = (angle: IntakeOption): void => {
    void runner
      .run(() => runtime.capturePhoto({ title: optionLabel('photoAngles', angle) }))
      .then((captured) => {
        if (captured === undefined || captured === null) return;
        setDraft((current) => ({
          ...current,
          photos: { ...current.photos, [angle.id]: captured.mediaRef },
        }));
      });
  };

  return (
    <div ref={pageRef} className="flex min-h-0 flex-1 flex-col" data-testid="repair.desk.intake">
      <PageHeader
        title={tn('repair.action.newIntake')}
        leading={
          <IconButton
            icon={ArrowLeft}
            label={t('core.action.back')}
            className="-ml-2"
            onClick={requestLeave}
            data-testid="repair.desk.intake.back"
          />
        }
        actions={
          dirty ? (
            <Button
              label={tn('repair.intake.discard')}
              variant="dangerText"
              onClick={() => setLeaving(true)}
              data-testid="repair.desk.intake.discard"
            />
          ) : undefined
        }
      />
      {settings.status === 'loading' ? (
        // The store's lists decide the checks and photo angles: wait for them rather than let the
        // form change under the person typing.
        <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-6 px-6 pt-2" aria-busy>
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto grid max-w-[1180px] grid-cols-[minmax(0,1fr)_300px] gap-8 px-6 pb-12 pt-2">
            <div className="flex min-w-0 flex-col gap-6">
              <IntakeSection
                n={1}
                section="customer"
                complete={problemsBy.customer.length === 0 && customerGiven(draft)}
              >
                <CustomerFields
                  draft={draft}
                  update={update}
                  nameError={problemText('customerName')}
                />
              </IntakeSection>
              <IntakeSection n={2} section="device" complete={problemsBy.device.length === 0}>
                <DeviceFields
                  draft={draft}
                  update={update}
                  options={options}
                  brandError={problemText('deviceBrand')}
                  modelError={problemText('deviceModel')}
                />
              </IntakeSection>
              <IntakeSection n={3} section="condition" complete={problemsBy.condition.length === 0}>
                <ConditionFields
                  draft={draft}
                  update={update}
                  options={options}
                  complaintError={problemText('complaint')}
                />
              </IntakeSection>
              <IntakeSection n={4} section="photos" complete={problemsBy.photos.length === 0}>
                {photosExpired ? (
                  <p role="status" className="mb-3 text-small font-semibold text-warning">
                    {tn('repair.photo.expired')}
                  </p>
                ) : null}
                <PhotoFields
                  draft={draft}
                  angles={options.photoAngles}
                  onTake={takePhoto}
                  showMissing={showProblems}
                />
              </IntakeSection>
              <IntakeSection n={5} section="price" complete={problemsBy.price.length === 0}>
                <PriceFields
                  draft={draft}
                  update={update}
                  options={options}
                  kinds={priceKinds(runtime.hasPermission(REPAIR_PERMISSION.discount))}
                  lineError={problemText('incompleteLine')}
                  totalError={problemText('negativeTotal') ?? problemText('quoteLines')}
                />
              </IntakeSection>
            </div>
            <Summary
              draft={draft}
              options={options}
              problemsBy={problemsBy}
              showProblems={showProblems}
              onJump={focusProblem}
              onSave={save}
              busy={runner.busy}
              error={<ActionError errorCode={runner.errorCode} onDismiss={runner.clearError} />}
            />
          </div>
        </div>
      )}
      <ConfirmDialog
        open={leaving}
        title={tn('repair.intake.discardTitle')}
        message={tn('repair.intake.discardMessage')}
        confirmLabel={tn('repair.intake.discard')}
        cancelLabel={tn('repair.intake.keepEditing')}
        closeLabel={t('core.action.close')}
        destructive
        onConfirm={() => {
          setLeaving(false);
          onDraftChange?.(null);
          onCancel();
        }}
        onCancel={() => setLeaving(false)}
        testId="repair.desk.intake.discardConfirm"
      />
    </div>
  );
}

function customerGiven(draft: IntakeDraft): boolean {
  return draft.customer.kind === 'existing' || draft.customer.name.trim() !== '';
}

function IntakeSection({
  n,
  section,
  complete,
  action,
  children,
}: {
  readonly n: number;
  readonly section: Section;
  readonly complete: boolean;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}): React.JSX.Element {
  return (
    <section
      id={`intake-${section}`}
      aria-labelledby={`intake-${section}-title`}
      data-testid={`repair.desk.intake.section.${section}`}
      className="rounded-md border border-border bg-surface p-6"
    >
      <div className="mb-4 flex items-center gap-3">
        <span
          aria-hidden
          className={
            complete
              ? 'flex size-7 shrink-0 items-center justify-center rounded-full bg-success text-white'
              : 'tabular flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-alt text-small font-bold text-text-muted'
          }
        >
          {complete ? <Check size={16} /> : n}
        </span>
        <h2 id={`intake-${section}-title`} className="flex-1 text-heading font-semibold text-text">
          {tn(INTAKE_STEP_KEY[section])}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

// ── customer ────────────────────────────────────────────────────────────────────────────────

/**
 * A new customer by name and phone, with existing customers whose name or phone fuzzily match
 * offered as the counter types, so a returning customer is picked instead of entered twice.
 */
function CustomerFields({
  draft,
  update,
  nameError,
}: {
  readonly draft: IntakeDraft;
  readonly update: (patch: Partial<IntakeDraft>) => void;
  readonly nameError: string | undefined;
}): React.JSX.Element {
  const customer = draft.customer;
  const searchText =
    customer.kind === 'new' ? [customer.name, customer.phone].join(' ').trim() : '';
  const matches = useRepairQuery(
    async (rt) =>
      searchText.length < 2
        ? []
        : (await rt.query('searchCustomers', { text: searchText, limit: 5 })).rows,
    `desk.customers:${searchText}`,
  );

  if (customer.kind === 'existing') {
    return (
      <div
        className="flex items-center gap-4 rounded-sm bg-surface-alt px-4 py-3"
        data-testid="repair.desk.intake.picked"
      >
        <UserRound size={20} className="text-text-muted" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-body font-semibold text-text">{customer.name}</p>
          {customer.phone === null ? null : (
            <p className="tabular text-small text-text-muted">{formatPhone(customer.phone)}</p>
          )}
        </div>
        <Button
          label={tn('repair.customer.change')}
          size="sm"
          icon={X}
          onClick={() => update({ customer: { kind: 'new', name: '', phone: '' } })}
          data-testid="repair.desk.intake.changeCustomer"
        />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4">
        <TextField
          label={tn('repair.customer.name')}
          value={customer.name}
          onChange={(event) => update({ customer: { ...customer, name: event.target.value } })}
          error={nameError}
          autoFocus
          autoComplete="off"
          data-testid="repair.desk.intake.name"
        />
        <TextField
          label={tn('repair.customer.phone')}
          placeholder={tn('repair.customer.phoneHint')}
          value={customer.phone}
          onChange={(event) => update({ customer: { ...customer, phone: event.target.value } })}
          inputMode="tel"
          autoComplete="off"
          data-testid="repair.desk.intake.phone"
        />
      </div>
      {matches.status === 'ready' && matches.data.length > 0 ? (
        <div data-testid="repair.desk.intake.matches">
          <p className="mb-1 text-small font-semibold text-text-muted">
            {tn('repair.customer.existing')}
          </p>
          <ul className="divide-y divide-border rounded-sm border border-border">
            {matches.data.map((row) => (
              <li key={row.id} className="flex items-center gap-4 px-4 py-2">
                <div className="min-w-0 flex-1">
                  <p className="text-body font-semibold text-text">{row.name}</p>
                  {row.phone === null ? null : (
                    <p className="tabular text-small text-text-muted">{formatPhone(row.phone)}</p>
                  )}
                </div>
                <Button
                  label={tn('repair.desk.useCustomer')}
                  aria-label={`${tn('repair.desk.useCustomer')}: ${row.name}`}
                  size="sm"
                  onClick={() =>
                    update({
                      customer: {
                        kind: 'existing',
                        customerId: row.id,
                        name: row.name,
                        phone: row.phone,
                      },
                    })
                  }
                  data-testid={`repair.desk.intake.match.${row.id}`}
                />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

// ── device ──────────────────────────────────────────────────────────────────────────────────

function DeviceFields({
  draft,
  update,
  options,
  brandError,
  modelError,
}: {
  readonly draft: IntakeDraft;
  readonly update: (patch: Partial<IntakeDraft>) => void;
  readonly options: IntakeOptionLists;
  readonly brandError: string | undefined;
  readonly modelError: string | undefined;
}): React.JSX.Element {
  const device = draft.device;
  const set = (patch: Partial<IntakeDraft['device']>): void =>
    update({ device: { ...device, ...patch } });
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-2">
          <TextField
            label={tn('repair.device.brand')}
            value={device.brand}
            onChange={(event) => set({ brand: event.target.value })}
            error={brandError}
            autoComplete="off"
            data-testid="repair.desk.intake.brand"
          />
          <div
            className="flex flex-wrap gap-2"
            aria-label={tn('repair.options.list.brands')}
            role="group"
          >
            {options.brands.map((option) => {
              const brand = optionLabel('brands', option);
              return (
                <ToggleChip
                  key={option.id}
                  label={brand}
                  selected={device.brand === brand}
                  onToggle={() => set({ brand })}
                  skipTab
                />
              );
            })}
          </div>
        </div>
        <TextField
          label={tn('repair.device.model')}
          value={device.model}
          onChange={(event) => set({ model: event.target.value })}
          error={modelError}
          autoComplete="off"
          data-testid="repair.desk.intake.model"
        />
        <TextField
          label={tn('repair.device.colorField')}
          value={device.color}
          onChange={(event) => set({ color: event.target.value })}
          autoComplete="off"
          data-testid="repair.desk.intake.color"
        />
        <TextField
          label={tn('repair.device.imeiField')}
          value={device.imei}
          onChange={(event) => set({ imei: event.target.value })}
          inputMode="numeric"
          autoComplete="off"
          inputClassName="tabular"
          data-testid="repair.desk.intake.imei"
        />
        <SecretField
          label={tn('repair.device.passcode')}
          showLabel={tn('repair.passcode.show')}
          hideLabel={tn('repair.passcode.hide')}
          value={device.passcode}
          onChange={(event) => set({ passcode: event.target.value })}
          data-testid="repair.desk.intake.passcode"
        />
      </div>
    </div>
  );
}

// ── condition ───────────────────────────────────────────────────────────────────────────────

function ConditionFields({
  draft,
  update,
  options,
  complaintError,
}: {
  readonly draft: IntakeDraft;
  readonly update: (patch: Partial<IntakeDraft>) => void;
  readonly options: IntakeOptionLists;
  readonly complaintError: string | undefined;
}): React.JSX.Element {
  const togglePeripheral = (item: string): void =>
    update({
      peripherals: draft.peripherals.includes(item)
        ? draft.peripherals.filter((p) => p !== item)
        : [...draft.peripherals, item],
    });
  return (
    <div className="flex flex-col gap-6">
      <TextArea
        label={tn('repair.condition.complaint')}
        value={draft.complaint}
        onChange={(event) => update({ complaint: event.target.value })}
        error={complaintError}
        rows={2}
        data-testid="repair.desk.intake.complaint"
      />
      {options.checks.length === 0 ? null : (
        <div>
          <div className="mb-2 flex items-center justify-between gap-4">
            <p className="text-small font-semibold text-text">{tn('repair.condition.checks')}</p>
            <Button
              label={tn('repair.condition.restOk')}
              icon={Check}
              variant="text"
              size="sm"
              className="-mr-2"
              onClick={() => update({ checks: restOfChecksOk(draft.checks, options.checks) })}
              data-testid="repair.desk.intake.restOk"
            />
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(330px,1fr))] gap-x-8 border-t border-border">
            {options.checks.map((option) => {
              const name = optionLabel('checks', option);
              return (
                <div
                  key={option.id}
                  className="flex min-h-12 items-center justify-between gap-4 border-b border-border py-1"
                >
                  <span className="min-w-0 text-body text-text">{name}</span>
                  <Segmented
                    label={name}
                    size="sm"
                    options={CHECKLIST_STATES.map((value) => ({
                      value,
                      label: tn(CHECK_STATE_KEY[value]),
                      tone: CHECK_TONE[value],
                    }))}
                    value={draft.checks[option.id] ?? 'not_checked'}
                    onChange={(state) =>
                      update({ checks: { ...draft.checks, [option.id]: state } })
                    }
                    testId={`repair.desk.intake.check.${option.id}`}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}
      {options.accessories.length === 0 ? null : (
        <div>
          <p className="mb-2 text-small font-semibold text-text">
            {tn('repair.condition.peripherals')}
          </p>
          <div className="flex flex-wrap gap-2">
            {options.accessories.map((option) => (
              <ToggleChip
                key={option.id}
                label={optionLabel('accessories', option)}
                selected={draft.peripherals.includes(option.id)}
                onToggle={() => togglePeripheral(option.id)}
              />
            ))}
          </div>
        </div>
      )}
      <TextArea
        label={tn('repair.condition.notes')}
        value={draft.intakeNotes}
        onChange={(event) => update({ intakeNotes: event.target.value })}
        rows={2}
        data-testid="repair.desk.intake.notes"
      />
    </div>
  );
}

// ── photos ──────────────────────────────────────────────────────────────────────────────────

function PhotoFields({
  draft,
  angles,
  onTake,
  showMissing,
}: {
  readonly draft: IntakeDraft;
  readonly angles: readonly IntakeOption[];
  readonly onTake: (angle: IntakeOption) => void;
  readonly showMissing: boolean;
}): React.JSX.Element {
  return (
    <div data-testid="repair.desk.intake.photos" tabIndex={-1} className="focus:outline-none">
      <p className="mb-4 text-body text-text-muted">{tn('repair.photo.intakeHint')}</p>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-3">
        {angles.map((angle) => (
          <AngleTile
            key={angle.id}
            label={optionLabel('photoAngles', angle)}
            photo={draft.photos[angle.id]}
            missing={showMissing}
            onTake={() => onTake(angle)}
            testId={`repair.desk.intake.photo.${angle.id}`}
          />
        ))}
      </div>
    </div>
  );
}

function AngleTile({
  label,
  photo,
  missing,
  onTake,
  testId,
}: {
  readonly label: string;
  readonly photo: MediaRef | undefined;
  readonly missing: boolean;
  readonly onTake: () => void;
  readonly testId: string;
}): React.JSX.Element {
  const state = usePhotoState(photo === undefined ? null : capturedThumbnailRef(photo));
  return (
    <CaptureTile
      label={label}
      actionLabel={tn(photo === undefined ? 'repair.photo.take' : 'repair.photo.retake')}
      state={photo === undefined ? null : state}
      labels={photoLabels()}
      onCapture={onTake}
      invalid={missing && photo === undefined}
      testId={testId}
    />
  );
}

// ── price ───────────────────────────────────────────────────────────────────────────────────

const EMPTY_LINE: QuoteLineDraft = { kind: 'part', description: '', amount: 0 };

/** Price lines edited where they stand, a row each; with none yet, one empty row is offered. */
function PriceFields({
  draft,
  update,
  options,
  kinds,
  lineError,
  totalError,
}: {
  readonly draft: IntakeDraft;
  readonly update: (patch: Partial<IntakeDraft>) => void;
  readonly options: IntakeOptionLists;
  readonly kinds: readonly PriceKind[];
  readonly lineError: string | undefined;
  readonly totalError: string | undefined;
}): React.JSX.Element {
  const lines = draft.lines.length === 0 ? [EMPTY_LINE] : draft.lines;
  const setLine = (index: number, patch: Partial<QuoteLineDraft>): void =>
    update({ lines: lines.map((line, i) => (i === index ? { ...line, ...patch } : line)) });
  const addLine = (): void => update({ lines: [...lines, EMPTY_LINE] });
  return (
    <div className="flex flex-col gap-6">
      <div data-testid="repair.desk.intake.lines" tabIndex={-1} className="focus:outline-none">
        <div className="grid grid-cols-[auto_minmax(0,1fr)_168px_36px] items-center gap-x-3 border-b border-border pb-2 text-small font-semibold text-text-muted">
          <span>{tn('repair.desk.priceKind')}</span>
          <span>{tn('repair.price.description')}</span>
          <span className="text-right">{tn('repair.price.amount')}</span>
          <span />
        </div>
        {lines.map((line, index) => {
          const incomplete =
            line.description.trim() === '' && line.amount !== 0 ? lineError : undefined;
          return (
            <div key={index} className="border-b border-border py-2">
              <div className="grid grid-cols-[auto_minmax(0,1fr)_168px_36px] items-center gap-x-3">
                <Segmented
                  label={tn('repair.desk.priceKind')}
                  size="sm"
                  options={kinds.map((value) => ({ value, label: tn(PRICE_KIND_KEY[value]) }))}
                  value={line.kind as PriceKind}
                  onChange={(kind) => setLine(index, { kind })}
                />
                <input
                  aria-label={tn('repair.price.description')}
                  aria-invalid={incomplete !== undefined || undefined}
                  value={line.description}
                  onChange={(event) => setLine(index, { description: event.target.value })}
                  data-testid={`repair.desk.intake.line.${String(index)}.description`}
                  className={`${controlClass(incomplete !== undefined)} h-9`}
                />
                <input
                  aria-label={tn('repair.price.amount')}
                  inputMode="numeric"
                  value={rupiahText(line.amount)}
                  onChange={(event) => {
                    if (acceptsRupiahText(event.target.value))
                      setLine(index, { amount: parseRupiah(event.target.value) ?? 0 });
                  }}
                  onKeyDown={(event) => {
                    // Enter on the last amount adds the next line, like a spreadsheet.
                    if (event.key === 'Enter' && !event.ctrlKey && index === lines.length - 1) {
                      event.preventDefault();
                      addLine();
                      // Straight on to the new line's description.
                      requestAnimationFrame(() =>
                        document
                          .querySelector<HTMLElement>(
                            `[data-testid="repair.desk.intake.line.${String(index + 1)}.description"]`,
                          )
                          ?.focus(),
                      );
                    }
                  }}
                  data-testid={`repair.desk.intake.line.${String(index)}.amount`}
                  className={`${controlClass(false)} tabular h-9 text-right`}
                />
                {lines.length > 1 ? (
                  <IconButton
                    icon={Trash2}
                    label={
                      line.description.trim() === ''
                        ? t('core.action.delete')
                        : `${t('core.action.delete')}: ${line.description.trim()}`
                    }
                    onClick={() => update({ lines: lines.filter((_, i) => i !== index) })}
                  />
                ) : (
                  <span />
                )}
              </div>
              {incomplete === undefined ? null : (
                <p className="mt-1 text-small text-danger">{incomplete}</p>
              )}
            </div>
          );
        })}
        <div className="flex items-center justify-between gap-4 pt-3">
          <Button
            label={tn('repair.price.addRow')}
            icon={Plus}
            variant="text"
            size="sm"
            className="-ml-2"
            onClick={addLine}
            data-testid="repair.desk.intake.addLine"
          />
          <p className="flex items-baseline gap-4">
            <span className="text-body font-semibold text-text">{tn('repair.price.total')}</span>
            <span
              className="tabular text-title font-bold text-text"
              data-testid="repair.desk.intake.total"
            >
              {formatMoney(intakeTotal(draft.lines))}
            </span>
          </p>
        </div>
        {totalError === undefined ? null : (
          <p className="mt-1 text-right text-small text-danger">{totalError}</p>
        )}
      </div>
      <div>
        <p className="mb-2 text-small font-semibold text-text">{tn('repair.ticket.readyBy')}</p>
        <Segmented
          label={tn('repair.ticket.readyBy')}
          options={options.readyBy.map(({ id }) => ({ value: id, label: readyLabel(id) }))}
          value={chosenReady(draft, options.readyBy)}
          onChange={(ready) => update({ ready })}
          testId="repair.desk.intake.ready"
        />
      </div>
    </div>
  );
}

// ── summary ─────────────────────────────────────────────────────────────────────────────────

function Summary({
  draft,
  options,
  problemsBy,
  showProblems,
  onJump,
  onSave,
  busy,
  error,
}: {
  readonly draft: IntakeDraft;
  readonly options: IntakeOptionLists;
  readonly problemsBy: Readonly<Record<Section, IntakeProblem[]>>;
  readonly showProblems: boolean;
  readonly onJump: (problem: IntakeProblem) => void;
  readonly onSave: () => void;
  readonly busy: boolean;
  readonly error: ReactNode;
}): React.JSX.Element {
  const device = [draft.device.brand, draft.device.model].filter((s) => s.trim() !== '').join(' ');
  const taken = options.photoAngles.filter((angle) => draft.photos[angle.id] !== undefined).length;
  const customer =
    draft.customer.kind === 'existing' ? draft.customer.name : draft.customer.name.trim();
  const rows: readonly { key: Section; value: string }[] = [
    { key: 'customer', value: customer },
    { key: 'device', value: device },
    { key: 'condition', value: draft.complaint.trim() },
    {
      key: 'photos',
      value: tn('repair.desk.photoCount', { taken, total: options.photoAngles.length }),
    },
  ];
  // What is missing is said once, beside the field; the summary only marks the section and jumps there.
  const jump = (section: Section, label: string): React.JSX.Element => (
    <button
      type="button"
      onClick={() => onJump(problemsBy[section][0]!)}
      data-testid={`repair.desk.intake.jump.${section}`}
      className="cursor-pointer text-left text-body font-semibold text-danger underline-offset-2 hover:underline"
    >
      {label}
    </button>
  );
  const flagged = (section: Section): boolean => showProblems && problemsBy[section].length > 0;
  return (
    <aside
      className="sticky top-2 flex flex-col gap-4 self-start"
      data-testid="repair.desk.intake.summary"
    >
      <div className="rounded-md border border-border bg-surface p-5">
        <dl className="flex flex-col gap-3">
          {rows.map((row) => {
            const missing = problemsBy[row.key];
            return (
              <div key={row.key} className="flex items-start gap-3">
                <span
                  aria-hidden
                  className={
                    missing.length === 0
                      ? 'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-success-bg text-success'
                      : `mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border ${flagged(row.key) ? 'border-danger' : 'border-border'}`
                  }
                >
                  {missing.length === 0 ? <Check size={12} strokeWidth={3} /> : null}
                </span>
                <div className="min-w-0">
                  <dt className="text-small text-text-muted">{tn(INTAKE_STEP_KEY[row.key])}</dt>
                  <dd className="line-clamp-2 break-words text-body font-semibold text-text">
                    {flagged(row.key)
                      ? jump(row.key, row.value === '' ? tn('repair.desk.incomplete') : row.value)
                      : row.value === ''
                        ? '–'
                        : row.value}
                  </dd>
                </div>
              </div>
            );
          })}
        </dl>
        <div className="mt-4 border-t border-border pt-4">
          <p className="text-small text-text-muted">{tn('repair.price.total')}</p>
          <p className="tabular text-display font-bold text-text">
            {formatMoney(intakeTotal(draft.lines))}
          </p>
          <p className="text-small text-text-muted">
            {tn('repair.ticket.readyBy')}: {readyLabel(chosenReady(draft, options.readyBy))}
          </p>
          {flagged('price') ? (
            <p className="mt-1">{jump('price', tn('repair.desk.incomplete'))}</p>
          ) : null}
        </div>
        <Button
          label={tn('repair.action.openTicket')}
          variant="primary"
          size="lg"
          shortcut="Ctrl+Enter"
          className="mt-5 w-full"
          onClick={onSave}
          busy={busy}
          data-testid="repair.desk.intake.save"
        />
      </div>
      {error}
    </aside>
  );
}
