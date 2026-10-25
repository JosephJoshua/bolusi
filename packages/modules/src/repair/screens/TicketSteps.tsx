/**
 * The full-screen steps a ticket action opens: work photos, a note or reason, picking a technician,
 * a price change and deciding a technician's proposal. Each runs one command, stays put with the
 * refusal shown when it fails, and calls `onDone` when it lands.
 */
import { formatMoney } from '@bolusi/i18n';
import {
  Button,
  ListRow,
  PhotoSlot,
  SegmentedControl,
  TextInput,
  ToggleChip,
  Icon,
  color,
  size,
  space,
} from '@bolusi/ui';
import type { MediaRef } from '@bolusi/schemas';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { WORK_PHOTOS_MAX, type QuoteLineKind, type WorkPhotoStage } from '../constants.js';
import type { QuoteLineRow } from '../queries.js';
import { useActionRunner } from '../../screen-kit/index.js';

import { tn, type RepairKey } from './i18n.js';
import { PRICE_KIND_KEY } from './labels.js';
import { boardFilter, capturedThumbnailRef, parseRupiah, signedAmount } from '../flows.js';
import {
  FlowScreen,
  PhotoGrid,
  PhotoThumb,
  QueryView,
  repairStyles,
  type RepairChrome,
} from './parts.js';
import { useRepairQuery, useRepairRuntime } from './runtime.js';

interface StepProps {
  readonly chrome: RepairChrome;
  readonly ticketId: string;
  readonly onDone: () => void;
  readonly onCancel: () => void;
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
  stage,
  onDone,
  onCancel,
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
      onBack={onCancel}
      primaryLabel={tn(copy.submit)}
      onPrimary={submit}
      primaryDisabled={photos.length === 0}
      busy={runner.busy}
      errorCode={runner.errorCode}
      onClearError={runner.clearError}
      testID={testID}
    >
      <Text style={repairStyles.muted}>{tn(copy.hint)}</Text>
      <View style={repairStyles.gap}>
        <PhotoGrid>
          {photos.map((photo, index) => (
            <View key={photo.mediaId} style={repairStyles.gridCell}>
              <PhotoThumb photo={capturedThumbnailRef(photo)} testID={`${testID}.photo.${index}`} />
            </View>
          ))}
          {photos.length < WORK_PHOTOS_MAX ? (
            <View style={repairStyles.gridCell}>
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

// ── a note or a reason ────────────────────────────────────────────────────────────────────────

/** "Waiting for parts" (which part, optional) and "Cancel repair" (why, required). */
export function NoteStep({
  chrome,
  ticketId,
  kind,
  onDone,
  onCancel,
  testID = `repair.note.${kind}`,
}: StepProps & {
  readonly kind: 'waitForParts' | 'cancel';
  readonly testID?: string | undefined;
}): React.JSX.Element {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const [text, setText] = useState('');
  const cancel = kind === 'cancel';

  const submit = (): void => {
    void runner
      .run(() =>
        cancel
          ? runtime.run('cancelTicket', { ticketId, reason: text })
          : runtime.run('markWaitingForParts', { ticketId, note: text }),
      )
      .then((result) => {
        if (result !== undefined) onDone();
      });
  };

  return (
    <FlowScreen
      chrome={chrome}
      title={tn(cancel ? 'repair.action.cancel' : 'repair.action.waitForParts')}
      onBack={onCancel}
      primaryLabel={tn(cancel ? 'repair.action.cancel' : 'repair.action.waitForParts')}
      primaryVariant={cancel ? 'destructive' : 'primary'}
      onPrimary={submit}
      primaryDisabled={cancel && text.trim() === ''}
      busy={runner.busy}
      errorCode={runner.errorCode}
      onClearError={runner.clearError}
      testID={testID}
    >
      <TextInput
        label={tn(cancel ? 'repair.cancel.reason' : 'repair.work.partsNote')}
        value={text}
        onChangeText={setText}
        multiline
        autoFocus
        testID={`${testID}.text`}
      />
    </FlowScreen>
  );
}

// ── assign ────────────────────────────────────────────────────────────────────────────────────

export function AssignStep({
  chrome,
  ticketId,
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
    async (rt) =>
      Promise.all(
        (await rt.technicians()).map(async (tech) => ({
          ...tech,
          load: (
            await rt.query('listTickets', { filter: boardFilter('mine', tech.id), limit: 100 })
          ).rows.length,
        })),
      ),
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
      title={tn('repair.action.assign')}
      onBack={onCancel}
      busy={runner.busy}
      errorCode={runner.errorCode}
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

/** Kinds offered on the phone. Adjustments (either sign) stay a desktop/back-office tool. */
export const PRICE_KINDS = [
  'part',
  'labour',
  'discount',
] as const satisfies readonly QuoteLineKind[];
export type PriceKind = (typeof PRICE_KINDS)[number];

/**
 * A new price line after intake. The cashier changes the price directly and records whether the
 * customer agreed; a technician only proposes it for the cashier to decide.
 */
export function PriceChangeStep({
  chrome,
  ticketId,
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
  const [kind, setKind] = useState<PriceKind>('part');
  const [description, setDescription] = useState('');
  const [amountText, setAmountText] = useState('');
  const [reason, setReason] = useState('');
  const [customerAgreed, setCustomerAgreed] = useState(false);
  const amount = parseRupiah(amountText);
  const complete = description.trim() !== '' && amount !== null && reason.trim() !== '';

  const submit = (): void => {
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
      primaryLabel={tn(
        mode === 'change' ? 'repair.action.changePrice' : 'repair.action.proposePrice',
      )}
      onPrimary={submit}
      primaryDisabled={!complete}
      busy={runner.busy}
      errorCode={runner.errorCode}
      onClearError={runner.clearError}
      testID={testID}
    >
      <SegmentedControl
        options={PRICE_KINDS.map((value) => ({ value, label: tn(PRICE_KIND_KEY[value]) }))}
        value={kind}
        onChange={setKind}
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
          onChangeText={setAmountText}
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
        <View style={repairStyles.gap}>
          <ToggleChip
            label={tn('repair.price.customerAgreed')}
            selected={customerAgreed}
            onToggle={() => setCustomerAgreed((current) => !current)}
            testID={`${testID}.agreed`}
          />
        </View>
      ) : null}
    </FlowScreen>
  );
}

/** The cashier decides a technician's proposed line: apply it (with the customer's answer) or not. */
export function ProposalStep({
  chrome,
  ticketId,
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
  const [customerAgreed, setCustomerAgreed] = useState(false);
  const [note, setNote] = useState('');

  const decide = (apply: boolean): void => {
    void runner
      .run(() =>
        apply
          ? runtime.run('applyProposal', { ticketId, lineId: line.id, customerAgreed, note })
          : runtime.run('declineProposal', { ticketId, lineId: line.id, note }),
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
      primaryLabel={tn('repair.action.applyPrice')}
      onPrimary={() => decide(true)}
      busy={runner.busy}
      errorCode={runner.errorCode}
      onClearError={runner.clearError}
      testID={testID}
    >
      <Text style={repairStyles.heading}>{line.description}</Text>
      <Text style={repairStyles.body} testID={`${testID}.amount`}>
        {`${tn(PRICE_KIND_KEY[line.kind])} · ${formatMoney(line.amount)}`}
      </Text>
      {line.reason === null ? null : <Text style={repairStyles.muted}>{line.reason}</Text>}
      <View style={repairStyles.gap}>
        <ToggleChip
          label={tn('repair.price.customerAgreed')}
          selected={customerAgreed}
          onToggle={() => setCustomerAgreed((current) => !current)}
          testID={`${testID}.agreed`}
        />
      </View>
      <View style={repairStyles.gap}>
        <TextInput
          label={tn('repair.price.decisionNote')}
          value={note}
          onChangeText={setNote}
          testID={`${testID}.note`}
        />
      </View>
      <View style={styles.decline}>
        <Button
          label={tn('repair.action.declinePrice')}
          variant="secondary"
          onPress={() => decide(false)}
          disabled={runner.busy}
          testID={`${testID}.decline`}
        />
      </View>
    </FlowScreen>
  );
}

const styles = StyleSheet.create({
  decline: { marginTop: space.xl },
});
