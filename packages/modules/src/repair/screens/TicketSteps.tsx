/**
 * The full-screen steps a ticket action opens: work photos, a note or reason, picking a technician,
 * a price change and deciding a technician's proposal. Each runs one command, stays put with the
 * refusal shown when it fails, and calls `onDone` when it lands.
 */
import { formatMoney, formatNumber } from '@bolusi/i18n';
import {
  ListRow,
  PhotoSlot,
  SegmentedControl,
  TextInput,
  Icon,
  TextButton,
  ToggleChip,
  color,
  radius,
  size,
  space,
  type,
  Text,
} from '@bolusi/ui';
import type { MediaRef } from '@bolusi/schemas';
import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  REPAIR_APPROVAL_KIND,
  REPAIR_PERMISSION,
  WORK_PHOTOS_MAX,
  type WorkPhotoStage,
} from '../constants.js';
import { useCancelFeeAsk, type CancelFeeTicket } from '../cancel-fee-ask.js';
import { useDownPaymentAsk } from '../down-payment-ask.js';
import { repairTypeChoices, storeIntakeOptions } from '../intake-options.js';
import {
  cancelDrop,
  cancelRoom,
  standardCancelFee,
  type QuoteLineRow,
  type TicketDetailRow,
} from '../queries.js';
import { useActionRunner, type DiscardGuard } from '../../screen-kit/index.js';

import { tn, type RepairKey } from '../i18n.js';
import {
  DOWN_PAYMENT_GAP_KEY,
  PRICE_KIND_KEY,
  discountLimitHint,
  downPaymentChangeLine,
  downPaymentTitleKey,
  optionLabel,
} from '../labels.js';
import {
  acceptsRupiahText,
  askedBecauseKey,
  asksApproval,
  capturedThumbnailRef,
  downPaymentEntry,
  parseRupiah,
  priceKinds,
  signedAmount,
  toggled,
  type PriceKind,
  type StaleStep,
  cancelRefund,
} from '../flows.js';
import {
  FlowScreen,
  PhotoGrid,
  PhotoThumb,
  QueryView,
  repairStyles,
  type RepairChrome,
  usePhotoGridCell,
} from './parts.js';
import { useDiscardConfirm } from './discard.js';
import { ta } from '../../approvals/i18n.js';
import {
  useCancelFees,
  useIntakeOptionSettings,
  useDownPaymentMethod,
  usePaymentAccounts,
  useRepairQuery,
  useRepairRuntime,
} from '../runtime.js';
import { accountLabel } from '../../money/kas.js';
import {
  chosenMethod,
  methodMissing,
  offeredAccount,
  referenceMissing,
} from '../../money/payment-entry.js';
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
  const gridCell = usePhotoGridCell();
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
        <PhotoGrid>
          {photos.map((photo, index) => (
            <View key={photo.mediaId} style={gridCell}>
              <PhotoThumb photo={capturedThumbnailRef(photo)} testID={`${testID}.photo.${index}`} />
            </View>
          ))}
          {photos.length < WORK_PHOTOS_MAX ? (
            <View style={gridCell}>
              <PhotoSlot
                label={tn(copy.shot, { n: photos.length + 1 })}
                image={null}
                actionLabel={tn('repair.photo.take')}
                onPress={takePhoto}
                testID={`${testID}.take`}
              />
            </View>
          ) : null}
        </PhotoGrid>
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
  /** The discounts standing on the servisan, which a smaller fee counts with against a limit. */
  readonly discounted: number;
  /** Paid in so far: what is above the fee goes back at pickup. */
  readonly downPayment: number;
  /** The servisan this one is a warranty claim on, if it is one: then it is free to cancel. */
  readonly claimOf: string | null;
  readonly onAsked: () => void;
  readonly testID?: string | undefined;
}): React.JSX.Element {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const [reloadNonce, setReloadNonce] = useState(0);
  const fees = useCancelFees(reloadNonce);
  const [reason, setReason] = useState('');
  // Null until the owner taps "Ubah"; the store's fee applies until then.
  const [feeText, setFeeText] = useState<string | null>(null);
  const discard = useDiscardConfirm({
    dirty: stale === null && (reason.trim() !== '' || feeText !== null),
    onRegisterDiscardGuard,
    testID,
  });
  const leave = (): void => discard.requestLeave(onCancel);

  const standard =
    fees.status === 'ready'
      ? standardCancelFee({ workStarted, claimOfTicketId: claimOf }, fees.data)
      : null;
  const fee = feeText === null ? standard : parseRupiah(feeText);
  const changed = standard !== null && fee !== null && fee !== standard;
  const complete = fee !== null && reason.trim() !== '';
  const holds = runtime.hasPermission(REPAIR_PERMISSION.cancel);
  // A limited role (a manager) sees how far below the store's fee they may go before it is asked.
  const limit = holds ? runtime.limitOf(REPAIR_PERMISSION.cancel) : null;
  const asking = asksApproval(
    holds,
    limit,
    standard === null || fee === null ? 0 : cancelDrop(standard, fee, discounted),
  );
  const room = cancelRoom(limit, standard, discounted);

  const submit = (): void => {
    if (fee === null || !complete) return;
    // An unchanged fee is left to the command, which fills in the store's fee as it is then.
    const input = feeText === null ? { ticketId, reason } : { ticketId, reason, fee };
    void runner
      .run<unknown>(() =>
        asking
          ? runtime.approvals.run('requestApproval', {
              kind: REPAIR_APPROVAL_KIND.cancel,
              input,
              reason,
            })
          : runtime.run('cancelTicket', input),
      )
      .then((result) => {
        if (result !== undefined) (asking ? onAsked : onDone)();
      });
  };

  return (
    <FlowScreen
      chrome={chrome}
      title={tn(holds ? 'repair.cancel.title' : 'repair.approval.askCancel')}
      onBack={leave}
      primaryLabel={asking ? ta('approvals.action.ask') : tn('repair.action.cancel')}
      primaryVariant={asking ? 'primary' : 'destructive'}
      onPrimary={submit}
      overlay={discard.overlay}
      primaryDisabled={!complete}
      primaryHint={tn(
        feeText !== null && fee === null ? 'repair.hint.cancelFee' : 'repair.hint.reason',
      )}
      busy={runner.busy}
      errorCode={runner.errorCode}
      stale={stale}
      onClearError={runner.clearError}
      testID={testID}
    >
      <Text style={[repairStyles.body, styles.consequence]} testID={`${testID}.consequence`}>
        {cancelRefund(downPayment, fee) > 0
          ? tn('repair.cancel.refundsDp', { amount: formatMoney(cancelRefund(downPayment, fee)) })
          : tn('repair.cancel.consequence')}
      </Text>
      {asking ? (
        <Text style={[repairStyles.caption, styles.consequence]} testID={`${testID}.asks`}>
          {tn(askedBecauseKey(holds))}
        </Text>
      ) : null}
      <QueryView
        query={fees}
        onBack={leave}
        onRetry={() => setReloadNonce((n) => n + 1)}
        testID={`${testID}.fees`}
      >
        {() => (
          <View style={styles.proposal} testID={`${testID}.fee`}>
            <View style={styles.feeHeader}>
              <Text style={styles.feeLabel}>{tn('repair.cancel.fee')}</Text>
              {feeText === null ? (
                <View style={styles.feeAction}>
                  <TextButton
                    label={tn('repair.cancel.changeFee')}
                    accessibilityLabel={tn('repair.cancel.changeFeeLabel')}
                    onPress={() => setFeeText(groupedAmount(String(standard ?? 0)))}
                    testID={`${testID}.changeFee`}
                  />
                </View>
              ) : null}
            </View>
            <Text style={styles.proposalAmount} testID={`${testID}.feeAmount`}>
              {fee === null ? '–' : formatMoney(fee)}
            </Text>
            <Text style={repairStyles.caption} testID={`${testID}.feeBasis`}>
              {changed
                ? tn('repair.cancel.storeFee', { amount: formatMoney(standard) })
                : tn(
                    claimOf !== null
                      ? 'repair.cancel.claimFree'
                      : workStarted
                        ? 'repair.cancel.afterWork'
                        : 'repair.cancel.beforeWork',
                  )}
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
              if (acceptsRupiahText(text)) setFeeText(groupedAmount(text));
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
  ticketId,
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
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const [feeText, setFeeText] = useState(groupedAmount(String(current)));
  const [reason, setReason] = useState('');
  const fee = parseRupiah(feeText);
  const changed = fee !== null && fee !== current;
  const complete = changed && reason.trim() !== '';
  const ask = useCancelFeeAsk(ticket, current, changed ? fee : null);
  const discard = useDiscardConfirm({
    dirty: stale === null && (changed || reason.trim() !== ''),
    onRegisterDiscardGuard,
    testID,
  });
  const submit = (): void => {
    if (fee === null || !complete) return;
    const asking = ask.asking;
    void runner
      .run<unknown>(() =>
        asking
          ? runtime.approvals.run('requestApproval', ask.request(reason.trim()))
          : runtime.run('changeCancelFee', { ticketId, fee, reason }),
      )
      .then((result) => {
        if (result !== undefined) (asking ? onAsked : onDone)();
      });
  };
  return (
    <FlowScreen
      chrome={chrome}
      title={tn('repair.cancelFee.title')}
      onBack={() => discard.requestLeave(onCancel)}
      primaryLabel={ask.asking ? ta('approvals.action.ask') : tn('repair.cancelFee.save')}
      onPrimary={submit}
      primaryDisabled={!complete}
      primaryHint={tn(
        fee === null
          ? 'repair.hint.cancelFee'
          : changed
            ? 'repair.hint.reason'
            : 'repair.cancelFee.same',
      )}
      overlay={discard.overlay}
      busy={runner.busy}
      errorCode={runner.errorCode}
      stale={stale}
      onClearError={runner.clearError}
      testID={testID}
    >
      <Text style={[repairStyles.body, styles.consequence]} testID={`${testID}.explain`}>
        {paid > 0
          ? tn('repair.cancelFee.paid', { amount: formatMoney(paid) })
          : tn('repair.cancelFee.unpaid')}
      </Text>
      {ask.asking ? (
        <Text style={[repairStyles.caption, styles.consequence]} testID={`${testID}.asks`}>
          {tn(askedBecauseKey(true))}
        </Text>
      ) : null}
      <TextInput
        label={tn('repair.cancelFee.input')}
        value={feeText}
        onChangeText={(text) => {
          if (acceptsRupiahText(text)) setFeeText(groupedAmount(text));
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
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  // Empty even when correcting: the recorded amount is shown above, and the step asks for a new one.
  const [amountText, setAmountText] = useState('');
  const [reason, setReason] = useState('');
  const [method, setMethod] = useDownPaymentMethod(ticketId, mode);
  const discard = useDiscardConfirm({
    dirty: stale === null && (amountText !== '' || reason.trim() !== ''),
    onRegisterDiscardGuard,
    testID,
  });
  // Until the store's methods load, a method picked earlier would read as cash.
  const loadedAccounts = usePaymentAccounts();
  const accounts = loadedAccounts ?? [];
  const correcting = mode === 'correct';
  const { amount, aboveTotal, gap } = downPaymentEntry({
    mode,
    typed: parseRupiah(amountText),
    reason,
    current,
    total,
    methodMissing: methodMissing(method.account, accounts),
    referenceMissing: referenceMissing(method.account, method.reference, accounts),
  });
  const complete = gap === null && loadedAccounts !== null;
  // Through which method is said once one is picked.
  const changeLine = methodMissing(method.account, accounts)
    ? null
    : downPaymentChangeLine(
        current,
        amount,
        accountLabel(offeredAccount(method.account, accounts), accounts),
      );
  const fix =
    correcting && complete && amount !== null
      ? { ticketId, amount, reason, ...chosenMethod(method.account, method.reference, accounts) }
      : null;
  // Whether it goes to an owner shows as soon as the new amount is typed, before the reason.
  const typedFix =
    correcting && amount !== null && amount !== current && !aboveTotal && loadedAccounts !== null
      ? { ticketId, amount, ...chosenMethod(method.account, method.reference, accounts) }
      : null;
  const ask = useDownPaymentAsk(typedFix, current ?? 0);
  const asking = correcting && ask.asking;

  const submit = (): void => {
    if (!complete || amount === null) return;
    void runner
      .run<unknown>(() =>
        fix === null
          ? runtime.run('recordDownPayment', {
              ticketId,
              amount,
              ...chosenMethod(method.account, method.reference, accounts),
            })
          : asking
            ? runtime.approvals.run('requestApproval', {
                kind: REPAIR_APPROVAL_KIND.downPayment,
                input: fix,
                reason,
              })
            : runtime.run('correctDownPayment', fix),
      )
      .then((result) => {
        if (result !== undefined) (asking ? onAsked : onDone)();
      });
  };

  return (
    <FlowScreen
      chrome={chrome}
      title={tn(
        downPaymentTitleKey(mode, runtime.hasPermission(REPAIR_PERMISSION.correctDownPayment)),
      )}
      onBack={() => discard.requestLeave(onCancel)}
      primaryLabel={asking ? ta('approvals.action.ask') : tn('repair.downPayment.save')}
      onPrimary={submit}
      overlay={discard.overlay}
      primaryDisabled={!complete}
      primaryHint={gap === null ? undefined : tn(DOWN_PAYMENT_GAP_KEY[gap])}
      busy={runner.busy}
      errorCode={runner.errorCode}
      stale={stale}
      onClearError={runner.clearError}
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
            if (acceptsRupiahText(text)) setAmountText(groupedAmount(text));
          }}
          keyboardType="number-pad"
          selectTextOnFocus
          autoFocus
          errorMessage={aboveTotal ? tn('repair.problem.downPaymentAboveTotal') : undefined}
          testID={`${testID}.amount`}
        />
        <Text style={repairStyles.caption} testID={`${testID}.total`}>
          {tn('repair.downPayment.ofTotal', { amount: formatMoney(total) })}
        </Text>
      </View>
      {correcting && (amount ?? 0) === 0 ? null : (
        <View style={repairStyles.gap}>
          <PaymentMethodField
            accounts={accounts}
            account={method.account}
            reference={method.reference}
            onChange={setMethod}
            testID={`${testID}.method`}
          />
          {correcting && changeLine !== null ? (
            <Text style={repairStyles.caption} testID={`${testID}.change`}>
              {changeLine}
            </Text>
          ) : null}
        </View>
      )}
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
          {ask.limit === null ? null : (
            <Text style={repairStyles.caption} testID={`${testID}.limit`}>
              {tn('repair.hint.downPaymentLimit', { amount: formatMoney(ask.limit) })}
            </Text>
          )}
          {ask.withEarlier === null ? null : (
            <Text style={repairStyles.caption} testID={`${testID}.withEarlier`}>
              {tn('repair.hint.downPaymentWithEarlier', { amount: formatMoney(ask.withEarlier) })}
            </Text>
          )}
          {asking ? (
            <Text style={repairStyles.caption} testID={`${testID}.asks`}>
              {tn(ask.because)}
            </Text>
          ) : null}
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
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const settings = useIntakeOptionSettings();
  const [picked, setPicked] = useState<readonly string[]>(() => current.map((type) => type.item));
  const changed =
    picked.length !== current.length || picked.some((id, i) => id !== current[i]!.item);
  const submit = (): void => {
    if (!changed) {
      onCancel();
      return;
    }
    void runner
      .run(() => runtime.run('setRepairTypes', { ticketId, repairTypes: [...picked] }))
      .then((result) => {
        if (result !== undefined) onDone();
      });
  };

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
        {(data) => {
          const choices = repairTypeChoices(storeIntakeOptions(data).repairTypes, current);
          return (
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
              <Text style={[repairStyles.caption, repairStyles.gap]}>
                {tn('repair.warranty.fromPickup')}
              </Text>
            </View>
          );
        }}
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
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const [reloadNonce, setReloadNonce] = useState(0);
  // Each technician with how many repairs they already hold, so the counter can spread the work.
  const technicians = useRepairQuery(
    async (rt) => {
      const [people, loads] = await Promise.all([
        rt.technicians(),
        rt.query('technicianLoads', {}),
      ]);
      const load = new Map(loads.rows.map((row) => [row.technicianId, row.load]));
      return people.map((tech) => ({ ...tech, load: load.get(tech.id) ?? 0 }));
    },
    `technicians:${String(reloadNonce)}`,
  );

  const assign = (technicianId: string): void => {
    if (technicianId === currentTechnicianId) return;
    void runner
      .run(() => runtime.run('assignTechnician', { ticketId, technicianId }))
      .then((result) => {
        if (result !== undefined) onDone();
      });
  };

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
      <QueryView
        query={technicians}
        onBack={onCancel}
        onRetry={() => setReloadNonce((n) => n + 1)}
        testID={`${testID}.list`}
      >
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
export function usePriceKinds(askable = false): readonly PriceKind[] {
  const runtime = useRepairRuntime();
  const discount = askable || runtime.hasPermission(REPAIR_PERMISSION.discount);
  return useMemo(() => priceKinds(discount), [discount]);
}

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
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const kinds = usePriceKinds(onAsked !== undefined);
  const holdsDiscount = runtime.hasPermission(REPAIR_PERMISSION.discount);
  // A limited role (a manager) sees how far they may discount before it goes to an owner.
  const discountLimit = runtime.limitOf(REPAIR_PERMISSION.discount);
  const [kind, setKind] = useState<PriceKind>('part');
  const [description, setDescription] = useState('');
  const [amountText, setAmountText] = useState('');
  const [reason, setReason] = useState('');
  const amount = parseRupiah(amountText);
  const complete = description.trim() !== '' && amount !== null && reason.trim() !== '';
  const discard = useDiscardConfirm({
    dirty:
      stale === null && (description.trim() !== '' || amountText !== '' || reason.trim() !== ''),
    onRegisterDiscardGuard,
    testID,
  });
  const asking =
    onAsked !== undefined &&
    kind === 'discount' &&
    asksApproval(holdsDiscount, discountLimit, discounted + (amount ?? 0));
  // Asking skips the customer's answer: it is asked once an owner approves.
  const deciding = mode === 'change' && !asking;

  const submit = (customerAgreed: boolean): void => {
    if (!complete) return;
    const line = { ticketId, kind, description, amount: signedAmount(kind, amount), reason };
    void runner
      .run<unknown>(() =>
        asking
          ? runtime.approvals.run('requestApproval', {
              kind: REPAIR_APPROVAL_KIND.discount,
              input: { ...line, customerAgreed: false },
              reason,
            })
          : mode === 'change'
            ? runtime.run('changeQuote', { ...line, customerAgreed })
            : runtime.run('proposeQuoteChange', line),
      )
      .then((result) => {
        if (result !== undefined) (asking ? (onAsked ?? onDone) : onDone)();
      });
  };

  return (
    <FlowScreen
      chrome={chrome}
      title={tn(mode === 'change' ? 'repair.price.editTitle' : 'repair.action.proposePrice')}
      onBack={() => discard.requestLeave(onCancel)}
      overlay={discard.overlay}
      question={deciding ? tn('repair.price.alreadyAgreed') : undefined}
      primaryLabel={
        asking
          ? ta('approvals.action.ask')
          : tn(mode === 'change' ? 'repair.action.agreedYes' : 'repair.action.proposePrice')
      }
      onPrimary={() => submit(true)}
      secondary={
        deciding
          ? {
              label: tn('repair.action.applyUnconfirmed'),
              onPress: () => submit(false),
              disabled: !complete,
              testID: `${testID}.unconfirmed`,
            }
          : undefined
      }
      primaryDisabled={!complete}
      primaryHint={tn('repair.hint.priceLine')}
      busy={runner.busy}
      errorCode={runner.errorCode}
      stale={stale}
      onClearError={runner.clearError}
      testID={testID}
    >
      <SegmentedControl
        options={kinds.map((value) => ({ value, label: tn(PRICE_KIND_KEY[value]) }))}
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
            if (acceptsRupiahText(text)) setAmountText(groupedAmount(text));
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
        {kind !== 'discount' || !holdsDiscount || discountLimit === null ? null : (
          <Text style={repairStyles.caption} testID={`${testID}.discountLimit`}>
            {discountLimitHint(discountLimit, discounted)}
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
      {asking ? (
        <Text style={[repairStyles.caption, repairStyles.gap]} testID={`${testID}.asks`}>
          {tn(askedBecauseKey(holdsDiscount))}
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
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const [note, setNote] = useState('');
  const discard = useDiscardConfirm({
    dirty: stale === null && note.trim() !== '',
    onRegisterDiscardGuard,
    testID,
  });
  // A line that lowers the price is an owner's to apply; anyone deciding may still decline it.
  const mayApply = line.amount >= 0 || runtime.hasPermission(REPAIR_PERMISSION.discount);

  const decide = (decision: 'agreed' | 'declined'): void => {
    void runner
      .run(() =>
        decision === 'declined'
          ? runtime.run('declineProposal', { ticketId, lineId: line.id, note })
          : runtime.run('applyProposal', {
              ticketId,
              lineId: line.id,
              customerAgreed: true,
              note,
            }),
      )
      .then((result) => {
        if (result !== undefined) onDone();
      });
  };

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
    fontVariant: ['tabular-nums'],
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

/** Typed rupiah shown with thousands dots as it is typed, like the intake prices ("650.000"). */
function groupedAmount(text: string): string {
  const digits = text.replace(/\D/g, '');
  return digits === '' ? '' : formatNumber(Number(digits));
}
