/**
 * Handover — giving the device back: the counter goes through the checklist with the customer
 * (they tried the phone, the accessories came back; anything not ticked needs a note), the customer
 * pays what is left (in one or more methods), a photo of the handover and their signature, then
 * one tap records it all. What they owe is the
 * price on a repaired phone or the fee on a cancelled one, less the DP; a DP above it goes back.
 * Only an owner may let the phone go unpaid ("Bayar nanti"), which leaves a debt.
 */
import { formatMoney } from '@bolusi/i18n';
import {
  Button,
  Card,
  PhotoSlot,
  TextButton,
  TextInput,
  ToggleChip,
  border,
  color,
  space,
  type,
  Text,
} from '@bolusi/ui';
import type { MediaRef } from '@bolusi/schemas';
import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useActionRunner, type DiscardGuard } from '../../screen-kit/index.js';

import { PaymentLines } from '../../money/screens/PaymentLines.js';
import { QrisStep, useQrStepBack } from '../../money/screens/QrisStep.js';
import { canSimulateQris } from '../../money/qris.js';
import { tn } from '../i18n.js';
import {
  ticketBalance,
  capturedThumbnailRef,
  amountOwed,
  repairAbilities,
  staleStep,
  ticketStatus,
  type HandoverDraft,
} from '../flows.js';
import {
  DownPaymentRows,
  FlowScreen,
  Section,
  PhotoGrid,
  PhotoThumb,
  QueryView,
  StatusChip,
  repairStyles,
  type RepairChrome,
} from './parts.js';
import { useDiscardConfirm } from './discard.js';
import { handoverLineLabel, useHandoverChecks } from '../handover-checks.js';
import { freeHandoverNeedsOwner } from '../rules.js';
import { payLaterHintKey, payLaterLines, useHandoverPayment } from '../handover-payment.js';
import { ta } from '../../approvals/i18n.js';
import { usePaymentAccounts, useRepairQuery, useRepairRuntime, useTicketQris } from '../runtime.js';

export interface HandoverProps {
  readonly ticketId: string;
  readonly chrome: RepairChrome;
  readonly onDone: () => void;
  readonly onCancel: () => void;
  /** Lets hardware back ask before dropping the photo and signature taken here. */
  readonly onRegisterDiscardGuard?: ((guard: DiscardGuard | null) => void) | undefined;
  /** This user's handover of this ticket in progress, kept by the shell; read once at mount. */
  readonly restoredDraft?: HandoverDraft | null | undefined;
  /** Keeps the handover in progress (null once it is done or dropped), as an intake does. */
  readonly onDraftChange?: ((draft: HandoverDraft | null) => void) | undefined;
  readonly testID?: string | undefined;
}

export function Handover({
  ticketId,
  chrome,
  onDone,
  onCancel,
  onRegisterDiscardGuard,
  restoredDraft,
  onDraftChange,
  testID = 'repair.handover',
}: HandoverProps): React.JSX.Element {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  // Read once: a draft is this ticket's only when the shell kept it for this ticket.
  const [restored] = useState(() => (restoredDraft?.ticketId === ticketId ? restoredDraft : null));
  const [photo, setPhoto] = useState<MediaRef | null>(restored?.photo ?? null);
  const [signature, setSignature] = useState<MediaRef | null>(restored?.signature ?? null);
  const [note, setNote] = useState(restored?.note ?? '');
  const [reloadNonce, setReloadNonce] = useState(0);
  const query = useRepairQuery(
    async (rt) => (await rt.query('getTicket', { ticketId })).rows[0],
    `handover:${ticketId}:${String(reloadNonce)}`,
  );
  // Until the store's methods load, a method picked earlier would read as cash.
  const loadedAccounts = usePaymentAccounts();
  const accounts = loadedAccounts ?? [];

  // Handed back, reopened or held by a new proposal on another device meanwhile: say so rather
  // than take a signature for a handover that would be refused.
  const can = useMemo(() => repairAbilities(runtime.hasPermission), [runtime]);
  const ticket = query.status === 'ready' ? query.data : undefined;
  const balance =
    ticket === undefined ? { kind: 'due' as const, amount: 0 } : ticketBalance(ticket);
  const due = balance.kind === 'due' ? balance.amount : 0;
  const qris = useTicketQris(ticketId, ticket?.ticketNumber ?? null);
  const payment = useHandoverPayment(ticketId, due, accounts, qris, restored?.payment);
  const { settled } = payment;
  const checks = useHandoverChecks(ticket, restored?.ticked);
  const ownerNeeded =
    ticket !== undefined && freeHandoverNeedsOwner(ticket) && !can.warrantyException;
  const ready =
    !ownerNeeded &&
    photo !== null &&
    signature !== null &&
    settled &&
    loadedAccounts !== null &&
    checks.ready(note);
  const stale =
    ticket === undefined ? null : staleStep({ kind: 'handover' }, ticket, can, runtime.userId);

  const dirty =
    stale === null &&
    (photo !== null ||
      signature !== null ||
      note.trim() !== '' ||
      payment.touched ||
      checks.touched);
  const discard = useDiscardConfirm({
    dirty,
    onRegisterDiscardGuard: useQrStepBack(
      onRegisterDiscardGuard,
      payment.qris.open !== null,
      payment.qris.close,
    ),
    onDiscard: () => onDraftChange?.(null),
    testID,
  });

  // Kept as it is filled in, so a lock, a font-size change or Android recreating the app brings
  // the counter back to this handover with the signature and payment still there.
  const draft: HandoverDraft = {
    kind: 'handover',
    ticketId,
    photo,
    signature,
    note,
    ticked: [...checks.ticked],
    payment: {
      ...payment.draft,
      lines: payment.draft.lines === null ? null : [...payment.draft.lines],
    },
  };
  // Published when what was entered changes, not on every render.
  const draftKey = JSON.stringify(draft);
  const latestDraft = useRef(draft);
  latestDraft.current = draft;
  useEffect(() => {
    onDraftChange?.(dirty ? latestDraft.current : null);
  }, [dirty, draftKey, onDraftChange]);

  // A kept handover can outlive its captures: one no saved record refers to is deleted a day after
  // it was taken (06 §7). One that no longer loads is taken again rather than sent missing.
  useEffect(() => {
    if (restored === null) return;
    let live = true;
    const check = (ref: MediaRef | null, drop: () => void): void => {
      if (ref === null) return;
      void runtime
        .loadThumbnail(capturedThumbnailRef(ref))
        .catch(() => ({ kind: 'unavailable' }) as const)
        .then((state) => {
          if (live && state.kind !== 'ready') drop();
        });
    };
    check(restored.photo, () => setPhoto(null));
    check(restored.signature, () => setSignature(null));
    return () => {
      live = false;
    };
  }, [restored, runtime]);

  const capture = (
    take: () => Promise<{ readonly mediaRef: MediaRef } | null>,
    keep: (ref: MediaRef) => void,
  ): void => {
    void runner.run(take).then((captured) => {
      if (captured !== undefined && captured !== null) keep(captured.mediaRef);
    });
  };

  const submit = (): void => {
    if (!ready || photo === null || signature === null) return;
    void runner
      .run(() =>
        runtime.run('returnDevice', {
          ticketId,
          handoverPhoto: photo,
          signature,
          note,
          checklist: [...checks.lines],
          ...payment.input,
        }),
      )
      .then((result) => {
        if (result === undefined) return;
        onDraftChange?.(null);
        onDone();
      });
  };

  if (payment.qris.open !== null && qris.port !== undefined) {
    return (
      <QrisStep
        chrome={chrome}
        open={payment.qris.open}
        port={qris.port}
        canSimulate={canSimulateQris(runtime.hasPermission)}
        onPaid={payment.qris.paid}
        onRenew={payment.qris.renew}
        onTakeByHand={payment.qris.takeByHand}
        onClose={payment.qris.close}
        testID={`${testID}.qris`}
      />
    );
  }

  return (
    <FlowScreen
      chrome={chrome}
      title={tn('repair.action.handover')}
      onBack={() => discard.requestLeave(onCancel)}
      overlay={discard.overlay}
      primaryLabel={tn('repair.action.handover')}
      onPrimary={submit}
      primaryDisabled={!ready}
      primaryHint={tn(
        ownerNeeded
          ? 'repair.hint.handoverFree'
          : payment.qris.pending > 0
            ? 'repair.hint.handoverQris'
            : !settled
              ? payLaterHintKey(payment)
              : checks.loaded && !checks.ready(note)
                ? 'repair.hint.handoverChecks'
                : 'repair.hint.handover',
      )}
      busy={runner.busy}
      errorCode={runner.errorCode}
      onClearError={runner.clearError}
      stale={stale}
      testID={testID}
    >
      <QueryView
        query={query}
        onBack={onCancel}
        onRetry={() => setReloadNonce((n) => n + 1)}
        testID={`${testID}.ticket`}
      >
        {(shown) =>
          shown === undefined ? null : (
            <Card testID={`${testID}.summary`}>
              <StatusChip status={ticketStatus(shown)} testID={`${testID}.status`} />
              <Text style={styles.customer}>{shown.customerName}</Text>
              <Text style={repairStyles.muted}>
                {`${shown.deviceBrand} ${shown.deviceModel} · ${shown.ticketNumber}`}
              </Text>
              {/* What the customer signs for: the cancellation fee, never the repair price. A
                  ticket cancelled before fees existed charged nothing. */}
              <View style={[repairStyles.row, styles.total]}>
                <Text style={[styles.totalLabel, repairStyles.rowText]}>
                  {tn(shown.outcome === 'cancelled' ? 'repair.cancel.fee' : 'repair.price.total')}
                </Text>
                <Text
                  style={[repairStyles.heading, repairStyles.rowValue]}
                  testID={`${testID}.total`}
                >
                  {/* Before any reduction, which the rows below take off. */}
                  {formatMoney(amountOwed(shown) + shown.reduced)}
                </Text>
              </View>
              {shown.outcome === 'cancelled' ? (
                <Text style={repairStyles.muted} testID={`${testID}.cancelled`}>
                  {tn('repair.handover.cancelled')}
                </Text>
              ) : null}
              <DownPaymentRows
                total={amountOwed(shown)}
                reduced={shown.reduced}
                refunds={shown.refunds}
                downPayment={shown.downPayment}
                // The DP and anything paid at this counter already (a QR): all of it is paid.
                paidLabel="repair.price.paid"
                testID={testID}
              />
            </Card>
          )
        }
      </QueryView>
      {checks.lines.length === 0 || stale !== null ? null : (
        <Section title={tn('repair.handover.checks')} testID={`${testID}.checks`}>
          {/* Wrapped, not a sideways row: every line must be in sight to be gone through. */}
          <View style={styles.checks} testID={`${testID}.checkList`}>
            {checks.lines.map((line) => (
              <ToggleChip
                key={`${line.kind}:${line.item}`}
                label={handoverLineLabel(line)}
                selected={line.done}
                onToggle={() => checks.toggle(line)}
                testID={`${testID}.check.${line.kind}.${line.item}`}
              />
            ))}
          </View>
        </Section>
      )}
      {due > 0 && stale === null ? (
        <Section
          title={tn('repair.handover.payment')}
          action={
            payment.access.kind === 'none' ? undefined : (
              <TextButton
                label={tn(payment.unpaid ? 'repair.handover.payNow' : 'repair.handover.payLater')}
                onPress={() => {
                  // A refusal of the other way to settle no longer applies.
                  runner.clearError();
                  payment.togglePayLater();
                }}
                testID={`${testID}.payLater`}
              />
            )
          }
          testID={`${testID}.payment`}
        >
          {payment.unpaid ? (
            <View style={styles.payLater}>
              <TextInput
                label={tn('repair.handover.payLaterReason')}
                value={payment.unpaidReason}
                onChangeText={payment.setUnpaidReason}
                multiline
                testID={`${testID}.unpaidReason`}
              />
              {payLaterLines(payment, due).map((line) => (
                <Text key={line.id} style={repairStyles.muted} testID={`${testID}.${line.id}`}>
                  {line.text}
                </Text>
              ))}
              {payment.access.kind === 'ask' ? (
                <Button
                  label={ta('approvals.action.ask')}
                  variant="secondary"
                  disabled={payment.unpaidReason.trim() === '' || runner.busy}
                  onPress={() => void runner.run(payment.askPayLater)}
                  testID={`${testID}.askPayLater`}
                />
              ) : null}
            </View>
          ) : (
            <PaymentLines
              lines={payment.lines}
              entry={payment.entry}
              accounts={accounts}
              onChange={payment.setLines}
              newKey={payment.newKey}
              qris={payment.qris}
              testID={`${testID}.pay`}
            />
          )}
        </Section>
      ) : null}
      <View style={repairStyles.gap}>
        <PhotoGrid>
          <View style={styles.half}>
            <PhotoSlot
              label={tn('repair.handover.photo')}
              actionLabel={tn(photo === null ? 'repair.photo.take' : 'repair.photo.retake')}
              image={
                photo === null ? null : (
                  <PhotoThumb photo={capturedThumbnailRef(photo)} testID={`${testID}.photoThumb`} />
                )
              }
              onPress={() =>
                capture(
                  () => runtime.capturePhoto({ title: tn('repair.handover.photo') }),
                  setPhoto,
                )
              }
              testID={`${testID}.photo`}
            />
          </View>
          <View style={styles.half}>
            <PhotoSlot
              label={tn('repair.handover.signature')}
              emptyIcon="signature"
              actionLabel={tn(
                signature === null ? 'repair.handover.sign' : 'repair.handover.signAgain',
              )}
              image={
                signature === null ? null : (
                  <PhotoThumb
                    photo={capturedThumbnailRef(signature)}
                    testID={`${testID}.signatureThumb`}
                  />
                )
              }
              onPress={() =>
                capture(
                  () => runtime.captureSignature({ title: tn('repair.handover.signatureTitle') }),
                  setSignature,
                )
              }
              testID={`${testID}.signature`}
            />
          </View>
        </PhotoGrid>
      </View>
      <View style={repairStyles.gap}>
        <TextInput
          label={tn(checks.noteNeeded ? 'repair.handover.noteNeeded' : 'repair.handover.note')}
          value={note}
          onChangeText={setNote}
          multiline
          testID={`${testID}.note`}
        />
      </View>
    </FlowScreen>
  );
}

const styles = StyleSheet.create({
  customer: { ...type.title, color: color.text, marginTop: space.md },
  total: {
    marginTop: space.md,
    paddingTop: space.md,
    borderTopWidth: border.hairline,
    borderTopColor: color.border,
  },
  totalLabel: { ...type.bodyBold, color: color.text },
  payLater: { gap: space.sm },
  checks: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  // Two captures side by side, each half the row.
  half: { flexBasis: '47%', flexGrow: 1 },
});
