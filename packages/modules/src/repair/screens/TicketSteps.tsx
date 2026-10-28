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
  color,
  radius,
  size,
  space,
  type,
} from '@bolusi/ui';
import type { MediaRef } from '@bolusi/schemas';
import { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { REPAIR_PERMISSION, WORK_PHOTOS_MAX, type WorkPhotoStage } from '../constants.js';
import { standardCancelFee, type QuoteLineRow } from '../queries.js';
import { useActionRunner, type DiscardGuard } from '../../screen-kit/index.js';

import { tn, type RepairKey } from '../i18n.js';
import { DOWN_PAYMENT_GAP_KEY, PRICE_KIND_KEY } from '../labels.js';
import {
  acceptsRupiahText,
  capturedThumbnailRef,
  downPaymentEntry,
  parseRupiah,
  priceKinds,
  signedAmount,
  type PriceKind,
  type StaleStep,
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
import { useCancelFees, useRepairQuery, useRepairRuntime } from '../runtime.js';

interface StepProps {
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
  testID = 'repair.note.waitForParts',
}: StepProps & { readonly testID?: string | undefined }): React.JSX.Element {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const [text, setText] = useState('');

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
      onBack={onCancel}
      primaryLabel={tn('repair.action.waitForParts')}
      onPrimary={submit}
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

// ── cancel (owners) ───────────────────────────────────────────────────────────────────────────

/**
 * Cancel a servisan: the store's fee for its stage is filled in, the owner may change it, and the
 * reason is always required. The fee is what the customer signs for at handover.
 */
export function CancelStep({
  chrome,
  ticketId,
  stale,
  workStarted,
  onDone,
  onCancel,
  testID = 'repair.cancel',
}: StepProps & {
  readonly workStarted: boolean;
  readonly testID?: string | undefined;
}): React.JSX.Element {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const [reloadNonce, setReloadNonce] = useState(0);
  const fees = useCancelFees(reloadNonce);
  const [reason, setReason] = useState('');
  // Null until the owner taps "Ubah"; the store's fee applies until then.
  const [feeText, setFeeText] = useState<string | null>(null);

  const standard = fees.status === 'ready' ? standardCancelFee({ workStarted }, fees.data) : null;
  const fee = feeText === null ? standard : parseRupiah(feeText);
  const changed = standard !== null && fee !== null && fee !== standard;
  const complete = fee !== null && reason.trim() !== '';

  const submit = (): void => {
    if (fee === null || !complete) return;
    // An unchanged fee is left to the command, which fills in the store's fee as it is then.
    void runner
      .run(() =>
        runtime.run(
          'cancelTicket',
          feeText === null ? { ticketId, reason } : { ticketId, reason, fee },
        ),
      )
      .then((result) => {
        if (result !== undefined) onDone();
      });
  };

  return (
    <FlowScreen
      chrome={chrome}
      title={tn('repair.action.cancel')}
      onBack={onCancel}
      primaryLabel={tn('repair.action.cancel')}
      primaryVariant="destructive"
      onPrimary={submit}
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
        {tn('repair.cancel.consequence')}
      </Text>
      <QueryView
        query={fees}
        onBack={onCancel}
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
                    onPress={() => setFeeText(String(standard ?? 0))}
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
                : tn(workStarted ? 'repair.cancel.afterWork' : 'repair.cancel.beforeWork')}
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
              if (acceptsRupiahText(text)) setFeeText(text);
            }}
            keyboardType="number-pad"
            autoFocus
            testID={`${testID}.feeInput`}
          />
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
  onCancel,
  testID = 'repair.downPayment',
}: StepProps & {
  readonly mode: 'record' | 'correct';
  /** The down payment recorded now; null when none is. */
  readonly current: number | null;
  readonly total: number;
  readonly testID?: string | undefined;
}): React.JSX.Element {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  // Empty even when correcting: the recorded amount is shown above, and the step asks for a new one.
  const [amountText, setAmountText] = useState('');
  const [reason, setReason] = useState('');
  const correcting = mode === 'correct';
  const { amount, aboveTotal, gap } = downPaymentEntry({
    mode,
    typed: parseRupiah(amountText),
    reason,
    current,
    total,
  });
  const complete = gap === null;

  const submit = (): void => {
    if (!complete || amount === null) return;
    void runner
      .run(() =>
        correcting
          ? runtime.run('correctDownPayment', { ticketId, amount, reason })
          : runtime.run('recordDownPayment', { ticketId, amount }),
      )
      .then((result) => {
        if (result !== undefined) onDone();
      });
  };

  return (
    <FlowScreen
      chrome={chrome}
      title={tn(correcting ? 'repair.downPayment.correctTitle' : 'repair.downPayment.recordTitle')}
      onBack={onCancel}
      primaryLabel={tn('repair.downPayment.save')}
      onPrimary={submit}
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
          autoFocus
          errorMessage={aboveTotal ? tn('repair.problem.downPaymentAboveTotal') : undefined}
          testID={`${testID}.amount`}
        />
        <Text style={repairStyles.caption} testID={`${testID}.total`}>
          {tn('repair.downPayment.ofTotal', { amount: formatMoney(total) })}
        </Text>
      </View>
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
        </View>
      ) : null}
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

/** The kinds this user may add: a discount lowers the price, so only owners see it. */
export function usePriceKinds(): readonly PriceKind[] {
  const runtime = useRepairRuntime();
  const discount = runtime.hasPermission(REPAIR_PERMISSION.discount);
  return useMemo(() => priceKinds(discount), [discount]);
}

/**
 * A new price line after intake. The cashier changes the price directly, answering whether the
 * customer agreed as the save itself (as on a proposal, so it cannot be skipped by not noticing a
 * toggle); a technician only proposes it for the cashier to decide.
 */
export function PriceChangeStep({
  chrome,
  ticketId,
  stale,
  mode,
  onDone,
  onCancel,
  testID = `repair.price.${mode}`,
}: StepProps & {
  readonly mode: 'change' | 'propose';
  readonly testID?: string | undefined;
}): React.JSX.Element {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const kinds = usePriceKinds();
  const [kind, setKind] = useState<PriceKind>('part');
  const [description, setDescription] = useState('');
  const [amountText, setAmountText] = useState('');
  const [reason, setReason] = useState('');
  const amount = parseRupiah(amountText);
  const complete = description.trim() !== '' && amount !== null && reason.trim() !== '';

  const submit = (customerAgreed: boolean): void => {
    if (!complete) return;
    const line = { ticketId, kind, description, amount: signedAmount(kind, amount), reason };
    void runner
      .run(() =>
        mode === 'change'
          ? runtime.run('changeQuote', { ...line, customerAgreed })
          : runtime.run('proposeQuoteChange', line),
      )
      .then((result) => {
        if (result !== undefined) onDone();
      });
  };

  return (
    <FlowScreen
      chrome={chrome}
      title={tn(mode === 'change' ? 'repair.action.changePrice' : 'repair.action.proposePrice')}
      onBack={onCancel}
      question={mode === 'change' ? tn('repair.price.alreadyAgreed') : undefined}
      primaryLabel={tn(
        mode === 'change' ? 'repair.action.agreedYes' : 'repair.action.proposePrice',
      )}
      onPrimary={() => submit(true)}
      secondary={
        mode === 'change'
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
          label={tn('repair.price.amount')}
          value={amountText}
          onChangeText={(text) => {
            if (acceptsRupiahText(text)) setAmountText(groupedAmount(text));
          }}
          keyboardType="number-pad"
          testID={`${testID}.amount`}
        />
        {amount === null ? null : (
          <Text style={repairStyles.caption} testID={`${testID}.amountPreview`}>
            {formatMoney(signedAmount(kind, amount))}
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
      {mode === 'change' ? (
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
  onDone,
  onCancel,
  testID = 'repair.proposal',
}: StepProps & {
  readonly line: QuoteLineRow;
  readonly testID?: string | undefined;
}): React.JSX.Element {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const [note, setNote] = useState('');
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
      onBack={onCancel}
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
