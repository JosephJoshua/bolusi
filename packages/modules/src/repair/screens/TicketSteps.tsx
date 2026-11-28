/**
 * The full-screen steps a ticket action opens: work photos, a note or reason, picking a technician,
 * a price change and deciding a technician's proposal. Each runs one command, stays put with the
 * refusal shown when it fails, and calls `onDone` when it lands.
 */
import { formatMoney } from '@bolusi/i18n';
import {
  color,
  Icon,
  ListRow,
  numeric,
  PhotoSlot,
  radius,
  SegmentedControl,
  size,
  space,
  Text,
  TextButton,
  TextInput,
  TileGrid,
  ToggleChip,
  type,
} from '@bolusi/ui';
import type { MediaRef } from '@bolusi/schemas';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { WORK_PHOTOS_MAX, type WorkPhotoStage } from '../constants.js';
import { useChangeCancelFee, type CancelFeeTicket } from '../cancel-fee-ask.js';
import { useDownPaymentForm } from '../down-payment-form.js';
import { type QuoteLineRow, type TicketDetailRow } from '../queries.js';
import { useActionRunner, type DiscardGuard } from '../../screen-kit/index.js';
import { groupedRupiah } from '../../shared/rupiah.js';

import { useAssignTechnician } from '../assign-technician.js';
import { useCancelTicket } from '../cancel-ticket.js';
import { useRepairTypesPick } from '../repair-types-pick.js';
import { GradePicker } from './GradePicker.js';
import { useDecideProposal, usePriceChange } from '../price-change.js';
import { tn, type RepairKey } from '../i18n.js';
import { PRICE_KIND_KEY, optionLabel } from '../labels.js';
import {
  acceptsRupiahText,
  capturedThumbnailRef,
  parseRupiah,
  signedAmount,
  toggled,
  type PriceKind,
  type StaleStep,
} from '../flows.js';
import { FlowScreen, PhotoThumb, QueryView, repairStyles, type RepairChrome } from './parts.js';
import { useDiscardConfirm } from './discard.js';
import { useRepairRuntime } from '../runtime.js';
import { PaymentMethodField } from '../../money/screens/PaymentMethodField.js';

export interface StepProps {
  readonly chrome: RepairChrome;
  readonly ticketId: string;
  /** Set once the ticket changed elsewhere and this step can no longer finish. */
  readonly stale: StaleStep | null;
  readonly onDone: () => void;
  readonly onCancel: () => void;
  /** Lets hardware back ask before dropping photos this step has taken. */
  readonly onRegisterDiscardGuard?: ((guard: DiscardGuard | null) => void) | undefined;
}

// ── work photos ───────────────────────────────────────────────────────────────────────────────

const STAGE_COPY: Readonly<
  Record<WorkPhotoStage, { title: RepairKey; hint: RepairKey; shot: RepairKey; submit: RepairKey }>
> = {
  before: {
    title: 'repair.work.beforeTitle',
    hint: 'repair.work.beforeHint',
    shot: 'repair.work.beforeShot',
    submit: 'repair.action.start',
  },
  after: {
    title: 'repair.work.afterTitle',
    hint: 'repair.work.afterHint',
    shot: 'repair.work.afterShot',
    submit: 'repair.action.markRepaired',
  },
};

/**
 * Before photos to start work, or after photos (and a note) to mark it repaired. At least one photo
 * is required either way (owner decision, 2026-10-25).
 */
export function WorkPhotosStep({
  chrome,
  ticketId,
  stale,
  stage,
  onDone,
  onCancel,
  onRegisterDiscardGuard,
  testID = `repair.work.${stage}`,
}: StepProps & {
  readonly stage: WorkPhotoStage;
  readonly testID?: string | undefined;
}): React.JSX.Element {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const [photos, setPhotos] = useState<readonly MediaRef[]>([]);
  const [note, setNote] = useState('');
  const copy = STAGE_COPY[stage];
  const discard = useDiscardConfirm({
    // Nothing to keep once the step cannot finish: leaving it goes straight back.
    dirty: stale === null && (photos.length > 0 || note.trim() !== ''),
    onRegisterDiscardGuard,
    testID,
  });

  const takePhoto = (): void => {
    void runner
      .run(() => runtime.capturePhoto({ title: tn(copy.shot, { n: photos.length + 1 }) }))
      .then((captured) => {
        if (captured !== undefined && captured !== null)
          setPhotos((current) => [...current, captured.mediaRef]);
      });
  };

  const submit = (): void => {
    void runner
      .run(() =>
        stage === 'before'
          ? runtime.run('startWork', { ticketId, beforePhotos: [...photos] })
          : runtime.run('markRepaired', { ticketId, afterPhotos: [...photos], note }),
      )
      .then((result) => {
        if (result !== undefined) onDone();
      });
  };

  return (
    <FlowScreen
      chrome={chrome}
      title={tn(copy.title)}
      onBack={() => discard.requestLeave(onCancel)}
      primaryLabel={tn(copy.submit)}
      onPrimary={submit}
      primaryDisabled={photos.length === 0}
      primaryHint={tn('repair.hint.photo')}
      overlay={discard.overlay}
      busy={runner.busy}
      errorCode={runner.errorCode}
      stale={stale}
      onClearError={runner.clearError}
      testID={testID}
    >
      <Text style={repairStyles.muted}>{tn(copy.hint)}</Text>
      <View style={repairStyles.gap}>
        <TileGrid testID={`${testID}.grid`}>
          {photos.map((photo, index) => (
            <PhotoThumb
              key={photo.mediaId}
              photo={capturedThumbnailRef(photo)}
              testID={`${testID}.photo.${index}`}
            />
          ))}
          {photos.length < WORK_PHOTOS_MAX ? (
            <PhotoSlot
              key="take"
              label={tn(copy.shot, { n: photos.length + 1 })}
              image={null}
              actionLabel={tn('repair.photo.take')}
              onPress={takePhoto}
              testID={`${testID}.take`}
            />
          ) : null}
        </TileGrid>
      </View>
      {stage === 'after' ? (
        <View style={repairStyles.gap}>
          <TextInput
            label={tn('repair.work.repairNote')}
            value={note}
            onChangeText={setNote}
            multiline
            testID={`${testID}.note`}
          />
        </View>
      ) : null}
    </FlowScreen>
  );
}

// ── waiting for parts ─────────────────────────────────────────────────────────────────────

/** "Waiting for parts", with an optional note of which part. */
export function WaitForPartsStep({
  chrome,
  ticketId,
  stale,
  onDone,
  onCancel,
  onRegisterDiscardGuard,
  testID = 'repair.note.waitForParts',
}: StepProps & { readonly testID?: string | undefined }): React.JSX.Element {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const [text, setText] = useState('');
  const discard = useDiscardConfirm({
    dirty: stale === null && text.trim() !== '',
    onRegisterDiscardGuard,
    testID,
  });

  const submit = (): void => {
    void runner
      .run(() => runtime.run('markWaitingForParts', { ticketId, note: text }))
      .then((result) => {
        if (result !== undefined) onDone();
      });
  };

  return (
    <FlowScreen
      chrome={chrome}
      title={tn('repair.action.waitForParts')}
      onBack={() => discard.requestLeave(onCancel)}
      primaryLabel={tn('repair.action.waitForParts')}
      onPrimary={submit}
      overlay={discard.overlay}
      busy={runner.busy}
      errorCode={runner.errorCode}
      stale={stale}
      onClearError={runner.clearError}
      testID={testID}
    >
      <TextInput
        label={tn('repair.work.partsNote')}
        value={text}
        onChangeText={setText}
        multiline
        testID={`${testID}.text`}
      />
    </FlowScreen>
  );
}

// ── cancel (owners; the counter asks one) ─────────────────────────────────────────────────────

/**
 * Cancel a servisan: the store's fee for its stage is filled in, the owner may change it, and the
 * reason is always required. The fee is what the customer signs for at handover. Someone who may
 * not cancel, or not at a fee that far below the store's, asks an owner instead (`onAsked`).
 */
export function CancelStep({
  chrome,
  ticketId,
  stale,
  workStarted,
  price,
  claimOf,
  downPayment,
  discounted,
  onDone,
  onAsked,
  onCancel,
  onRegisterDiscardGuard,
  testID = 'repair.cancel',
}: StepProps & {
  readonly workStarted: boolean;
  /** The agreed repair price, which the store's fee never goes above. */
  readonly price: number;
  /** The discounts standing on the servisan, which a smaller fee counts with against a limit. */
  readonly discounted: number;
  /** Paid in so far: what is above the fee goes back at pickup. */
  readonly downPayment: number;
  /** The servisan this one is a warranty claim on, if it is one: then it is free to cancel. */
  readonly claimOf: string | null;
  readonly onAsked: () => void;
  readonly testID?: string | undefined;
}): React.JSX.Element {
  const [reason, setReason] = useState('');
  // Null until the owner taps "Ubah"; the store's fee applies until then.
  const [feeText, setFeeText] = useState<string | null>(null);
  const cancel = useCancelTicket(
    { ticketId, workStarted, price, claimOf, downPayment, discounted },
    { fee: feeText === null ? undefined : parseRupiah(feeText), reason },
    { onDone, onAsked },
  );
  const { runner, fees, standard, charged, changed, asking, room } = cancel;
  const discard = useDiscardConfirm({
    dirty: stale === null && (reason.trim() !== '' || feeText !== null),
    onRegisterDiscardGuard,
    testID,
  });
  const leave = (): void => discard.requestLeave(onCancel);

  return (
    <FlowScreen
      chrome={chrome}
      title={cancel.title}
      onBack={leave}
      primaryLabel={cancel.submitLabel}
      primaryVariant={asking ? 'primary' : 'destructive'}
      onPrimary={cancel.submit}
      overlay={discard.overlay}
      primaryDisabled={!cancel.complete}
      primaryHint={cancel.hint}
      busy={runner.busy}
      errorCode={runner.errorCode}
      stale={stale}
      onClearError={runner.clearError}
      testID={testID}
    >
      <Text style={[repairStyles.body, styles.consequence]} testID={`${testID}.consequence`}>
        {cancel.consequence}
      </Text>
      {cancel.askedBecause === null ? null : (
        <Text style={[repairStyles.caption, styles.consequence]} testID={`${testID}.asks`}>
          {cancel.askedBecause}
        </Text>
      )}
      <QueryView query={fees} onBack={leave} onRetry={cancel.retry} testID={`${testID}.fees`}>
        {() => (
          <View style={styles.proposal} testID={`${testID}.fee`}>
            <View style={styles.feeHeader}>
              <Text style={styles.feeLabel}>{tn('repair.cancel.fee')}</Text>
              {feeText === null ? (
                <View style={styles.feeAction}>
                  <TextButton
                    label={tn('repair.cancel.changeFee')}
                    accessibilityLabel={tn('repair.cancel.changeFeeLabel')}
                    onPress={() => setFeeText(groupedRupiah(String(standard ?? 0)))}
                    testID={`${testID}.changeFee`}
                  />
                </View>
              ) : null}
            </View>
            {/* Free is already said above ("HP dikembalikan tanpa biaya."), so no "Rp 0". */}
            {cancel.free ? null : (
              <Text style={styles.proposalAmount} testID={`${testID}.feeAmount`}>
                {charged === null ? '–' : formatMoney(charged)}
              </Text>
            )}
            <Text style={repairStyles.caption} testID={`${testID}.feeBasis`}>
              {cancel.feeBasis}
            </Text>
          </View>
        )}
      </QueryView>
      {feeText === null ? null : (
        <View style={repairStyles.gap}>
          <TextInput
            label={tn('repair.cancel.feeInput')}
            value={feeText}
            onChangeText={(text) => {
              if (acceptsRupiahText(text)) setFeeText(groupedRupiah(text));
            }}
            keyboardType="number-pad"
            selectTextOnFocus
            autoFocus
            testID={`${testID}.feeInput`}
          />
          {room === null ? null : (
            <Text style={repairStyles.caption} testID={`${testID}.limit`}>
              {tn('repair.hint.cancelLimit', { amount: formatMoney(room) })}
            </Text>
          )}
        </View>
      )}
      <View style={repairStyles.gap}>
        <TextInput
          label={tn('repair.cancel.reason')}
          value={reason}
          onChangeText={setReason}
          multiline
          testID={`${testID}.reason`}
        />
        {changed ? (
          <Text style={repairStyles.caption} testID={`${testID}.feeChangedHint`}>
            {tn('repair.cancel.feeChangedHint')}
          </Text>
        ) : null}
      </View>
    </FlowScreen>
  );
}

// ── undo a handover (owners) ──────────────────────────────────────────────────────────────────

/** Take back a handover recorded by mistake: the phone is in the store again. A reason is required. */
export function UndoHandoverStep({
  chrome,
  ticketId,
  stale,
  onDone,
  onCancel,
  onRegisterDiscardGuard,
  testID = 'repair.undoHandover',
}: StepProps & { readonly testID?: string | undefined }): React.JSX.Element {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const [reason, setReason] = useState('');
  const complete = reason.trim() !== '';
  const discard = useDiscardConfirm({
    dirty: stale === null && complete,
    onRegisterDiscardGuard,
    testID,
  });
  const submit = (): void => {
    if (!complete) return;
    void runner
      .run(() => runtime.run('undoHandover', { ticketId, reason }))
      .then((result) => {
        if (result !== undefined) onDone();
      });
  };
  return (
    <FlowScreen
      chrome={chrome}
      title={tn('repair.undoHandover.title')}
      onBack={() => discard.requestLeave(onCancel)}
      primaryLabel={tn('repair.action.undoHandover')}
      primaryVariant="destructive"
      onPrimary={submit}
      primaryDisabled={!complete}
      primaryHint={tn('repair.hint.reason')}
      overlay={discard.overlay}
      busy={runner.busy}
      errorCode={runner.errorCode}
      stale={stale}
      onClearError={runner.clearError}
      testID={testID}
    >
      <Text style={[repairStyles.body, styles.consequence]} testID={`${testID}.explain`}>
        {tn('repair.undoHandover.explain')}
      </Text>
      <TextInput
        label={tn('repair.undoHandover.reason')}
        value={reason}
        onChangeText={setReason}
        multiline
        testID={`${testID}.reason`}
      />
    </FlowScreen>
  );
}

// ── a cancelled servisan's fee (owners) ───────────────────────────────────────────────────────

/**
 * Change what a cancelled servisan costs, before or after pickup, with the reason on record. What
 * the customer owes follows the new fee; `paid` is what they paid so far, so the owner sees what a
 * fee charges or leaves to give back.
 */
export function ChangeCancelFeeStep({
  chrome,
  stale,
  ticket,
  current,
  paid,
  onDone,
  onAsked,
  onCancel,
  onRegisterDiscardGuard,
  testID = 'repair.cancelFee',
}: StepProps & {
  readonly ticket: CancelFeeTicket;
  readonly current: number;
  readonly paid: number;
  /** A manager beyond their limit asked an owner instead. */
  readonly onAsked: () => void;
  readonly testID?: string | undefined;
}): React.JSX.Element {
  const [feeText, setFeeText] = useState(groupedRupiah(String(current)));
  const [reason, setReason] = useState('');
  const form = useChangeCancelFee(
    { ticket, current, paid },
    { fee: parseRupiah(feeText), reason },
    { onDone, onAsked },
  );
  const discard = useDiscardConfirm({
    dirty: stale === null && form.dirty,
    onRegisterDiscardGuard,
    testID,
  });
  return (
    <FlowScreen
      chrome={chrome}
      title={tn('repair.cancelFee.title')}
      onBack={() => discard.requestLeave(onCancel)}
      primaryLabel={form.submitLabel}
      onPrimary={form.submit}
      primaryDisabled={!form.complete}
      primaryHint={form.hint}
      overlay={discard.overlay}
      busy={form.runner.busy}
      errorCode={form.runner.errorCode}
      stale={stale}
      onClearError={form.runner.clearError}
      testID={testID}
    >
      <Text style={[repairStyles.body, styles.consequence]} testID={`${testID}.explain`}>
        {form.explain}
      </Text>
      {form.askedBecause === null ? null : (
        <Text style={[repairStyles.caption, styles.consequence]} testID={`${testID}.asks`}>
          {form.askedBecause}
        </Text>
      )}
      <TextInput
        label={tn('repair.cancelFee.input')}
        value={feeText}
        onChangeText={(text) => {
          if (acceptsRupiahText(text)) setFeeText(groupedRupiah(text));
        }}
        keyboardType="number-pad"
        selectTextOnFocus
        autoFocus
        testID={`${testID}.feeInput`}
      />
      <View style={repairStyles.gap}>
        <TextInput
          label={tn('repair.cancelFee.reason')}
          value={reason}
          onChangeText={setReason}
          multiline
          testID={`${testID}.reason`}
        />
      </View>
    </FlowScreen>
  );
}

// ── down payment ──────────────────────────────────────────────────────────────────────────────

/**
 * Record a down payment taken after intake, or (owners) change one already recorded, with the
 * reason on record. `total` is what the customer owes, so the step can say what is left.
 */
export function DownPaymentStep({
  chrome,
  ticketId,
  stale,
  mode,
  current,
  total,
  onDone,
  onAsked,
  onCancel,
  onRegisterDiscardGuard,
  testID = 'repair.downPayment',
}: StepProps & {
  readonly mode: 'record' | 'correct';
  /** The down payment recorded now; null when none is. */
  readonly current: number | null;
  readonly total: number;
  /** A fix beyond this person was asked of an owner instead. */
  readonly onAsked: () => void;
  readonly testID?: string | undefined;
}): React.JSX.Element {
  // Empty even when correcting: the recorded amount is shown above, and the step asks for a new one.
  const [amountText, setAmountText] = useState('');
  const [reason, setReason] = useState('');
  const form = useDownPaymentForm(
    { ticketId, mode, current, total },
    { typed: parseRupiah(amountText), reason },
    { onDone, onAsked },
  );
  const discard = useDiscardConfirm({
    dirty: stale === null && (amountText !== '' || reason.trim() !== ''),
    onRegisterDiscardGuard,
    testID,
  });
  const { correcting } = form;

  return (
    <FlowScreen
      chrome={chrome}
      title={form.title}
      onBack={() => discard.requestLeave(onCancel)}
      primaryLabel={form.submitLabel}
      onPrimary={form.submit}
      overlay={discard.overlay}
      primaryDisabled={!form.complete}
      primaryHint={form.gapHint ?? undefined}
      busy={form.runner.busy}
      errorCode={form.runner.errorCode}
      stale={stale}
      onClearError={form.runner.clearError}
      testID={testID}
    >
      {correcting && current !== null ? (
        <View style={styles.proposal} testID={`${testID}.current`}>
          <Text style={styles.feeLabel}>{tn('repair.downPayment.current')}</Text>
          <Text style={styles.proposalAmount}>{formatMoney(current)}</Text>
        </View>
      ) : null}
      <View style={correcting ? repairStyles.gap : undefined}>
        <TextInput
          label={tn(correcting ? 'repair.downPayment.newAmount' : 'repair.downPayment.amount')}
          value={amountText}
          onChangeText={(text) => {
            if (acceptsRupiahText(text)) setAmountText(groupedRupiah(text));
          }}
          keyboardType="number-pad"
          selectTextOnFocus
          autoFocus
          errorMessage={form.aboveTotal ? tn('repair.problem.downPaymentAboveTotal') : undefined}
          testID={`${testID}.amount`}
        />
        <Text style={repairStyles.caption} testID={`${testID}.total`}>
          {tn('repair.downPayment.ofTotal', { amount: formatMoney(total) })}
        </Text>
      </View>
      {form.asksMethod ? (
        <View style={repairStyles.gap}>
          <PaymentMethodField
            accounts={form.accounts}
            account={form.method.account}
            reference={form.method.reference}
            onChange={form.setMethod}
            testID={`${testID}.method`}
          />
          {form.changeLine === null ? null : (
            <Text style={repairStyles.caption} testID={`${testID}.change`}>
              {form.changeLine}
            </Text>
          )}
        </View>
      ) : null}
      {correcting ? (
        <View style={repairStyles.gap}>
          <TextInput
            label={tn('repair.downPayment.reason')}
            value={reason}
            onChangeText={setReason}
            multiline
            testID={`${testID}.reason`}
          />
          <Text style={repairStyles.caption}>{tn('repair.downPayment.removeHint')}</Text>
          {form.limitLine === null ? null : (
            <Text style={repairStyles.caption} testID={`${testID}.limit`}>
              {form.limitLine}
            </Text>
          )}
          {form.withEarlierLine === null ? null : (
            <Text style={repairStyles.caption} testID={`${testID}.withEarlier`}>
              {form.withEarlierLine}
            </Text>
          )}
          {form.askedBecause === null ? null : (
            <Text style={repairStyles.caption} testID={`${testID}.asks`}>
              {form.askedBecause}
            </Text>
          )}
        </View>
      ) : null}
    </FlowScreen>
  );
}

// ── repair types ──────────────────────────────────────────────────────────────────────────────

/**
 * What is being repaired, changed once the diagnosis shows it: the store's types as chips, with the
 * ones the servisan has picked. Saving with none picked is allowed: the counter may not know yet.
 */
export function RepairTypesStep({
  chrome,
  ticketId,
  stale,
  current,
  onDone,
  onCancel,
  testID = 'repair.repairTypes',
}: StepProps & {
  readonly current: TicketDetailRow['repairTypes'];
  readonly testID?: string | undefined;
}): React.JSX.Element {
  const {
    runner,
    settings,
    choices,
    picked,
    setPicked,
    questions,
    grades,
    pickGrade,
    gradeError,
    submit,
  } = useRepairTypesPick({ ticketId, current }, { onDone, onUnchanged: onCancel });
  return (
    <FlowScreen
      chrome={chrome}
      title={tn('repair.repairTypes.title')}
      onBack={onCancel}
      primaryLabel={tn('repair.repairTypes.save')}
      onPrimary={submit}
      busy={runner.busy}
      errorCode={runner.errorCode}
      stale={stale}
      onClearError={runner.clearError}
      testID={testID}
    >
      <QueryView
        query={settings}
        onBack={onCancel}
        onRetry={() => undefined}
        testID={`${testID}.options`}
      >
        {() => (
          <View>
            <View style={repairStyles.chips} testID={`${testID}.chips`}>
              {choices.map((option) => (
                <ToggleChip
                  key={option.id}
                  label={optionLabel('repairTypes', option)}
                  selected={picked.includes(option.id)}
                  onToggle={() => setPicked((ids) => toggled(ids, option.id))}
                  testID={`${testID}.type.${option.id}`}
                />
              ))}
            </View>
            <GradePicker
              questions={questions}
              picks={grades}
              onPick={pickGrade}
              error={gradeError ? tn('repair.problem.grade') : undefined}
              testID={`${testID}.grade`}
            />
            <Text style={[repairStyles.caption, repairStyles.gap]}>
              {tn('repair.warranty.fromPickup')}
            </Text>
          </View>
        )}
      </QueryView>
    </FlowScreen>
  );
}

// ── assign ────────────────────────────────────────────────────────────────────────────────────

export function AssignStep({
  chrome,
  ticketId,
  stale,
  currentTechnicianId,
  onDone,
  onCancel,
  testID = 'repair.assign',
}: StepProps & {
  readonly currentTechnicianId: string | null;
  readonly testID?: string | undefined;
}): React.JSX.Element {
  const { runner, technicians, retry, assign } = useAssignTechnician(
    { ticketId, currentTechnicianId },
    onDone,
  );

  return (
    <FlowScreen
      chrome={chrome}
      title={tn(currentTechnicianId === null ? 'repair.action.assign' : 'repair.action.reassign')}
      onBack={onCancel}
      busy={runner.busy}
      errorCode={runner.errorCode}
      stale={stale}
      onClearError={runner.clearError}
      testID={testID}
    >
      <QueryView query={technicians} onBack={onCancel} onRetry={retry} testID={`${testID}.list`}>
        {(rows) =>
          rows.length === 0 ? (
            <Text style={repairStyles.muted} testID={`${testID}.none`}>
              {tn('repair.assign.none')}
            </Text>
          ) : (
            rows.map((tech) => (
              <ListRow
                key={tech.id}
                primaryText={tech.name}
                secondaryText={tn('repair.assign.load', { count: tech.load })}
                trailing={
                  tech.id === currentTechnicianId ? (
                    <Icon name="check" size={size.iconInline} color={color.success} />
                  ) : undefined
                }
                onPress={() => assign(tech.id)}
                testID={`${testID}.row.${tech.id}`}
              />
            ))
          )
        }
      </QueryView>
    </FlowScreen>
  );
}

// ── price changes ─────────────────────────────────────────────────────────────────────────────

export { PRICE_KINDS, type PriceKind } from '../flows.js';

/**
 * The kinds this user may add: a discount lowers the price, so only owners see it, unless the
 * user may ask one (`askable`).
 */
/**
 * A new price line after intake. The cashier changes the price directly, answering whether the
 * customer agreed as the save itself (as on a proposal, so it cannot be skipped by not noticing a
 * toggle); a technician only proposes it for the cashier to decide. A discount the cashier may not
 * give (or not that large) goes to an owner instead (`onAsked`), and asks the customer once it is
 * approved.
 */
export function PriceChangeStep({
  chrome,
  ticketId,
  stale,
  mode,
  discounted,
  onDone,
  onAsked,
  onCancel,
  onRegisterDiscardGuard,
  testID = `repair.price.${mode}`,
}: StepProps & {
  readonly mode: 'change' | 'propose';
  /** What the discounts already on the servisan take off; a limit counts them too. */
  readonly discounted: number;
  /** Set where a discount may be asked of an owner (changing the price, not proposing it). */
  readonly onAsked?: (() => void) | undefined;
  readonly testID?: string | undefined;
}): React.JSX.Element {
  const [kind, setKind] = useState<PriceKind>('part');
  const [description, setDescription] = useState('');
  const [amountText, setAmountText] = useState('');
  const [reason, setReason] = useState('');
  const amount = parseRupiah(amountText);
  const form = usePriceChange(
    { ticketId, mode, discounted },
    { kind, description, amount, reason },
    { onDone, onAsked },
  );
  const discard = useDiscardConfirm({
    dirty:
      stale === null && (description.trim() !== '' || amountText !== '' || reason.trim() !== ''),
    onRegisterDiscardGuard,
    testID,
  });

  return (
    <FlowScreen
      chrome={chrome}
      title={form.title}
      onBack={() => discard.requestLeave(onCancel)}
      overlay={discard.overlay}
      question={form.deciding ? tn('repair.price.alreadyAgreed') : undefined}
      primaryLabel={form.deciding ? tn('repair.action.agreedYes') : form.sendLabel}
      onPrimary={() => form.submit(true)}
      secondary={
        form.deciding
          ? {
              label: tn('repair.action.applyUnconfirmed'),
              onPress: () => form.submit(false),
              disabled: !form.complete,
              testID: `${testID}.unconfirmed`,
            }
          : undefined
      }
      primaryDisabled={!form.complete}
      primaryHint={tn('repair.hint.priceLine')}
      busy={form.runner.busy}
      errorCode={form.runner.errorCode}
      stale={stale}
      onClearError={form.runner.clearError}
      testID={testID}
    >
      <SegmentedControl
        options={form.kinds.map((value) => ({ value, label: tn(PRICE_KIND_KEY[value]) }))}
        value={kind}
        onChange={setKind}
        size="compact"
        testID={`${testID}.kind`}
      />
      <View style={repairStyles.gap}>
        <TextInput
          label={tn('repair.price.description')}
          value={description}
          onChangeText={setDescription}
          testID={`${testID}.description`}
        />
      </View>
      <View style={repairStyles.gap}>
        <TextInput
          label={tn(kind === 'discount' ? 'repair.price.discountAmount' : 'repair.price.amount')}
          value={amountText}
          onChangeText={(text) => {
            if (acceptsRupiahText(text)) setAmountText(groupedRupiah(text));
          }}
          keyboardType="number-pad"
          selectTextOnFocus
          testID={`${testID}.amount`}
        />
        {amount === null ? null : (
          <Text style={repairStyles.caption} testID={`${testID}.amountPreview`}>
            {formatMoney(signedAmount(kind, amount))}
          </Text>
        )}
        {form.limitLine === null ? null : (
          <Text style={repairStyles.caption} testID={`${testID}.discountLimit`}>
            {form.limitLine}
          </Text>
        )}
      </View>
      <View style={repairStyles.gap}>
        <TextInput
          label={tn('repair.price.reason')}
          value={reason}
          onChangeText={setReason}
          multiline
          testID={`${testID}.reason`}
        />
      </View>
      {form.askedBecause !== null ? (
        <Text style={[repairStyles.caption, repairStyles.gap]} testID={`${testID}.asks`}>
          {form.askedBecause}
        </Text>
      ) : mode === 'change' ? (
        // Agreement often comes later, by phone; saying so keeps "Belum" from reading as a dead end.
        <Text style={[repairStyles.caption, repairStyles.gap]} testID={`${testID}.waitsHint`}>
          {tn('repair.price.waitsHint')}
        </Text>
      ) : null}
    </FlowScreen>
  );
}

/**
 * The counter decides a waiting price change, a technician's proposal or its own, with the
 * customer's answer as the choice itself: agreed and applied, or declined. A change never counts
 * without the customer's yes.
 */
export function ProposalStep({
  chrome,
  ticketId,
  stale,
  line,
  total,
  onDone,
  onCancel,
  onRegisterDiscardGuard,
  testID = 'repair.proposal',
}: StepProps & {
  readonly line: QuoteLineRow;
  /** The agreed total now, so the change reads as what the customer will pay. */
  readonly total: number;
  readonly testID?: string | undefined;
}): React.JSX.Element {
  const [note, setNote] = useState('');
  const { runner, mayApply, decide } = useDecideProposal({ ticketId, line }, note, onDone);
  const discard = useDiscardConfirm({
    dirty: stale === null && note.trim() !== '',
    onRegisterDiscardGuard,
    testID,
  });

  return (
    <FlowScreen
      chrome={chrome}
      title={tn('repair.price.proposalTitle')}
      onBack={() => discard.requestLeave(onCancel)}
      overlay={discard.overlay}
      question={tn('repair.price.customerAgrees')}
      primaryLabel={tn('repair.action.agreeApply')}
      onPrimary={() => decide('agreed')}
      primaryDisabled={!mayApply}
      primaryHint={mayApply ? undefined : tn('repair.hint.discountOwner')}
      secondary={{
        label: tn('repair.action.declinePrice'),
        onPress: () => decide('declined'),
        testID: `${testID}.decline`,
      }}
      busy={runner.busy}
      errorCode={runner.errorCode}
      stale={stale}
      onClearError={runner.clearError}
      testID={testID}
    >
      <View style={styles.proposal}>
        <Text style={repairStyles.caption}>{tn(PRICE_KIND_KEY[line.kind])}</Text>
        <Text style={styles.proposalDescription}>{line.description}</Text>
        <Text style={styles.proposalAmount} testID={`${testID}.amount`}>
          {formatMoney(line.amount)}
        </Text>
        {/* An extra zero shows here, where the customer hears it: 1.500.000 → 3.500.000. */}
        <Text style={repairStyles.body} testID={`${testID}.newTotal`}>
          {tn('repair.price.newTotal', {
            from: formatMoney(total),
            to: formatMoney(total + line.amount),
          })}
        </Text>
        {line.reason === null ? null : (
          <>
            <Text style={styles.proposalLabel}>{tn('repair.price.changeReason')}</Text>
            <Text style={styles.proposalReason}>{line.reason}</Text>
          </>
        )}
      </View>
      <View style={repairStyles.gap}>
        <TextInput
          label={tn('repair.price.decisionNote')}
          value={note}
          onChangeText={setNote}
          testID={`${testID}.note`}
        />
      </View>
    </FlowScreen>
  );
}

const styles = StyleSheet.create({
  proposal: {
    padding: space.md,
    borderRadius: radius.sm,
    backgroundColor: color.surfaceAlt,
  },
  proposalDescription: { ...type.bodyBold, color: color.text, marginTop: space.xs },
  proposalAmount: {
    ...type.title,
    color: color.text,
    marginTop: space.xs,
    ...numeric,
  },
  proposalLabel: { ...type.caption, color: color.textMuted, marginTop: space.md },
  proposalReason: { ...type.bodySm, color: color.text },
  consequence: { marginBottom: space.md },
  // The caption and its link share one centre line; the link's text lines up with the box's right
  // edge, not its padded hit box, which may overhang the box's padding.
  feeHeader: { flexDirection: 'row', alignItems: 'center' },
  feeLabel: { ...type.caption, color: color.textMuted },
  feeAction: { marginLeft: 'auto', marginRight: -space.sm, marginVertical: -space.md },
});
