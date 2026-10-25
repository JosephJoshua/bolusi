/**
 * IntakeWizard — the counter's one-sitting intake as six short steps: customer, device, condition,
 * the six photos, price and ready date, then a review that opens the ticket. Every step keeps its
 * input in one draft, published on each change so an idle lock never loses a half-done intake
 * (SEC-AUTH-08, the same retention notes uses) and released only when the user saves or discards.
 */
import { formatMoney, formatNumber, t } from '@bolusi/i18n';
import {
  Button,
  Card,
  Chip,
  ConfirmSheet,
  ListRow,
  PhotoSlot,
  SegmentedControl,
  StepHeader,
  TextInput,
  ToggleChip,
  color,
  space,
  type,
} from '@bolusi/ui';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { CHECKLIST_STATES, INTAKE_PHOTO_SLOTS, type ChecklistState } from '../constants.js';
import { useActionRunner, type DiscardGuard, type StepBack } from '../../screen-kit/index.js';

import { tn, type RepairKey } from './i18n.js';
import {
  INTAKE_SLOT_KEY,
  PRICE_KIND_KEY,
  READY_KEY,
  checkLabel,
  peripheralLabel,
} from './labels.js';
import {
  COMMON_BRANDS,
  INTAKE_CHECKS,
  INTAKE_STEPS,
  PERIPHERALS,
  READY_CHOICES,
  capturedThumbnailRef,
  emptyIntakeDraft,
  intakeDirty,
  intakeTotal,
  nextMissingPhoto,
  parseRupiah,
  restOfChecksOk,
  signedAmount,
  stepProblems,
  toOpenTicketInput,
  type IntakeDraft,
  type IntakeProblem,
  type IntakeStep,
  type QuoteLineDraft,
} from '../flows.js';
import type { IntakePhotoSlot } from '../constants.js';
import {
  Field,
  FlowScreen,
  PhotoGrid,
  PhotoThumb,
  Section,
  repairStyles,
  type RepairChrome,
} from './parts.js';
import { useRepairQuery, useRepairRuntime } from './runtime.js';
import { PRICE_KINDS, type PriceKind } from './TicketSteps.js';

const STEP_KEY: Readonly<Record<IntakeStep, RepairKey>> = {
  customer: 'repair.intake.step.customer',
  device: 'repair.intake.step.device',
  condition: 'repair.intake.step.condition',
  photos: 'repair.intake.step.photos',
  price: 'repair.intake.step.price',
  review: 'repair.intake.step.review',
};

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

const CHECK_STATE_KEY: Readonly<Record<ChecklistState, RepairKey>> = {
  ok: 'repair.condition.ok',
  issue: 'repair.condition.issue',
  not_checked: 'repair.condition.notChecked',
};

export interface IntakeWizardProps {
  readonly chrome: RepairChrome;
  /** ms epoch; the ready date is computed from it. */
  readonly now: number;
  readonly restoredDraft?: IntakeDraft | null | undefined;
  readonly onDraftChange?: ((draft: IntakeDraft | null) => void) | undefined;
  readonly onRegisterDiscardGuard?: ((guard: DiscardGuard | null) => void) | undefined;
  /** Hardware back moves one step back; at the first step it is the surface's leave (with confirm). */
  readonly onRegisterStepBack?: ((back: StepBack | null) => void) | undefined;
  readonly onOpened: (ticketId: string) => void;
  readonly onCancel: () => void;
  readonly testID?: string | undefined;
}

export function IntakeWizard({
  chrome,
  now,
  restoredDraft,
  onDraftChange,
  onRegisterDiscardGuard,
  onRegisterStepBack,
  onOpened,
  onCancel,
  testID = 'repair.intake',
}: IntakeWizardProps): React.JSX.Element {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const [draft, setDraft] = useState<IntakeDraft>(() => restoredDraft ?? emptyIntakeDraft());
  const [showProblems, setShowProblems] = useState(false);
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);

  const stepIndex = Math.min(draft.step, INTAKE_STEPS.length - 1);
  const step = INTAKE_STEPS[stepIndex]!;
  const problems = stepProblems(draft, step);
  const dirty = intakeDirty(draft);
  const update = (patch: Partial<IntakeDraft>): void => setDraft((d) => ({ ...d, ...patch }));

  // Write-through retention: every change, never on unmount (an unmount is what a lock looks like).
  useEffect(() => {
    onDraftChange?.(dirty ? draft : null);
  }, [dirty, draft, onDraftChange]);

  const requestLeave = (proceed: () => void): void => {
    if (!dirty) {
      onDraftChange?.(null);
      proceed();
      return;
    }
    setPendingLeave(() => proceed);
  };

  useEffect(() => {
    onRegisterDiscardGuard?.((proceed) => {
      if (!dirty) {
        onDraftChange?.(null);
        proceed();
        return;
      }
      setPendingLeave(() => proceed);
    });
    return () => onRegisterDiscardGuard?.(null);
  }, [dirty, onRegisterDiscardGuard, onDraftChange]);

  const goTo = (index: number): void => {
    setShowProblems(false);
    update({ step: index });
  };

  useEffect(() => {
    onRegisterStepBack?.(() => {
      if (stepIndex === 0) return false;
      goTo(stepIndex - 1);
      return true;
    });
    return () => onRegisterStepBack?.(null);
  });

  const takePhoto = (slot: IntakePhotoSlot): void => {
    void runner
      .run(() => runtime.capturePhoto({ title: tn(INTAKE_SLOT_KEY[slot]) }))
      .then((captured) => {
        if (captured === undefined || captured === null) return;
        setDraft((d) => ({ ...d, photos: { ...d.photos, [slot]: captured.mediaRef } }));
      });
  };
  // On the photos step the primary action walks round the phone: it takes the next missing shot.
  const missingPhoto = step === 'photos' ? nextMissingPhoto(draft) : null;

  const next = (): void => {
    if (missingPhoto !== null) {
      takePhoto(missingPhoto);
      return;
    }
    if (problems.length > 0) {
      setShowProblems(true);
      return;
    }
    if (step !== 'review') {
      goTo(stepIndex + 1);
      return;
    }
    void runner
      .run(() => runtime.run('openTicket', toOpenTicketInput(draft, now)))
      .then((opened) => {
        if (opened === undefined) return;
        onDraftChange?.(null);
        onOpened(opened.ticketId);
      });
  };

  const back = (): void => (stepIndex === 0 ? requestLeave(onCancel) : goTo(stepIndex - 1));
  const problemText = (problem: IntakeProblem): string | undefined =>
    showProblems && problems.includes(problem) ? tn(PROBLEM_KEY[problem]) : undefined;

  return (
    <FlowScreen
      chrome={chrome}
      title={tn('repair.action.newIntake')}
      onBack={back}
      primaryLabel={
        missingPhoto !== null
          ? tn('repair.photo.takeNext', { slot: tn(INTAKE_SLOT_KEY[missingPhoto]) })
          : step === 'review'
            ? tn('repair.action.openTicket')
            : tn('repair.action.next')
      }
      onPrimary={next}
      busy={runner.busy}
      errorCode={runner.errorCode}
      onClearError={runner.clearError}
      overlay={
        pendingLeave === null ? null : (
          <ConfirmSheet
            title={tn('repair.intake.discardTitle')}
            message={tn('repair.intake.discardMessage')}
            confirmLabel={tn('repair.intake.discard')}
            onConfirm={() => {
              const proceed = pendingLeave;
              setPendingLeave(null);
              onDraftChange?.(null);
              proceed();
            }}
            cancelLabel={tn('repair.intake.keepEditing')}
            onCancel={() => setPendingLeave(null)}
            testID={`${testID}.discard`}
          />
        )
      }
      testID={testID}
    >
      <StepHeader
        step={stepIndex + 1}
        total={INTAKE_STEPS.length}
        progressLabel={tn('repair.intake.progress', {
          step: stepIndex + 1,
          total: INTAKE_STEPS.length,
        })}
        title={tn(STEP_KEY[step])}
        testID={`${testID}.header`}
      />
      <View style={styles.body} testID={`${testID}.step.${step}`}>
        {renderStep()}
      </View>
      {showProblems && (step === 'photos' || step === 'price' || step === 'review') ? (
        <View style={repairStyles.gap}>
          {/* A line's own problem shows on its field, so only step-wide ones are listed here. */}
          {problems
            .filter((problem) => problem !== 'incompleteLine')
            .map((problem) => (
              <Text key={problem} style={styles.problem} testID={`${testID}.problem.${problem}`}>
                {tn(PROBLEM_KEY[problem])}
              </Text>
            ))}
        </View>
      ) : null}
    </FlowScreen>
  );

  function renderStep(): React.JSX.Element {
    switch (step) {
      case 'customer':
        return (
          <CustomerStep
            draft={draft}
            update={update}
            nameError={problemText('customerName')}
            testID={`${testID}.customer`}
          />
        );
      case 'device':
        return (
          <DeviceStep
            draft={draft}
            update={update}
            brandError={problemText('deviceBrand')}
            modelError={problemText('deviceModel')}
            testID={`${testID}.device`}
          />
        );
      case 'condition':
        return (
          <ConditionStep
            draft={draft}
            update={update}
            complaintError={problemText('complaint')}
            testID={`${testID}.condition`}
          />
        );
      case 'photos':
        return <PhotosStep draft={draft} onTake={takePhoto} testID={`${testID}.photos`} />;
      case 'price':
        return (
          <PriceStep
            draft={draft}
            update={update}
            lineError={problemText('incompleteLine')}
            testID={`${testID}.price`}
          />
        );
      case 'review':
        return <ReviewStep draft={draft} onEdit={goTo} testID={`${testID}.review`} />;
    }
  }
}

interface StepProps {
  readonly draft: IntakeDraft;
  readonly update: (patch: Partial<IntakeDraft>) => void;
  readonly testID: string;
}

/**
 * A new customer by name and phone, with existing customers whose name or phone fuzzily match
 * offered as the user types, so a returning customer is picked instead of entered twice.
 */
function CustomerStep({
  draft,
  update,
  nameError,
  testID,
}: StepProps & { readonly nameError: string | undefined }): React.JSX.Element {
  const customer = draft.customer;
  const searchText =
    customer.kind === 'new' ? [customer.name, customer.phone].join(' ').trim() : '';
  const matches = useRepairQuery(
    async (rt) =>
      searchText.length < 2
        ? []
        : (await rt.query('searchCustomers', { text: searchText, limit: 5 })).rows,
    `customers:${searchText}`,
  );

  if (customer.kind === 'existing') {
    return (
      <Card testID={`${testID}.picked`}>
        <Text style={repairStyles.heading}>{customer.name}</Text>
        {customer.phone === null ? null : <Text style={repairStyles.muted}>{customer.phone}</Text>}
        <View style={repairStyles.gap}>
          <Button
            label={tn('repair.customer.change')}
            variant="secondary"
            onPress={() => update({ customer: { kind: 'new', name: '', phone: '' } })}
            testID={`${testID}.change`}
          />
        </View>
      </Card>
    );
  }

  return (
    <View>
      <TextInput
        label={tn('repair.customer.name')}
        value={customer.name}
        onChangeText={(name) => update({ customer: { ...customer, name } })}
        errorMessage={nameError}
        autoFocus
        testID={`${testID}.name`}
      />
      <View style={repairStyles.gap}>
        <TextInput
          label={tn('repair.customer.phone')}
          placeholder={tn('repair.customer.phoneHint')}
          value={customer.phone}
          onChangeText={(phone) => update({ customer: { ...customer, phone } })}
          keyboardType="phone-pad"
          testID={`${testID}.phone`}
        />
      </View>
      {matches.status === 'ready' && matches.data.length > 0 ? (
        <Section title={tn('repair.customer.existing')} testID={`${testID}.matches`}>
          {matches.data.map((row) => (
            <ListRow
              key={row.id}
              primaryText={row.name}
              secondaryText={row.phone ?? undefined}
              onPress={() =>
                update({
                  customer: {
                    kind: 'existing',
                    customerId: row.id,
                    name: row.name,
                    phone: row.phone,
                  },
                })
              }
              testID={`${testID}.match.${row.id}`}
            />
          ))}
        </Section>
      ) : null}
    </View>
  );
}

function DeviceStep({
  draft,
  update,
  brandError,
  modelError,
  testID,
}: StepProps & {
  readonly brandError: string | undefined;
  readonly modelError: string | undefined;
}): React.JSX.Element {
  const device = draft.device;
  const set = (patch: Partial<IntakeDraft['device']>): void =>
    update({ device: { ...device, ...patch } });
  return (
    <View>
      <TextInput
        label={tn('repair.device.brand')}
        value={device.brand}
        onChangeText={(brand) => set({ brand })}
        errorMessage={brandError}
        autoFocus
        testID={`${testID}.brand`}
      />
      <View style={[styles.chips, styles.suggestions]}>
        {COMMON_BRANDS.map((brand) => (
          <ToggleChip
            key={brand}
            label={brand}
            selected={device.brand === brand}
            onToggle={() => set({ brand })}
            testID={`${testID}.brandChoice.${brand}`}
          />
        ))}
      </View>
      <View style={repairStyles.gap}>
        <TextInput
          label={tn('repair.device.model')}
          value={device.model}
          onChangeText={(model) => set({ model })}
          errorMessage={modelError}
          testID={`${testID}.model`}
        />
      </View>
      <View style={repairStyles.gap}>
        <TextInput
          label={tn('repair.device.colorField')}
          value={device.color}
          onChangeText={(color) => set({ color })}
          testID={`${testID}.color`}
        />
      </View>
      <View style={repairStyles.gap}>
        <TextInput
          label={tn('repair.device.imeiField')}
          value={device.imei}
          onChangeText={(imei) => set({ imei })}
          keyboardType="number-pad"
          testID={`${testID}.imei`}
        />
      </View>
      <View style={repairStyles.gap}>
        <TextInput
          label={tn('repair.device.passcode')}
          value={device.passcode}
          onChangeText={(passcode) => set({ passcode })}
          testID={`${testID}.passcode`}
        />
      </View>
    </View>
  );
}

function ConditionStep({
  draft,
  update,
  complaintError,
  testID,
}: StepProps & { readonly complaintError: string | undefined }): React.JSX.Element {
  const togglePeripheral = (item: string): void =>
    update({
      peripherals: draft.peripherals.includes(item)
        ? draft.peripherals.filter((p) => p !== item)
        : [...draft.peripherals, item],
    });
  return (
    <View>
      <TextInput
        label={tn('repair.condition.complaint')}
        value={draft.complaint}
        onChangeText={(complaint) => update({ complaint })}
        errorMessage={complaintError}
        multiline
        autoFocus
        testID={`${testID}.complaint`}
      />
      <Section
        title={tn('repair.condition.checks')}
        action={
          <Chip
            label={tn('repair.condition.restOk')}
            icon="check"
            onPress={() => update({ checks: restOfChecksOk(draft.checks) })}
            testID={`${testID}.restOk`}
          />
        }
      >
        {INTAKE_CHECKS.map((item) => (
          <View key={item} style={styles.check}>
            <Text style={repairStyles.body}>{checkLabel(item)}</Text>
            <SegmentedControl
              options={CHECKLIST_STATES.map((value) => ({
                value,
                label: tn(CHECK_STATE_KEY[value]),
              }))}
              value={draft.checks[item] ?? 'not_checked'}
              onChange={(state) => update({ checks: { ...draft.checks, [item]: state } })}
              testID={`${testID}.check.${item}`}
            />
          </View>
        ))}
      </Section>
      <Section title={tn('repair.condition.peripherals')}>
        <View style={styles.chips}>
          {PERIPHERALS.map((item) => (
            <ToggleChip
              key={item}
              label={peripheralLabel(item)}
              selected={draft.peripherals.includes(item)}
              onToggle={() => togglePeripheral(item)}
              testID={`${testID}.peripheral.${item}`}
            />
          ))}
        </View>
      </Section>
      <View style={repairStyles.gap}>
        <TextInput
          label={tn('repair.condition.notes')}
          value={draft.intakeNotes}
          onChangeText={(intakeNotes) => update({ intakeNotes })}
          multiline
          testID={`${testID}.notes`}
        />
      </View>
    </View>
  );
}

function PhotosStep({
  draft,
  onTake,
  testID,
}: {
  readonly draft: IntakeDraft;
  readonly onTake: (slot: IntakePhotoSlot) => void;
  readonly testID: string;
}): React.JSX.Element {
  return (
    <View>
      <Text style={repairStyles.muted}>{tn('repair.photo.intakeHint')}</Text>
      <View style={repairStyles.gap}>
        <PhotoGrid>
          {INTAKE_PHOTO_SLOTS.map((slot) => {
            const photo = draft.photos[slot];
            return (
              <View key={slot} style={repairStyles.gridCell}>
                <PhotoSlot
                  label={tn(INTAKE_SLOT_KEY[slot])}
                  actionLabel={tn(
                    photo === undefined ? 'repair.photo.take' : 'repair.photo.retake',
                  )}
                  image={
                    photo === undefined ? null : (
                      <PhotoThumb
                        photo={capturedThumbnailRef(photo)}
                        testID={`${testID}.thumb.${slot}`}
                      />
                    )
                  }
                  onPress={() => onTake(slot)}
                  testID={`${testID}.slot.${slot}`}
                />
              </View>
            );
          })}
        </PhotoGrid>
      </View>
    </View>
  );
}

const EMPTY_LINE: QuoteLineDraft = { kind: 'part', description: '', amount: 0 };

/** "650.000" for 650000, empty for nothing typed yet: the amount reads as the customer hears it. */
function amountText(amount: number): string {
  return amount === 0 ? '' : formatNumber(amount);
}

/**
 * Price lines edited where they stand, so nothing typed waits on a separate "add" press to count.
 * With no lines yet one empty line is shown; it joins the draft only once something is typed.
 */
function PriceStep({
  draft,
  update,
  lineError,
  testID,
}: StepProps & { readonly lineError: string | undefined }): React.JSX.Element {
  const lines = draft.lines.length === 0 ? [EMPTY_LINE] : draft.lines;
  const setLine = (index: number, patch: Partial<QuoteLineDraft>): void =>
    update({ lines: lines.map((line, i) => (i === index ? { ...line, ...patch } : line)) });

  return (
    <View>
      {lines.map((line, index) => (
        <View key={index} style={index === 0 ? undefined : repairStyles.gap}>
          <Card testID={`${testID}.line.${index}`}>
            <SegmentedControl
              options={PRICE_KINDS.map((value) => ({
                value,
                label: tn(PRICE_KIND_KEY[value]),
              }))}
              value={line.kind as PriceKind}
              onChange={(kind) => setLine(index, { kind })}
              testID={`${testID}.kind.${index}`}
            />
            <View style={repairStyles.gap}>
              <TextInput
                label={tn('repair.price.description')}
                value={line.description}
                onChangeText={(description) => setLine(index, { description })}
                errorMessage={
                  line.description.trim() === '' && line.amount !== 0 ? lineError : undefined
                }
                testID={`${testID}.description.${index}`}
              />
            </View>
            <View style={repairStyles.gap}>
              <TextInput
                label={tn('repair.price.amount')}
                value={amountText(line.amount)}
                onChangeText={(text) => setLine(index, { amount: parseRupiah(text) ?? 0 })}
                keyboardType="number-pad"
                testID={`${testID}.amount.${index}`}
              />
            </View>
            {lines.length > 1 ? (
              <View style={styles.remove}>
                <Chip
                  label={t('core.action.delete')}
                  icon="remove"
                  onPress={() => update({ lines: lines.filter((_, i) => i !== index) })}
                  testID={`${testID}.remove.${index}`}
                />
              </View>
            ) : null}
          </Card>
        </View>
      ))}
      <View style={repairStyles.gap}>
        <Button
          label={tn('repair.price.addRow')}
          variant="secondary"
          onPress={() => update({ lines: [...lines, EMPTY_LINE] })}
          testID={`${testID}.addRow`}
        />
      </View>
      <View style={[repairStyles.row, styles.total]}>
        <Text style={repairStyles.heading}>{tn('repair.price.total')}</Text>
        <Text style={repairStyles.heading} testID={`${testID}.total`}>
          {formatMoney(intakeTotal(draft.lines))}
        </Text>
      </View>
      <Section title={tn('repair.ticket.readyBy')}>
        <SegmentedControl
          options={READY_CHOICES.map((value) => ({ value, label: tn(READY_KEY[value]) }))}
          value={draft.ready}
          onChange={(ready) => update({ ready })}
          wrap
          testID={`${testID}.ready`}
        />
      </Section>
    </View>
  );
}

function ReviewStep({
  draft,
  onEdit,
  testID,
}: {
  readonly draft: IntakeDraft;
  readonly onEdit: (step: number) => void;
  readonly testID: string;
}): React.JSX.Element {
  const issues = INTAKE_CHECKS.filter((item) => draft.checks[item] === 'issue');
  const section = (step: IntakeStep, children: React.ReactNode): React.JSX.Element => (
    <Section
      title={tn(STEP_KEY[step])}
      action={
        <Chip
          label={t('core.action.edit')}
          icon="edit"
          onPress={() => onEdit(INTAKE_STEPS.indexOf(step))}
          testID={`${testID}.edit.${step}`}
        />
      }
    >
      {children}
    </Section>
  );
  return (
    <View>
      {section(
        'customer',
        <>
          <Text style={repairStyles.body} testID={`${testID}.customer`}>
            {draft.customer.name}
          </Text>
          {draft.customer.phone === null || draft.customer.phone === '' ? null : (
            <Text style={repairStyles.muted}>{draft.customer.phone}</Text>
          )}
        </>,
      )}
      {section(
        'device',
        <>
          <Text style={repairStyles.body} testID={`${testID}.device`}>
            {[draft.device.brand, draft.device.model, draft.device.color]
              .filter((s) => s.trim() !== '')
              .join(' ')}
          </Text>
          {draft.device.imei === '' ? null : (
            <Field label={tn('repair.device.imei')} value={draft.device.imei} />
          )}
        </>,
      )}
      {section(
        'condition',
        <>
          <Text style={repairStyles.body}>{draft.complaint}</Text>
          {issues.length === 0 ? null : (
            <Field
              label={tn('repair.condition.issues')}
              value={issues.map(checkLabel).join(', ')}
            />
          )}
          {draft.peripherals.length === 0 ? null : (
            <Field
              label={tn('repair.condition.peripherals')}
              value={draft.peripherals.map(peripheralLabel).join(', ')}
            />
          )}
        </>,
      )}
      {section(
        'photos',
        <PhotoGrid>
          {INTAKE_PHOTO_SLOTS.map((slot) => {
            const photo = draft.photos[slot];
            return photo === undefined ? null : (
              <View key={slot} style={repairStyles.gridCell}>
                <PhotoThumb
                  photo={capturedThumbnailRef(photo)}
                  testID={`${testID}.photo.${slot}`}
                />
              </View>
            );
          })}
        </PhotoGrid>,
      )}
      {section(
        'price',
        <>
          {draft.lines
            .filter((line) => line.description.trim() !== '')
            .map((line, index) => (
              <View key={index} style={[repairStyles.row, styles.reviewLine]}>
                <Text style={[repairStyles.body, repairStyles.rowText]}>
                  {`${tn(PRICE_KIND_KEY[line.kind])} · ${line.description}`}
                </Text>
                <Text style={repairStyles.body}>
                  {formatMoney(signedAmount(line.kind, line.amount))}
                </Text>
              </View>
            ))}
          <View style={[repairStyles.row, styles.reviewLine]}>
            <Text style={repairStyles.heading}>{tn('repair.price.total')}</Text>
            <Text style={repairStyles.heading} testID={`${testID}.total`}>
              {formatMoney(intakeTotal(draft.lines))}
            </Text>
          </View>
          <Field label={tn('repair.ticket.readyBy')} value={tn(READY_KEY[draft.ready])} />
        </>,
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { marginTop: space.lg },
  problem: { ...type.bodySm, color: color.danger, marginBottom: space.xs },
  check: { marginBottom: space.md },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  suggestions: { marginTop: space.sm },
  remove: { alignSelf: 'flex-end', marginTop: space.md },
  total: { marginTop: space.lg },
  reviewLine: { marginBottom: space.xs },
});
