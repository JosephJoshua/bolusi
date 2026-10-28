// The counter's intake on one page: customer, device, condition, photos and price as sections the
// keyboard can Tab straight through, with a summary beside them that says what is still missing and
// holds the one action that opens the ticket (Ctrl+Enter). The draft is the phone's (flows.ts): the
// same checks, the same `openTicket` input, kept across an idle lock and released only on save or
// discard.
import { formatMoney, formatPhone, t } from '@bolusi/i18n';
import {
  Button,
  Banner,
  CaptureTile,
  ConfirmDialog,
  IconButton,
  Kbd,
  PageHeader,
  PatternPad,
  SecretField,
  Skeleton,
  Segmented,
  TextArea,
  TextField,
  ToggleChip,
  Tooltip,
  controlClass,
} from '@bolusi/ui-web';
import { ArrowLeft, Camera, Check, Plus, Trash2, UserRound, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { useActionRunner, type VideoMediaRef } from '../../screen-kit/index.js';
import { PATTERN_MIN_DOTS, SCREEN_LOCK_KINDS } from '../screen-lock.js';
import type { DeviceModelRow } from '../device-models.js';
import { modelCaption, useModelPicker, type ModelPicker } from '../model-picker.js';
import { CHECKLIST_STATES, type ChecklistState } from '../constants.js';
import {
  capturedThumbnailRef,
  chosenReady,
  emptyIntakeDraft,
  intakeDirty,
  intakeNeedsVideo,
  intakeTotal,
  phoneText,
  priceKinds,
  restOfChecksOk,
  toggled,
  stepProblems,
  toOpenTicketInput,
  claimWarrantyEnded,
  acceptsRupiahText,
  balanceAfterDownPayment,
  intakeDownPayment,
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
  LOCK_KIND_KEY,
  PRICE_KIND_KEY,
  optionLabel,
  readyLabel,
} from '../labels.js';
import {
  useIntakeOptionSettings,
  usePaymentAccounts,
  useRepairQuery,
  useRepairRuntime,
} from '../runtime.js';
import type { PaymentAccountRow } from '../../money/queries.js';
import { PaymentMethodField } from '../../money/desktop/PaymentMethodField.js';
import type { MediaRef } from '@bolusi/schemas';
import { useOwnershipVideo, useRestoredVideoCheck } from '../ownership-video.js';
import { OwnershipVideoField } from './video.js';

import { ActionError } from '../../screen-kit/desktop/index.js';
import { ModelPhoto, MoneyField, photoLabels, rupiahText, usePhotoState } from './parts.js';

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
  ownershipVideo: 'repair.problem.ownershipVideo',
  quoteLines: 'repair.problem.quoteLines',
  incompleteLine: 'repair.problem.incompleteLine',
  negativeTotal: 'repair.problem.negativeTotal',
  downPaymentAboveTotal: 'repair.problem.downPaymentAboveTotal',
  downPaymentReference: 'repair.problem.downPaymentReference',
  screenLock: 'repair.problem.screenLock',
};

/** Where the cursor goes for each problem, so "what is missing" is one keystroke from fixed. */
const PROBLEM_FIELD: Readonly<Record<IntakeProblem, string>> = {
  customerName: 'repair.desk.intake.name',
  deviceBrand: 'repair.desk.intake.brand',
  deviceModel: 'repair.desk.intake.model',
  complaint: 'repair.desk.intake.complaint',
  photos: 'repair.desk.intake.photos',
  ownershipVideo: 'repair.desk.intake.video',
  quoteLines: 'repair.desk.intake.line.0.description',
  incompleteLine: 'repair.desk.intake.lines',
  negativeTotal: 'repair.desk.intake.lines',
  downPaymentAboveTotal: 'repair.desk.intake.downPayment',
  downPaymentReference: 'repair.desk.intake.downPaymentMethod.reference',
  screenLock: 'repair.desk.intake.lock.kind',
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
  /**
   * `restoredDraft` is a new warranty claim filled in from its servisan, not something the person
   * typed: it is kept, and leaving asks, only once they change something.
   */
  readonly prefilled?: boolean | undefined;
  readonly onDraftChange?: ((draft: IntakeDraft | null) => void) | undefined;
  readonly onOpened: (ticketId: string) => void;
  readonly onCancel: () => void;
}

/** Saves the intake from anywhere on the page; the same keys on every keyboard layout. */
const SAVE_KEYS = 'Ctrl+Enter';

export function IntakePage({
  now,
  restoredDraft,
  prefilled = false,
  onDraftChange,
  onOpened,
  onCancel,
}: IntakePageProps): React.JSX.Element {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const [draft, setDraft] = useState<IntakeDraft>(() => restoredDraft ?? emptyIntakeDraft());
  const [startedAs] = useState(draft);
  const [showProblems, setShowProblems] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [photosExpired, setPhotosExpired] = useState(false);
  const [restoredOnce] = useState(restoredDraft ?? null);
  const [videoExpired, setVideoExpired] = useState(false);
  useRestoredVideoCheck(restoredOnce, () => {
    setDraft((current) => ({ ...current, ownershipVideo: null }));
    setVideoExpired(true);
  });
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
  // A claim filled in from its servisan is not yet anything the person typed.
  const dirty = intakeDirty(draft) && (!prefilled || draft !== startedAs);
  // Null while loading: a restored draft's DP method waits for them rather than becoming cash.
  const loadedAccounts = usePaymentAccounts();
  const accounts = loadedAccounts ?? [];
  const problemsBy = useMemo(
    () =>
      Object.fromEntries(
        SECTIONS.map((section) => [section, stepProblems(draft, section, options, accounts)]),
      ),
    [draft, options, accounts],
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
    if (settings.status === 'loading' || loadedAccounts === null) return;
    if (problems.length > 0) {
      setShowProblems(true);
      focusProblem(problems[0]!);
      return;
    }
    void runner
      .run(() => runtime.run('openTicket', toOpenTicketInput(draft, options, now(), accounts)))
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

  const video = useOwnershipVideo();
  const needsVideo = intakeNeedsVideo(draft, options);
  const recordVideo =
    video.record === undefined
      ? undefined
      : (): void => {
          const record = video.record!;
          void runner.run(record).then((captured) => {
            if (captured === undefined || captured === null) return;
            setDraft((current) => ({ ...current, ownershipVideo: captured.videoRef }));
          });
        };
  const playVideo =
    video.play === undefined
      ? undefined
      : (ref: VideoMediaRef): void => void runner.run(() => video.play!(ref));

  /** Every angle still missing, one after another; backing out of one stops there. */
  const takeMissing = (): void => {
    const missing = options.photoAngles.filter((angle) => draft.photos[angle.id] === undefined);
    void runner.run(async () => {
      for (const angle of missing) {
        const captured = await runtime.capturePhoto({ title: optionLabel('photoAngles', angle) });
        if (captured === null) return;
        setDraft((current) => ({
          ...current,
          photos: { ...current.photos, [angle.id]: captured.mediaRef },
        }));
      }
    });
  };

  return (
    <div ref={pageRef} className="flex min-h-0 flex-1 flex-col" data-testid="repair.desk.intake">
      <PageHeader
        title={tn(
          draft.claimOf === null ? 'repair.action.newIntake' : 'repair.warrantyClaim.title',
        )}
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
        // Laid out by the room the page has, not the screen: the sidebar may be open or not. The
        // summary narrows, then drops under the form; field pairs stack when a column is narrow.
        <div className="@container min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto grid max-w-[1180px] grid-cols-1 gap-8 px-6 pb-12 pt-2 @3xl:grid-cols-[minmax(0,1fr)_248px] @5xl:grid-cols-[minmax(0,1fr)_300px]">
            <div className="@container flex min-w-0 flex-col gap-6">
              {draft.claimOf === null ? null : (
                <div className="flex flex-col gap-2" data-testid="repair.desk.intake.claim">
                  <Banner
                    tone="info"
                    message={tn('repair.warrantyClaim.intakeNote', {
                      number: draft.claimOf.ticketNumber,
                    })}
                  />
                  {claimWarrantyEnded(draft.claimOf, now()) ? (
                    <Banner tone="warning" message={tn('repair.warrantyClaim.ended')} />
                  ) : null}
                </div>
              )}
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
                  lockError={problemText('screenLock')}
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
                  onTakeMissing={takeMissing}
                  showMissing={showProblems}
                />
                {needsVideo ? (
                  <div
                    className="mt-6 flex flex-col gap-3 focus:outline-none"
                    tabIndex={-1}
                    data-testid="repair.desk.intake.video"
                  >
                    <div>
                      <p className="text-body font-semibold text-text">
                        {tn('repair.video.title')}
                      </p>
                      <p className="text-body text-text-muted">{tn('repair.video.hint')}</p>
                    </div>
                    {videoExpired && draft.ownershipVideo === null ? (
                      <p role="status" className="text-small font-semibold text-warning">
                        {tn('repair.video.expired')}
                      </p>
                    ) : null}
                    <OwnershipVideoField
                      video={draft.ownershipVideo}
                      recordedAt={null}
                      onRecord={recordVideo}
                      onPlay={playVideo}
                      noCamera={recordVideo === undefined}
                      invalid={showProblems}
                      testId="repair.desk.intake.video.clip"
                    />
                    {problemText('ownershipVideo') === undefined ? null : (
                      <p role="alert" className="text-small text-danger">
                        {problemText('ownershipVideo')}
                      </p>
                    )}
                  </div>
                ) : null}
              </IntakeSection>
              <IntakeSection n={5} section="price" complete={problemsBy.price.length === 0}>
                <PriceFields
                  draft={draft}
                  update={update}
                  options={options}
                  kinds={priceKinds(runtime.hasPermission(REPAIR_PERMISSION.discount))}
                  lineError={problemText('incompleteLine')}
                  totalError={problemText('negativeTotal') ?? problemText('quoteLines')}
                  downPaymentError={problemText('downPaymentAboveTotal')}
                  accounts={accounts}
                  referenceError={problemText('downPaymentReference')}
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
      <div className="grid grid-cols-1 gap-4 @lg:grid-cols-2">
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
          onChange={(event) =>
            update({ customer: { ...customer, phone: phoneText(event.target.value) } })
          }
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
  lockError,
}: {
  readonly draft: IntakeDraft;
  readonly update: (patch: Partial<IntakeDraft>) => void;
  readonly options: IntakeOptionLists;
  readonly brandError: string | undefined;
  readonly modelError: string | undefined;
  readonly lockError: string | undefined;
}): React.JSX.Element {
  const device = draft.device;
  const set = (patch: Partial<IntakeDraft['device']>): void =>
    update({ device: { ...device, ...patch } });
  const picker = useModelPicker(device, set);
  const { matched, colours, memory } = picker;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 @lg:grid-cols-2">
        <ModelField
          value={device.model}
          onChange={(model) => set({ model })}
          picker={picker}
          error={modelError}
        />
        <div className="flex flex-col gap-2">
          <TextField
            label={tn('repair.device.brand')}
            value={device.brand}
            onChange={(event) => set({ brand: event.target.value })}
            error={brandError}
            autoComplete="off"
            data-testid="repair.desk.intake.brand"
          />
          {/* Quick picks only while the brand is still open; a catalog model already gave it. */}
          {matched !== null ? null : (
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
          )}
        </div>
      </div>
      {matched === null ? null : (
        <div
          className="flex items-center gap-4 rounded-sm bg-surface-alt px-4 py-3"
          data-testid="repair.desk.intake.modelMatch"
        >
          <ModelPhoto photo={matched.photo} large />
          <div className="min-w-0">
            <p className="text-body font-semibold text-text">
              {matched.brand} {matched.model}
            </p>
            {matched.announcedYear === null ? null : (
              <p className="text-small text-text-muted">
                {tn('repair.device.released', { year: String(matched.announcedYear) })}
              </p>
            )}
            {memory.length === 0 ? null : (
              <p className="text-small text-text-muted">{memory.join(' · ')}</p>
            )}
          </div>
        </div>
      )}
      <div className="grid grid-cols-1 gap-4 @lg:grid-cols-2">
        <div className="flex flex-col gap-2">
          <TextField
            label={tn('repair.device.colorField')}
            value={device.color}
            onChange={(event) => set({ color: event.target.value })}
            autoComplete="off"
            data-testid="repair.desk.intake.color"
          />
          {colours.length === 0 ? null : (
            <div
              className="flex flex-wrap gap-2"
              role="group"
              aria-label={tn('repair.device.colorField')}
            >
              {colours.map((colour) => (
                <ToggleChip
                  key={colour}
                  label={colour}
                  selected={device.color === colour}
                  onToggle={() => set({ color: device.color === colour ? '' : colour })}
                  skipTab
                />
              ))}
            </div>
          )}
        </div>
        <TextField
          label={tn('repair.device.imeiField')}
          value={device.imei}
          onChange={(event) => set({ imei: event.target.value })}
          inputMode="numeric"
          autoComplete="off"
          inputClassName="tabular"
          data-testid="repair.desk.intake.imei"
        />
      </div>
      <ScreenLockFields
        kind={device.lockKind}
        value={device.passcode}
        onChange={(lockKind, passcode) => set({ lockKind, passcode })}
        error={lockError}
      />
    </div>
  );
}

/**
 * The model, typed the way the customer says it. As it is typed, models from the phone catalog and
 * from earlier intakes are offered with their picture; arrow keys and Enter pick one, Escape closes
 * the list. Nothing has to match: a model nobody has heard of is kept as typed.
 */
function ModelField({
  value,
  onChange,
  picker,
  error,
}: {
  readonly value: string;
  readonly onChange: (model: string) => void;
  readonly picker: ModelPicker;
  readonly error: string | undefined;
}): React.JSX.Element {
  // Opens once something is typed: a model already filled in (a claim, a kept draft) needs no list.
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rows = open ? picker.suggestions : [];
  const listId = 'repair.desk.intake.models';
  const choose = (row: DeviceModelRow): void => {
    picker.pick(row);
    setOpen(false);
  };
  return (
    <div className="relative self-start">
      <TextField
        label={tn('repair.device.model')}
        placeholder={tn('repair.device.modelHint')}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
          setActive(0);
        }}
        onBlur={() => {
          setOpen(false);
          picker.tidyModel();
        }}
        onKeyDown={(event) => {
          if (rows.length === 0) return;
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const step = event.key === 'ArrowDown' ? 1 : -1;
            setActive((current) => (current + step + rows.length) % rows.length);
          } else if (event.key === 'Enter' && !event.ctrlKey) {
            event.preventDefault();
            choose(rows[active] ?? rows[0]!);
          } else if (event.key === 'Escape') {
            // Closes the list only, not the page around it.
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          }
        }}
        role="combobox"
        aria-expanded={rows.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={rows.length > 0 ? `${listId}.${String(active)}` : undefined}
        error={error}
        autoComplete="off"
        data-testid="repair.desk.intake.model"
      />
      {rows.length === 0 ? null : (
        <ul
          id={listId}
          role="listbox"
          aria-label={tn('repair.device.model')}
          data-testid={listId}
          className="absolute inset-x-0 top-full z-20 mt-1 animate-pop-in overflow-hidden rounded-sm border border-border bg-surface p-1 shadow-lg"
        >
          {rows.map((row, index) => (
            <li
              key={row.key}
              id={`${listId}.${String(index)}`}
              role="option"
              aria-selected={index === active}
              // Keeps the focus in the field, so picking does not count as leaving it.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(row)}
              onMouseEnter={() => setActive(index)}
              className={`flex cursor-pointer items-center gap-3 rounded-xs px-2 py-1 ${index === active ? 'bg-surface-alt' : ''}`}
            >
              <ModelPhoto photo={row.photo} />
              <span className="min-w-0">
                <span className="block text-body font-semibold text-text">{row.model}</span>
                <span className="block text-small text-text-muted">{modelCaption(row)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * How the phone is unlocked: nothing, a PIN, a password, or the pattern, drawn with the mouse the
 * way the customer draws it (or typed as dot numbers). A typed PIN or password stays hidden, with
 * an eye button to check it with the customer. The rules are the phone's (`stepProblems`).
 */
function ScreenLockFields({
  kind,
  value,
  onChange,
  error,
}: {
  readonly kind: IntakeDraft['device']['lockKind'];
  readonly value: string;
  readonly onChange: (kind: IntakeDraft['device']['lockKind'], value: string) => void;
  /** Set when a lock kind is chosen but nothing was entered for it. */
  readonly error: string | undefined;
}): React.JSX.Element {
  const [tooShort, setTooShort] = useState(false);
  const secret = {
    showLabel: tn('repair.passcode.show'),
    hideLabel: tn('repair.passcode.hide'),
    error,
    autoFocus: true,
    autoComplete: 'off',
    className: 'max-w-80',
  };
  return (
    <div className="flex flex-col gap-3" data-testid="repair.desk.intake.lock">
      <div>
        <p className="mb-2 text-small font-semibold text-text">{tn('repair.device.passcode')}</p>
        <Segmented
          label={tn('repair.device.passcode')}
          options={(['none', ...SCREEN_LOCK_KINDS] as const).map((option) => ({
            value: option,
            label: tn(LOCK_KIND_KEY[option]),
          }))}
          value={kind}
          onChange={(next) => {
            setTooShort(false);
            if (next !== kind) onChange(next, '');
          }}
          testId="repair.desk.intake.lock.kind"
        />
      </div>
      {kind === 'pin' ? (
        <SecretField
          {...secret}
          label={tn('repair.lock.pinField')}
          inputMode="numeric"
          value={value}
          onChange={(event) => onChange('pin', event.target.value.replace(/\D/g, ''))}
          data-testid="repair.desk.intake.lock.pin"
        />
      ) : null}
      {kind === 'password' ? (
        <SecretField
          {...secret}
          label={tn('repair.lock.passwordField')}
          value={value}
          onChange={(event) => onChange('password', event.target.value)}
          data-testid="repair.desk.intake.lock.password"
        />
      ) : null}
      {kind === 'pattern' ? (
        <div className="flex flex-wrap items-start gap-6">
          <PatternPad
            value={value}
            onChange={(drawn) => {
              // A pattern shorter than Android allows was not finished: draw it again.
              const finished = drawn.length >= PATTERN_MIN_DOTS;
              setTooShort(!finished);
              onChange('pattern', finished ? drawn : '');
            }}
            label={tn('repair.lock.patternLabel')}
            testId="repair.desk.intake.lock.pattern"
          />
          <div className="flex flex-col items-start gap-2 pt-1">
            <p
              role={tooShort || error !== undefined ? 'alert' : undefined}
              className={`max-w-60 text-small ${tooShort || error !== undefined ? 'text-danger' : 'text-text-muted'}`}
            >
              {tooShort ? tn('repair.lock.patternShort') : (error ?? tn('repair.lock.patternHint'))}
            </p>
            {value === '' ? null : (
              <Button
                label={tn('repair.lock.patternRedo')}
                variant="text"
                size="sm"
                className="-ml-2"
                onClick={() => onChange('pattern', '')}
                data-testid="repair.desk.intake.lock.redo"
              />
            )}
          </div>
        </div>
      ) : null}
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
    update({ peripherals: toggled(draft.peripherals, item) });
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
      {/* What the counter expects to fix; the technician can change it after the diagnosis. A claim
          repairs what its servisan did, so it has none of its own. */}
      {options.repairTypes.length === 0 || draft.claimOf !== null ? null : (
        <div>
          <p className="mb-2 text-small font-semibold text-text">
            {tn('repair.condition.repairTypes')}
          </p>
          <div className="flex flex-wrap gap-2" data-testid="repair.desk.intake.repairTypes">
            {options.repairTypes.map((option) => (
              <ToggleChip
                key={option.id}
                label={optionLabel('repairTypes', option)}
                selected={draft.repairTypes.includes(option.id)}
                onToggle={() => update({ repairTypes: toggled(draft.repairTypes, option.id) })}
              />
            ))}
          </div>
        </div>
      )}
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
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(330px,100%),1fr))] gap-x-8 border-t border-border">
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
  onTakeMissing,
  showMissing,
}: {
  readonly draft: IntakeDraft;
  readonly angles: readonly IntakeOption[];
  readonly onTake: (angle: IntakeOption) => void;
  /** Takes every missing angle in a row. */
  readonly onTakeMissing: () => void;
  readonly showMissing: boolean;
}): React.JSX.Element {
  const missing = angles.filter((angle) => draft.photos[angle.id] === undefined).length;
  return (
    <div data-testid="repair.desk.intake.photos" tabIndex={-1} className="focus:outline-none">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="text-body text-text-muted">{tn('repair.photo.intakeHint')}</p>
        {missing > 1 ? (
          <Button
            label={tn('repair.photo.takeAll')}
            icon={Camera}
            size="sm"
            onClick={onTakeMissing}
            data-testid="repair.desk.intake.photo.all"
          />
        ) : null}
      </div>
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
  downPaymentError,
  accounts,
  referenceError,
}: {
  readonly draft: IntakeDraft;
  readonly update: (patch: Partial<IntakeDraft>) => void;
  readonly options: IntakeOptionLists;
  readonly kinds: readonly PriceKind[];
  readonly lineError: string | undefined;
  readonly totalError: string | undefined;
  readonly downPaymentError: string | undefined;
  readonly accounts: readonly PaymentAccountRow[];
  readonly referenceError: string | undefined;
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
        <div className="mt-4 ml-auto w-60">
          <MoneyField
            label={tn('repair.price.downPaymentInput')}
            value={draft.downPayment === '' ? null : intakeDownPayment(draft)}
            onChange={(amount) => update({ downPayment: amount === null ? '' : String(amount) })}
            error={downPaymentError}
            data-testid="repair.desk.intake.downPayment"
          />
        </div>
        {intakeDownPayment(draft) > 0 ? (
          <div className="mt-3">
            <PaymentMethodField
              accounts={accounts}
              account={draft.downPaymentAccount}
              reference={draft.downPaymentReference}
              onChange={({ account, reference }) =>
                update({ downPaymentAccount: account, downPaymentReference: reference })
              }
              referenceError={referenceError}
              align="end"
              testId="repair.desk.intake.downPaymentMethod"
            />
          </div>
        ) : null}
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
  const total = intakeTotal(draft.lines);
  const downPayment = intakeDownPayment(draft);
  const balance = balanceAfterDownPayment(total, downPayment);
  return (
    <aside
      className="@container sticky top-2 flex flex-col gap-4 self-start"
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
          <p className="tabular text-display font-bold text-text">{formatMoney(total)}</p>
          {/* An up-front payment above the total is refused beside the field, so nothing is owed back here. */}
          {downPayment > 0 && balance.kind === 'due' ? (
            <dl
              className="mt-1 flex flex-col gap-1 text-small"
              data-testid="repair.desk.intake.balance"
            >
              <div className="flex justify-between gap-3 text-text-muted">
                <dt>{tn('repair.price.downPayment')}</dt>
                <dd className="tabular">{formatMoney(-downPayment)}</dd>
              </div>
              <div className="flex justify-between gap-3 font-semibold text-text">
                <dt>{tn('repair.price.balance')}</dt>
                <dd className="tabular">{formatMoney(balance.amount)}</dd>
              </div>
            </dl>
          ) : null}
          <p className="text-small text-text-muted">
            {tn('repair.ticket.readyBy')}: {readyLabel(chosenReady(draft, options.readyBy))}
          </p>
          {flagged('price') ? (
            <p className="mt-1">{jump('price', tn('repair.desk.incomplete'))}</p>
          ) : null}
        </div>
        {/* The key goes under the button, not on it: on it, a narrow summary or a wider fallback
            font squeezed the label into it. */}
        <Tooltip label={tn('repair.action.openTicket')} shortcut={SAVE_KEYS}>
          <Button
            label={tn('repair.action.openTicket')}
            variant="primary"
            size="lg"
            className="mt-5 w-full"
            onClick={onSave}
            busy={busy}
            data-testid="repair.desk.intake.save"
          />
        </Tooltip>
        <p className="mt-2 flex justify-center">
          <Kbd>{SAVE_KEYS}</Kbd>
        </p>
      </div>
      {error}
    </aside>
  );
}
