// The short tasks a ticket action opens on the desktop, each a dialog over the board: work photos,
// waiting for parts, cancelling, picking a technician, a price change and deciding a proposal.
// Each runs one command, stays open with the refusal shown when it fails, and closes when it lands.
// The rules are the phone's (flows.ts and the commands); only the presentation differs.
import { formatMoney, t } from '@bolusi/i18n';
import type { MediaRef } from '@bolusi/schemas';
import {
  Avatar,
  Banner,
  Button,
  CaptureTile,
  ChoiceList,
  ConfirmDialog,
  Dialog,
  RollingText,
  Segmented,
  TextArea,
  TextField,
  ToggleChip,
} from '@bolusi/ui-web';
import { Check, Printer, Signature } from 'lucide-react';
import { Fragment, useState, type ReactNode } from 'react';

import { PaymentLines } from '../../money/desktop/PaymentLines.js';
import { QrisDialog } from '../../money/desktop/QrisDialog.js';
import { canSimulateQris } from '../../money/qris.js';
import { PaymentMethodField } from '../../money/desktop/PaymentMethodField.js';
import { accountLabel } from '../../money/kas.js';
import {
  chosenMethod,
  methodMissing,
  offeredAccount,
  referenceMissing,
} from '../../money/payment-entry.js';
import { handoverLineLabel, useHandoverChecks } from '../handover-checks.js';
import { freeHandoverNeedsOwner } from '../rules.js';
import { payLaterHintKey, payLaterLines, useHandoverPayment } from '../handover-payment.js';
import { useActionRunner, useCapture, type ActionRunner } from '../../screen-kit/index.js';
import {
  REPAIR_APPROVAL_KIND,
  REPAIR_PERMISSION,
  WORK_PHOTOS_MAX,
  type SlipKind,
  type WorkPhotoStage,
} from '../constants.js';
import { useCancelFeeAsk, type CancelFeeTicket } from '../cancel-fee-ask.js';
import { useDownPaymentAsk } from '../down-payment-ask.js';
import {
  amountOwed,
  askedBecauseKey,
  asksApproval,
  balanceLabelKey,
  INTAKE_PROBLEM_KEY,
  ticketBalance,
  capturedThumbnailRef,
  correctionDraft,
  correctionOptions,
  correctionProblems,
  toCorrectionInput,
  type IntakeDraft,
  type IntakeProblem,
  downPaymentEntry,
  printableSlips,
  priceKinds,
  signedAmount,
  toggled,
  type PriceKind,
  type StaleStep,
  cancelRefund,
} from '../flows.js';
import { repairTypeChoices, storeIntakeOptions } from '../intake-options.js';
import { ta } from '../../approvals/i18n.js';
import {
  cancelDrop,
  cancelRoom,
  standardCancelFee,
  type QuoteLineRow,
  type TicketDetailRow,
} from '../queries.js';
import { tn, type RepairKey } from '../i18n.js';
import {
  cancelConsequenceKey,
  cancelFeeText,
  DOWN_PAYMENT_GAP_KEY,
  INTAKE_STEP_KEY,
  PRICE_KIND_KEY,
  discountLimitHint,
  downPaymentChangeLine,
  downPaymentTitleKey,
  optionLabel,
  refundLabel,
} from '../labels.js';
import {
  useCancelFees,
  useIntakeOptionSettings,
  useDownPaymentMethod,
  usePaymentAccounts,
  useTicketQris,
  useRepairQuery,
  useRepairRuntime,
  type RepairPrinting,
} from '../runtime.js';
import { DESK_PAPERS, paperLabel, useDevicePaper, useDevicePrinters } from '../paper.js';
import { logSlipPrinted, outputSlip } from '../slip-output.js';

import { ActionError, QueryPanel } from '../../screen-kit/desktop/index.js';
import { AccessoryChips, CustomerFields, DeviceFields } from './Intake.js';
import {
  MoneyField,
  PrinterProblemBanner,
  StaleNotice,
  photoLabels,
  usePhotoState,
  usePrinterProblem,
} from './parts.js';

export interface StepDialogProps {
  readonly ticketId: string;
  /** Set once the ticket changed elsewhere and this step can no longer finish. */
  readonly stale: StaleStep | null;
  readonly onDone: () => void;
  readonly onClose: () => void;
}

/** The dialog frame every step shares: the stale notice outranks a refusal, both above the body. */
function StepDialog({
  title,
  description,
  runner,
  stale,
  onRequestClose,
  footer,
  size,
  children,
  testId,
}: {
  readonly title: string;
  readonly description?: ReactNode;
  readonly runner: ActionRunner;
  readonly stale: StaleStep | null;
  readonly onRequestClose: () => void;
  readonly footer: ReactNode;
  readonly size?: 'sm' | 'md' | 'lg';
  readonly children: ReactNode;
  readonly testId: string;
}): React.JSX.Element {
  const banner =
    stale !== null && !runner.busy ? (
      <StaleNotice stale={stale} />
    ) : runner.errorCode !== null ? (
      <ActionError errorCode={runner.errorCode} onDismiss={runner.clearError} />
    ) : undefined;
  return (
    <Dialog
      open
      onRequestClose={onRequestClose}
      title={title}
      description={description}
      closeLabel={t('core.action.close')}
      banner={banner}
      size={size}
      footer={footer}
      testId={testId}
    >
      {/* A step overtaken elsewhere stays readable but cannot be filled in for a refusal. */}
      <fieldset disabled={stale !== null} className="m-0 min-w-0 border-0 p-0 disabled:opacity-60">
        {children}
      </fieldset>
    </Dialog>
  );
}

/** "Kembali", never "Batal": beside "Batalkan servisan" a "Batal" reads as the same thing. */
function CancelButton({ onClick }: { readonly onClick: () => void }): React.JSX.Element {
  return <Button label={t('core.action.back')} onClick={onClick} />;
}

/** Leaving a step that holds photos or notes asks first, so a mis-click does not lose them. */
function useLeaveGuard(dirty: boolean, onClose: () => void) {
  const [asking, setAsking] = useState(false);
  return {
    requestClose: (): void => (dirty ? setAsking(true) : onClose()),
    confirm: (
      <ConfirmDialog
        open={asking}
        title={tn('repair.discardPhotos.title')}
        message={tn('repair.discardPhotos.message')}
        confirmLabel={tn('repair.discardPhotos.confirm')}
        cancelLabel={tn('repair.discardPhotos.keep')}
        closeLabel={t('core.action.close')}
        destructive
        onConfirm={() => {
          setAsking(false);
          onClose();
        }}
        onCancel={() => setAsking(false)}
        testId="repair.desk.leaveStep"
      />
    ),
  };
}

// ── work photos ─────────────────────────────────────────────────────────────────────────────

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

function CapturedTile({
  label,
  photo,
  onRetake,
  testId,
}: {
  readonly label: string;
  readonly photo: MediaRef;
  readonly onRetake: () => void;
  readonly testId: string;
}): React.JSX.Element {
  const state = usePhotoState(capturedThumbnailRef(photo));
  return (
    <CaptureTile
      label={label}
      actionLabel={tn('repair.photo.retake')}
      state={state}
      labels={photoLabels()}
      onCapture={onRetake}
      testId={testId}
    />
  );
}

/** Before photos to start work, or after photos (and a note) to mark it repaired; one at least. */
export function WorkPhotosDialog({
  ticketId,
  stale,
  stage,
  onDone,
  onClose,
}: StepDialogProps & { readonly stage: WorkPhotoStage }): React.JSX.Element {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const [photos, setPhotos] = useState<readonly MediaRef[]>([]);
  const [note, setNote] = useState('');
  const copy = STAGE_COPY[stage];
  const leave = useLeaveGuard(stale === null && (photos.length > 0 || note.trim() !== ''), onClose);
  const testId = `repair.desk.work.${stage}`;

  const media = useCapture(runner);
  const take = (index: number): void => {
    void media
      .capture(() => runtime.capturePhoto({ title: tn(copy.shot, { n: index + 1 }) }))
      .then((captured) => {
        if (captured === undefined || captured === null) return;
        setPhotos((current) =>
          index < current.length
            ? current.map((photo, i) => (i === index ? captured.mediaRef : photo))
            : [...current, captured.mediaRef],
        );
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
    <>
      <StepDialog
        title={tn(copy.title)}
        description={tn(copy.hint)}
        runner={runner}
        stale={stale}
        onRequestClose={leave.requestClose}
        size="lg"
        testId={testId}
        footer={
          <>
            {photos.length === 0 ? (
              <p className="mr-auto text-small text-text-muted">{tn('repair.hint.photo')}</p>
            ) : null}
            <CancelButton onClick={leave.requestClose} />
            <Button
              label={tn(copy.submit)}
              variant="primary"
              onClick={submit}
              busy={media.busy}
              disabled={photos.length === 0 || stale !== null}
              data-testid={`${testId}.submit`}
            />
          </>
        }
      >
        <div className="grid grid-cols-4 gap-3">
          {photos.map((photo, index) => (
            <CapturedTile
              key={photo.mediaId}
              label={tn(copy.shot, { n: index + 1 })}
              photo={photo}
              onRetake={() => take(index)}
              testId={`${testId}.photo.${String(index)}`}
            />
          ))}
          {photos.length < WORK_PHOTOS_MAX ? (
            <CaptureTile
              label={tn(copy.shot, { n: photos.length + 1 })}
              actionLabel={tn('repair.photo.take')}
              state={null}
              labels={photoLabels()}
              onCapture={() => take(photos.length)}
              testId={`${testId}.take`}
            />
          ) : null}
        </div>
        {stage === 'after' ? (
          <TextArea
            className="mt-6"
            label={tn('repair.work.repairNote')}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            data-testid={`${testId}.note`}
          />
        ) : null}
      </StepDialog>
      {leave.confirm}
    </>
  );
}

// ── waiting for parts ───────────────────────────────────────────────────────────────────────

export function WaitForPartsDialog({
  ticketId,
  stale,
  onDone,
  onClose,
}: StepDialogProps): React.JSX.Element {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const [note, setNote] = useState('');
  const submit = (): void => {
    void runner
      .run(() => runtime.run('markWaitingForParts', { ticketId, note }))
      .then((result) => {
        if (result !== undefined) onDone();
      });
  };
  const leave = useLeaveGuard(stale === null && note.trim() !== '', onClose);
  return (
    <>
      <StepDialog
        title={tn('repair.action.waitForParts')}
        runner={runner}
        stale={stale}
        onRequestClose={leave.requestClose}
        size="sm"
        testId="repair.desk.waitForParts"
        footer={
          <>
            <CancelButton onClick={leave.requestClose} />
            <Button
              label={tn('repair.action.waitForParts')}
              variant="primary"
              onClick={submit}
              busy={runner.busy}
              disabled={stale !== null}
              data-testid="repair.desk.waitForParts.submit"
            />
          </>
        }
      >
        <TextArea
          label={tn('repair.work.partsNote')}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          autoFocus
          data-testid="repair.desk.waitForParts.note"
        />
      </StepDialog>
      {leave.confirm}
    </>
  );
}

// ── repair types ──────────────────────────────────────────────────────────────────────────────

/** What is being repaired, changed once the diagnosis shows it (the phone's RepairTypesStep). */
export function RepairTypesDialog({
  ticketId,
  stale,
  current,
  onDone,
  onClose,
}: StepDialogProps & { readonly current: TicketDetailRow['repairTypes'] }): React.JSX.Element {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const settings = useIntakeOptionSettings();
  const [picked, setPicked] = useState<readonly string[]>(() => current.map((type) => type.item));
  const changed =
    picked.length !== current.length || picked.some((id, i) => id !== current[i]!.item);
  const submit = (): void => {
    if (!changed) {
      onClose();
      return;
    }
    void runner
      .run(() => runtime.run('setRepairTypes', { ticketId, repairTypes: [...picked] }))
      .then((result) => {
        if (result !== undefined) onDone();
      });
  };
  return (
    <StepDialog
      title={tn('repair.repairTypes.title')}
      runner={runner}
      stale={stale}
      onRequestClose={onClose}
      size="sm"
      testId="repair.desk.repairTypes"
      footer={
        <>
          <CancelButton onClick={onClose} />
          <Button
            label={tn('repair.repairTypes.save')}
            variant="primary"
            onClick={submit}
            busy={runner.busy}
            disabled={stale !== null}
            data-testid="repair.desk.repairTypes.submit"
          />
        </>
      }
    >
      <QueryPanel query={settings} onRetry={() => undefined}>
        {(data) => (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2" data-testid="repair.desk.repairTypes.chips">
              {repairTypeChoices(storeIntakeOptions(data).repairTypes, current).map((option) => (
                <ToggleChip
                  key={option.id}
                  label={optionLabel('repairTypes', option)}
                  selected={picked.includes(option.id)}
                  onToggle={() => setPicked((ids) => toggled(ids, option.id))}
                />
              ))}
            </div>
            <p className="text-small text-text-muted">{tn('repair.warranty.fromPickup')}</p>
          </div>
        )}
      </QueryPanel>
    </StepDialog>
  );
}

// ── cancel (owners; the counter asks one) ───────────────────────────────────────────────────

/**
 * Cancel a servisan: the store's fee for its stage is filled in, the owner may change it, and the
 * reason is always required. The fee is what the customer signs for at handover. Someone who may
 * not cancel, or not at a fee that far below the store's, asks an owner instead (`onAsked`).
 */
export function CancelDialog({
  ticketId,
  stale,
  workStarted,
  price,
  claimOf,
  downPayment,
  discounted,
  onDone,
  onAsked,
  onClose,
}: StepDialogProps & {
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
}): React.JSX.Element {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const [reloadNonce, setReloadNonce] = useState(0);
  const fees = useCancelFees(reloadNonce);
  const [reason, setReason] = useState('');
  // Null until the owner chooses to change it; the store's fee applies until then.
  const [fee, setFee] = useState<number | null | undefined>(undefined);
  const changing = fee !== undefined;
  const standard =
    fees.status === 'ready'
      ? standardCancelFee({ workStarted, claimOfTicketId: claimOf, quoteTotal: price }, fees.data)
      : null;
  const charged = changing ? fee : standard;
  const changed = standard !== null && charged !== null && charged !== standard;
  const complete = charged !== null && reason.trim() !== '';
  const holds = runtime.hasPermission(REPAIR_PERMISSION.cancel);
  // A limited role (a manager) sees how far below the store's fee they may go before it is asked.
  const limit = holds ? runtime.limitOf(REPAIR_PERMISSION.cancel) : null;
  const asking = asksApproval(
    holds,
    limit,
    standard === null || charged === null ? 0 : cancelDrop(standard, charged, discounted),
  );
  const room = cancelRoom(limit, standard, discounted);

  const submit = (): void => {
    if (!complete || charged === null) return;
    // An unchanged fee is left to the command, which fills in the store's fee as it is then.
    const input = changing ? { ticketId, reason, fee: charged } : { ticketId, reason };
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

  const leave = useLeaveGuard(
    stale === null && (reason.trim() !== '' || fee !== undefined),
    onClose,
  );
  return (
    <>
      <StepDialog
        title={tn('repair.cancel.title')}
        description={
          cancelRefund(downPayment, charged) > 0
            ? tn('repair.cancel.refundsDp', {
                amount: formatMoney(cancelRefund(downPayment, charged)),
              })
            : tn(cancelConsequenceKey(charged))
        }
        runner={runner}
        stale={stale}
        onRequestClose={leave.requestClose}
        testId="repair.desk.cancel"
        footer={
          <>
            {complete ? null : (
              <p className="mr-auto text-small text-text-muted">
                {tn(
                  charged === null && fees.status !== 'loading'
                    ? 'repair.hint.cancelFee'
                    : 'repair.hint.reason',
                )}
              </p>
            )}
            <CancelButton onClick={leave.requestClose} />
            <Button
              label={asking ? ta('approvals.action.ask') : tn('repair.action.cancel')}
              variant={asking ? 'primary' : 'danger'}
              onClick={submit}
              busy={runner.busy}
              disabled={!complete || stale !== null}
              data-testid="repair.desk.cancel.submit"
            />
          </>
        }
      >
        <QueryPanel query={fees} onRetry={() => setReloadNonce((n) => n + 1)}>
          {() => (
            <div className="rounded-sm bg-surface-alt p-4" data-testid="repair.desk.cancel.fee">
              <div className="flex items-center justify-between gap-4">
                <p className="text-small text-text-muted">{tn('repair.cancel.fee')}</p>
                {changing ? null : (
                  <Button
                    label={tn('repair.cancel.changeFee')}
                    aria-label={tn('repair.cancel.changeFeeLabel')}
                    variant="text"
                    size="sm"
                    className="-my-1 -mr-2"
                    onClick={() => setFee(standard ?? 0)}
                    data-testid="repair.desk.cancel.changeFee"
                  />
                )}
              </div>
              {changing ? (
                <MoneyField
                  className="mt-2"
                  label={tn('repair.cancel.feeInput')}
                  value={fee}
                  onChange={setFee}
                  autoFocus
                  data-testid="repair.desk.cancel.feeInput"
                />
              ) : (
                <p className="tabular text-title font-bold text-text">
                  {charged === null ? '–' : formatMoney(charged)}
                </p>
              )}
              <p className="mt-1 text-small text-text-muted">
                {changed
                  ? tn('repair.cancel.storeFee', { amount: formatMoney(standard) })
                  : tn(
                      claimOf !== null
                        ? 'repair.cancel.claimFree'
                        : workStarted
                          ? 'repair.cancel.afterWork'
                          : 'repair.cancel.beforeWork',
                    )}
              </p>
              {!changing || room === null ? null : (
                <p
                  className="mt-1 text-small text-text-muted"
                  data-testid="repair.desk.cancel.limit"
                >
                  {tn('repair.hint.cancelLimit', { amount: formatMoney(room) })}
                </p>
              )}
            </div>
          )}
        </QueryPanel>
        <TextArea
          className="mt-4"
          label={tn('repair.cancel.reason')}
          hint={changed ? tn('repair.cancel.feeChangedHint') : undefined}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          data-testid="repair.desk.cancel.reason"
        />
        {asking ? (
          <p className="mt-4 text-small text-text-muted" data-testid="repair.desk.cancel.asks">
            {tn(askedBecauseKey(holds))}
          </p>
        ) : null}
      </StepDialog>
      {leave.confirm}
    </>
  );
}

// ── undo a handover (owners) ────────────────────────────────────────────────────────────────

/** Take back a handover recorded by mistake: the phone is in the store again. A reason is required. */
export function UndoHandoverDialog({
  ticketId,
  stale,
  onDone,
  onClose,
}: StepDialogProps): React.JSX.Element {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const [reason, setReason] = useState('');
  const complete = reason.trim() !== '';
  const submit = (): void => {
    if (!complete) return;
    void runner
      .run(() => runtime.run('undoHandover', { ticketId, reason }))
      .then((result) => {
        if (result !== undefined) onDone();
      });
  };
  const leave = useLeaveGuard(stale === null && complete, onClose);
  return (
    <>
      <StepDialog
        title={tn('repair.undoHandover.title')}
        description={tn('repair.undoHandover.explain')}
        runner={runner}
        stale={stale}
        onRequestClose={leave.requestClose}
        size="sm"
        testId="repair.desk.undoHandover"
        footer={
          <>
            <CancelButton onClick={leave.requestClose} />
            <Button
              label={tn('repair.action.undoHandover')}
              variant="danger"
              onClick={submit}
              busy={runner.busy}
              disabled={!complete || stale !== null}
              data-testid="repair.desk.undoHandover.submit"
            />
          </>
        }
      >
        <TextArea
          label={tn('repair.undoHandover.reason')}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          autoFocus
          data-testid="repair.desk.undoHandover.reason"
        />
      </StepDialog>
      {leave.confirm}
    </>
  );
}

// ── change a cancelled servisan's fee (owners) ──────────────────────────────────────────────

/**
 * Set a cancelled servisan's fee afterwards, e.g. when a phone was handed over and paid on another
 * device after the cancel: the bill follows the new fee, charging or giving back the difference.
 */
export function ChangeCancelFeeDialog({
  ticketId,
  stale,
  ticket,
  current,
  paid,
  onDone,
  onAsked,
  onClose,
}: StepDialogProps & {
  readonly ticket: CancelFeeTicket;
  /** The fee standing now. */
  readonly current: number;
  /** Paid in so far, which the new fee is settled against. */
  readonly paid: number;
  /** A manager beyond their limit asked an owner instead. */
  readonly onAsked: () => void;
}): React.JSX.Element {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const [fee, setFee] = useState<number | null>(current);
  const [reason, setReason] = useState('');
  const changed = fee !== null && fee !== current;
  const complete = changed && reason.trim() !== '';
  const ask = useCancelFeeAsk(ticket, current, changed ? fee : null);
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
  const leave = useLeaveGuard(stale === null && (changed || reason.trim() !== ''), onClose);
  return (
    <>
      <StepDialog
        title={tn('repair.cancelFee.title')}
        description={
          paid > 0
            ? tn('repair.cancelFee.paid', {
                bill: formatMoney(current),
                amount: formatMoney(paid),
              })
            : tn('repair.cancelFee.unpaid', { bill: formatMoney(current) })
        }
        runner={runner}
        stale={stale}
        onRequestClose={leave.requestClose}
        size="sm"
        testId="repair.desk.cancelFee"
        footer={
          <>
            {complete ? null : (
              <p className="mr-auto text-small text-text-muted">
                {tn(
                  fee === null
                    ? 'repair.hint.cancelFee'
                    : changed
                      ? 'repair.hint.reason'
                      : 'repair.cancelFee.same',
                )}
              </p>
            )}
            <CancelButton onClick={leave.requestClose} />
            <Button
              label={ask.asking ? ta('approvals.action.ask') : tn('repair.cancelFee.save')}
              variant="primary"
              onClick={submit}
              busy={runner.busy}
              disabled={!complete || stale !== null}
              data-testid="repair.desk.cancelFee.submit"
            />
          </>
        }
      >
        <MoneyField
          label={tn('repair.cancelFee.input')}
          value={fee}
          onChange={setFee}
          autoFocus
          data-testid="repair.desk.cancelFee.feeInput"
        />
        <TextArea
          className="mt-4"
          label={tn('repair.cancelFee.reason')}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          data-testid="repair.desk.cancelFee.reason"
        />
        {ask.asking ? (
          <p className="mt-4 text-small text-text-muted" data-testid="repair.desk.cancelFee.asks">
            {tn(askedBecauseKey(true))}
          </p>
        ) : null}
      </StepDialog>
      {leave.confirm}
    </>
  );
}

// ── correct what intake wrote down ──────────────────────────────────────────────────────────

/**
 * Put right the customer, the phone, the complaint or what was left with it, in intake's own
 * fields. Only what differs is saved, and the history keeps what it was.
 */
export function CorrectDetailsDialog({
  ticket,
  stale,
  onDone,
  onClose,
}: Omit<StepDialogProps, 'ticketId'> & { readonly ticket: TicketDetailRow }): React.JSX.Element {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const settings = useIntakeOptionSettings();
  const [initial] = useState(() => correctionDraft(ticket));
  const [draft, setDraft] = useState(initial);
  const [reason, setReason] = useState('');
  const [showProblems, setShowProblems] = useState(false);
  const update = (patch: Partial<IntakeDraft>): void => setDraft((d) => ({ ...d, ...patch }));
  const options =
    settings.status === 'ready'
      ? correctionOptions(storeIntakeOptions(settings.data), ticket)
      : null;
  const problems = options === null ? [] : correctionProblems(draft, options);
  const problemText = (problem: IntakeProblem): string | undefined =>
    showProblems && problems.includes(problem) ? tn(INTAKE_PROBLEM_KEY[problem]) : undefined;
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial) || reason.trim() !== '';
  const handedOver = ticket.returnedAt !== null;

  const submit = (): void => {
    if (options === null) return;
    if (problems.length > 0) {
      setShowProblems(true);
      // The first field to fix may be below the fold of the dialog: take the counter to it.
      requestAnimationFrame(() =>
        document
          .querySelector<HTMLElement>('[data-testid="repair.desk.correct"] [aria-invalid="true"]')
          ?.focus(),
      );
      return;
    }
    if (JSON.stringify(draft) === JSON.stringify(initial)) {
      onClose();
      return;
    }
    void runner
      .run(() =>
        runtime.run('correctTicketDetails', toCorrectionInput(ticket, draft, options, reason)),
      )
      .then((result) => {
        if (result !== undefined) onDone();
      });
  };
  const leave = useLeaveGuard(stale === null && dirty, onClose);
  return (
    <>
      <StepDialog
        title={tn('repair.correct.title')}
        description={tn('repair.correct.about')}
        runner={runner}
        stale={stale}
        onRequestClose={leave.requestClose}
        size="lg"
        testId="repair.desk.correct"
        footer={
          <>
            <CancelButton onClick={leave.requestClose} />
            <Button
              label={tn('repair.correct.save')}
              variant="primary"
              onClick={submit}
              busy={runner.busy}
              disabled={stale !== null || options === null}
              data-testid="repair.desk.correct.submit"
            />
          </>
        }
      >
        <QueryPanel query={settings} onRetry={() => undefined}>
          {() =>
            options === null ? null : (
              <div className="flex flex-col gap-6 @container">
                {/* The slip signed at a handover (since taken back) names this customer and phone. */}
                {handedOver ? (
                  <p className="text-body text-text-muted">
                    {tn('repair.correct.handedOverLocked')}
                  </p>
                ) : (
                  <>
                    <section className="flex flex-col gap-3">
                      <h3 className="text-heading font-semibold text-text">
                        {tn(INTAKE_STEP_KEY.customer)}
                      </h3>
                      <CustomerFields
                        draft={draft}
                        update={update}
                        nameError={problemText('customerName')}
                        phoneError={problemText('customerPhone')}
                        currentCustomerId={ticket.customerId}
                      />
                    </section>
                    <section className="flex flex-col gap-3">
                      <h3 className="text-heading font-semibold text-text">
                        {tn(INTAKE_STEP_KEY.device)}
                      </h3>
                      {/* A claim is for its servisan's phone: the rule refuses another one. */}
                      {ticket.claimOfTicketId === null ? (
                        <DeviceFields
                          draft={draft}
                          update={update}
                          options={options}
                          brandError={problemText('deviceBrand')}
                          modelError={problemText('deviceModel')}
                          imeiError={problemText('deviceImei')}
                          lockError={problemText('screenLock')}
                        />
                      ) : (
                        <p className="text-body text-text-muted">
                          {tn('repair.correct.claimDevice')}
                        </p>
                      )}
                    </section>
                  </>
                )}
                <section className="flex flex-col gap-4">
                  <h3 className="text-heading font-semibold text-text">
                    {tn(INTAKE_STEP_KEY.condition)}
                  </h3>
                  <TextArea
                    label={tn('repair.condition.complaint')}
                    value={draft.complaint}
                    onChange={(event) => update({ complaint: event.target.value })}
                    error={problemText('complaint')}
                    rows={2}
                    data-testid="repair.desk.correct.complaint"
                  />
                  <AccessoryChips draft={draft} update={update} accessories={options.accessories} />
                </section>
                <TextField
                  label={tn('repair.correct.reason')}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  maxLength={500}
                  data-testid="repair.desk.correct.reason"
                />
              </div>
            )
          }
        </QueryPanel>
      </StepDialog>
      {leave.confirm}
    </>
  );
}

// ── assign ──────────────────────────────────────────────────────────────────────────────────

export function AssignDialog({
  ticketId,
  stale,
  currentTechnicianId,
  onDone,
  onClose,
}: StepDialogProps & { readonly currentTechnicianId: string | null }): React.JSX.Element {
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
    <StepDialog
      title={tn(currentTechnicianId === null ? 'repair.action.assign' : 'repair.action.reassign')}
      runner={runner}
      stale={stale}
      onRequestClose={onClose}
      size="sm"
      testId="repair.desk.assign"
      footer={<CancelButton onClick={onClose} />}
    >
      <QueryPanel query={technicians} onRetry={() => setReloadNonce((n) => n + 1)}>
        {(rows) =>
          rows.length === 0 ? (
            <p className="text-body text-text-muted">{tn('repair.assign.none')}</p>
          ) : (
            <ul className="-mx-2 flex flex-col">
              {rows.map((tech) => {
                const current = tech.id === currentTechnicianId;
                return (
                  <li key={tech.id}>
                    <button
                      type="button"
                      onClick={() => assign(tech.id)}
                      disabled={runner.busy}
                      aria-current={current || undefined}
                      data-testid={`repair.desk.assign.${tech.id}`}
                      className="flex w-full cursor-pointer items-center gap-3 rounded-sm px-2 py-2 text-left hover:bg-surface-alt disabled:cursor-wait"
                    >
                      <Avatar userId={tech.id} name={tech.name} size={40} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-body font-semibold text-text">{tech.name}</span>
                        <span className="block text-small text-text-muted">
                          {tn('repair.assign.load', { count: tech.load })}
                        </span>
                      </span>
                      {current ? <Check size={20} className="text-success" aria-hidden /> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )
        }
      </QueryPanel>
    </StepDialog>
  );
}

// ── price changes ───────────────────────────────────────────────────────────────────────────

/**
 * A new price line after intake. The counter changes the price and answers whether the customer
 * already agreed as the save itself ("Sudah" / "Belum"); a technician only proposes it. A discount
 * the counter may not give (or not that large) goes to an owner instead (`onAsked`), and asks the
 * customer once it is approved.
 */
export function PriceChangeDialog({
  ticketId,
  stale,
  mode,
  discounted,
  onDone,
  onAsked,
  onClose,
}: StepDialogProps & {
  readonly mode: 'change' | 'propose';
  /** What the discounts already on the servisan take off; a limit counts them too. */
  readonly discounted: number;
  /** Set where a discount may be asked of an owner (changing the price, not proposing it). */
  readonly onAsked?: (() => void) | undefined;
}): React.JSX.Element {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const holdsDiscount = runtime.hasPermission(REPAIR_PERMISSION.discount);
  const kinds = priceKinds(holdsDiscount || onAsked !== undefined);
  // A limited role (a manager) sees how far they may discount before it goes to an owner.
  const discountLimit = runtime.limitOf(REPAIR_PERMISSION.discount);
  const [kind, setKind] = useState<PriceKind>('part');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const complete = description.trim() !== '' && amount !== null && reason.trim() !== '';
  const testId = `repair.desk.price.${mode}`;
  const asking =
    onAsked !== undefined &&
    kind === 'discount' &&
    asksApproval(holdsDiscount, discountLimit, discounted + (amount ?? 0));

  const submit = (customerAgreed: boolean): void => {
    if (!complete || amount === null) return;
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
  const blocked = !complete || stale !== null;

  const leave = useLeaveGuard(
    stale === null && (description.trim() !== '' || amount !== null || reason.trim() !== ''),
    onClose,
  );
  return (
    <>
      <StepDialog
        title={tn('repair.price.editTitle')}
        runner={runner}
        stale={stale}
        onRequestClose={leave.requestClose}
        testId={testId}
        footer={
          mode === 'change' && !asking ? (
            <>
              <p id={`${testId}.question`} className="mr-auto text-body font-semibold text-text">
                {tn('repair.price.alreadyAgreed')}
              </p>
              <Button
                label={tn('repair.action.applyUnconfirmed')}
                onClick={() => submit(false)}
                aria-describedby={`${testId}.question`}
                disabled={blocked || runner.busy}
                data-testid={`${testId}.unconfirmed`}
              />
              <Button
                label={tn('repair.action.agreedYes')}
                variant="primary"
                onClick={() => submit(true)}
                aria-describedby={`${testId}.question`}
                busy={runner.busy}
                disabled={blocked}
                data-testid={`${testId}.agreed`}
              />
            </>
          ) : (
            <>
              {complete ? null : (
                <p className="mr-auto text-small text-text-muted">{tn('repair.hint.priceLine')}</p>
              )}
              <CancelButton onClick={leave.requestClose} />
              <Button
                label={asking ? ta('approvals.action.ask') : tn('repair.action.proposePrice')}
                variant="primary"
                onClick={() => submit(true)}
                busy={runner.busy}
                disabled={blocked}
                data-testid={`${testId}.submit`}
              />
            </>
          )
        }
      >
        <div className="flex flex-col gap-4">
          <Segmented
            label={tn('repair.desk.priceKind')}
            options={kinds.map((value) => ({ value, label: tn(PRICE_KIND_KEY[value]) }))}
            value={kind}
            onChange={setKind}
            testId={`${testId}.kind`}
          />
          <div className="grid grid-cols-[minmax(0,1fr)_180px] gap-4">
            <TextField
              label={tn('repair.price.description')}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              autoFocus
              data-testid={`${testId}.description`}
            />
            <MoneyField
              // The field already shows "Rp", so the label does not repeat it.
              label={tn(kind === 'discount' ? 'repair.price.kind.discount' : 'repair.desk.price')}
              hint={
                amount === null || kind !== 'discount'
                  ? undefined
                  : formatMoney(signedAmount(kind, amount))
              }
              value={amount}
              onChange={setAmount}
              data-testid={`${testId}.amount`}
            />
          </div>
          <TextArea
            label={tn('repair.price.reason')}
            rows={2}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            data-testid={`${testId}.reason`}
          />
          {kind !== 'discount' || !holdsDiscount || discountLimit === null ? null : (
            <p className="text-small text-text-muted" data-testid={`${testId}.discountLimit`}>
              {discountLimitHint(discountLimit, discounted)}
            </p>
          )}
          {asking ? (
            <p className="text-small text-text-muted" data-testid={`${testId}.asks`}>
              {tn(askedBecauseKey(holdsDiscount))}
            </p>
          ) : mode === 'change' ? (
            <p className="text-small text-text-muted">{tn('repair.price.waitsHint')}</p>
          ) : null}
        </div>
      </StepDialog>
      {leave.confirm}
    </>
  );
}

/**
 * The counter decides a waiting price change with the customer's answer as the choice itself:
 * agreed and applied, or declined. A change never counts without the customer's yes.
 */
export function ProposalDialog({
  ticketId,
  stale,
  line,
  total,
  onDone,
  onClose,
}: StepDialogProps & {
  readonly line: QuoteLineRow;
  /** The agreed total now, so the change reads as what the customer will pay. */
  readonly total: number;
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
          : runtime.run('applyProposal', { ticketId, lineId: line.id, customerAgreed: true, note }),
      )
      .then((result) => {
        if (result !== undefined) onDone();
      });
  };
  const leave = useLeaveGuard(stale === null && note.trim() !== '', onClose);
  return (
    <>
      <StepDialog
        title={tn('repair.price.proposalTitle')}
        runner={runner}
        stale={stale}
        onRequestClose={leave.requestClose}
        testId="repair.desk.proposal"
        footer={
          <>
            <p
              id="repair.desk.proposal.question"
              className="mr-auto text-body font-semibold text-text"
            >
              {tn('repair.price.customerAgrees')}
            </p>
            <Button
              label={tn('repair.action.declinePrice')}
              onClick={() => decide('declined')}
              aria-describedby="repair.desk.proposal.question"
              disabled={runner.busy || stale !== null}
              data-testid="repair.desk.proposal.decline"
            />
            <Button
              label={tn('repair.action.agreeApply')}
              variant="primary"
              onClick={() => decide('agreed')}
              aria-describedby="repair.desk.proposal.question"
              busy={runner.busy}
              disabled={!mayApply || stale !== null}
              data-testid="repair.desk.proposal.agree"
            />
          </>
        }
      >
        <div className="rounded-sm bg-surface-alt p-4">
          <p className="text-small text-text-muted">{tn(PRICE_KIND_KEY[line.kind])}</p>
          <p className="text-body font-semibold text-text">{line.description}</p>
          <p
            className="tabular mt-1 text-title font-bold text-text"
            data-testid="repair.desk.proposal.amount"
          >
            {formatMoney(line.amount)}
          </p>
          {/* An extra zero shows here, where the customer hears it: 1.500.000 → 3.500.000. */}
          <p
            className="tabular mt-1 text-body text-text"
            data-testid="repair.desk.proposal.newTotal"
          >
            {tn('repair.price.newTotal', {
              from: formatMoney(total),
              to: formatMoney(total + line.amount),
            })}
          </p>
          {line.reason === null ? null : (
            <>
              <p className="mt-3 text-small text-text-muted">{tn('repair.price.changeReason')}</p>
              <p className="text-body text-text">{line.reason}</p>
            </>
          )}
        </div>
        {mayApply ? null : (
          <p className="mt-3 text-small text-warning">{tn('repair.hint.discountOwner')}</p>
        )}
        <TextField
          className="mt-4"
          label={tn('repair.price.decisionNote')}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          data-testid="repair.desk.proposal.note"
        />
      </StepDialog>
      {leave.confirm}
    </>
  );
}

// ── handover ────────────────────────────────────────────────────────────────────────────────

/**
 * Giving the device back: the checklist gone through with the customer (anything not ticked needs a
 * note), the payment, then a photo of the handover and the customer's signature, both required.
 * The amount shown is what the customer owes and signs for: the price on a repaired phone, the
 * cancellation fee on a cancelled one.
 */
export function HandoverDialog({
  ticket,
  ticketId,
  stale,
  customerName,
  onDone,
  onClose,
}: StepDialogProps & {
  /**
   * What the checklist is made of (whether it was repaired, what was left with it), and what the
   * customer is billed, paid already and gets back through each method.
   */
  readonly ticket: Pick<
    TicketDetailRow,
    | 'outcome'
    | 'peripherals'
    | 'quoteTotal'
    | 'cancelFee'
    | 'reduced'
    | 'downPayment'
    | 'refunds'
    | 'claimOfTicketId'
    | 'ticketNumber'
    | 'deviceBrand'
    | 'deviceModel'
  >;
  readonly customerName: string;
}): React.JSX.Element {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const [photo, setPhoto] = useState<MediaRef | null>(null);
  const [signature, setSignature] = useState<MediaRef | null>(null);
  const [note, setNote] = useState('');
  // Until the store's methods load, a method picked earlier would read as cash.
  const loadedAccounts = usePaymentAccounts();
  const accounts = loadedAccounts ?? [];
  const cancelled = ticket.outcome === 'cancelled';
  const { downPayment, reduced } = ticket;
  /** The price, or a cancelled servisan's fee, before any reduction (shown beneath it). */
  const amount = amountOwed(ticket) + reduced;
  const balance = ticketBalance(ticket);
  const split = balance.kind === 'refund' ? ticket.refunds : [];
  const due = balance.kind === 'due' ? balance.amount : 0;
  const qris = useTicketQris(ticketId, ticket.ticketNumber);
  const payment = useHandoverPayment(ticketId, due, accounts, qris);
  const { settled } = payment;
  const checks = useHandoverChecks(ticket);
  const leave = useLeaveGuard(
    stale === null &&
      (photo !== null ||
        signature !== null ||
        note.trim() !== '' ||
        payment.touched ||
        checks.touched),
    onClose,
  );
  const photoState = usePhotoState(photo === null ? null : capturedThumbnailRef(photo));
  const signatureState = usePhotoState(signature === null ? null : capturedThumbnailRef(signature));

  const media = useCapture(runner);
  const capture = (
    take: () => Promise<{ readonly mediaRef: MediaRef } | null>,
    keep: (ref: MediaRef) => void,
  ): void => {
    void media.capture(take).then((captured) => {
      if (captured !== undefined && captured !== null) keep(captured.mediaRef);
    });
  };
  const captured = photo !== null && signature !== null;
  const ownerNeeded =
    freeHandoverNeedsOwner(ticket) && !runtime.hasPermission(REPAIR_PERMISSION.warrantyException);
  const complete =
    !ownerNeeded && captured && settled && loadedAccounts !== null && checks.ready(note);
  const submit = (): void => {
    if (!complete || photo === null || signature === null) return;
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
        if (result !== undefined) onDone();
      });
  };

  return (
    <>
      <StepDialog
        title={tn('repair.handover.title')}
        // Which phone it is, as the phone app shows it: a customer with two ready names both.
        description={
          <span data-testid="repair.desk.handover.phone">
            {`${ticket.deviceBrand} ${ticket.deviceModel} · ${ticket.ticketNumber}`}
          </span>
        }
        runner={runner}
        stale={stale}
        onRequestClose={leave.requestClose}
        testId="repair.desk.handover"
        footer={
          <>
            {complete ? null : (
              <p className="mr-auto text-small text-text-muted">
                {tn(
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
              </p>
            )}
            <CancelButton onClick={leave.requestClose} />
            <Button
              label={tn('repair.action.handover')}
              variant="primary"
              onClick={submit}
              busy={media.busy}
              disabled={!complete || stale !== null}
              data-testid="repair.desk.handover.submit"
            />
          </>
        }
      >
        <div className="rounded-sm bg-surface-alt p-4">
          <div className="flex items-end justify-between gap-4">
            <div className="min-w-0">
              <p className="text-small text-text-muted">{customerName}</p>
              <p className="text-body font-semibold text-text">
                {tn(cancelled ? 'repair.cancel.fee' : 'repair.price.total')}
              </p>
            </div>
            <p
              className="tabular text-title font-bold text-text"
              data-testid="repair.desk.handover.total"
            >
              <RollingText value={amount}>
                {cancelled ? cancelFeeText(amount) : formatMoney(amount)}
              </RollingText>
            </p>
          </div>
          {(downPayment ?? 0) === 0 && reduced === 0 ? null : (
            <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 border-t border-border pt-2 text-body">
              {reduced === 0 ? null : (
                <>
                  <dt className="text-text-muted">{tn('repair.price.reduced')}</dt>
                  <dd
                    className="tabular text-right text-text"
                    data-testid="repair.desk.handover.reduced"
                  >
                    {formatMoney(-reduced)}
                  </dd>
                </>
              )}
              {downPayment === null || downPayment === 0 ? null : (
                <>
                  {/* The DP and anything paid at this counter already (a QR): all of it is paid. */}
                  <dt className="text-text-muted">{tn('repair.price.paid')}</dt>
                  <dd className="tabular text-right text-text">
                    <RollingText value={downPayment}>{formatMoney(-downPayment)}</RollingText>
                  </dd>
                </>
              )}
              {split.length === 0 ? (
                <>
                  <dt className="font-semibold text-text">
                    {tn(balanceLabelKey(balance.kind, false))}
                  </dt>
                  <dd
                    className="tabular text-right font-semibold text-text"
                    data-testid="repair.desk.handover.balance"
                  >
                    <RollingText value={balance.kind === 'due' ? balance.amount : -balance.amount}>
                      {formatMoney(balance.amount)}
                    </RollingText>
                  </dd>
                </>
              ) : (
                split.map((refund) => (
                  <Fragment key={refund.account}>
                    <dt className="font-semibold text-text">{refundLabel(refund, 'screen')}</dt>
                    <dd
                      className="tabular text-right font-semibold text-text"
                      data-testid={`repair.desk.handover.refund.${refund.account}`}
                    >
                      {formatMoney(refund.amount)}
                    </dd>
                  </Fragment>
                ))
              )}
            </dl>
          )}
        </div>
        {cancelled ? (
          <p className="mt-2 text-small text-text-muted">{tn('repair.handover.cancelled')}</p>
        ) : null}
        {checks.lines.length === 0 || stale !== null ? null : (
          <section className="mt-4" data-testid="repair.desk.handover.checks">
            <h3 className="mb-2 text-body font-semibold text-text">
              {tn('repair.handover.checks')}
            </h3>
            <div className="flex flex-wrap gap-2">
              {checks.lines.map((line) => (
                <ToggleChip
                  key={`${line.kind}:${line.item}`}
                  label={handoverLineLabel(line)}
                  selected={line.done}
                  onToggle={() => checks.toggle(line)}
                />
              ))}
            </div>
          </section>
        )}
        {due > 0 && stale === null ? (
          <section className="mt-4" data-testid="repair.desk.handover.payment">
            <div className="mb-2 flex items-center justify-between gap-3">
              <h3 className="text-body font-semibold text-text">{tn('repair.handover.payment')}</h3>
              {payment.access.kind === 'none' ? null : (
                <Button
                  label={tn(payment.unpaid ? 'repair.handover.payNow' : 'repair.handover.payLater')}
                  variant="text"
                  size="sm"
                  onClick={() => {
                    // A refusal of the other way to settle no longer applies.
                    runner.clearError();
                    payment.togglePayLater();
                  }}
                  data-testid="repair.desk.handover.payLater"
                />
              )}
            </div>
            {payment.unpaid ? (
              <div>
                <TextArea
                  label={tn('repair.handover.payLaterReason')}
                  rows={2}
                  value={payment.unpaidReason}
                  onChange={(event) => payment.setUnpaidReason(event.target.value)}
                  data-testid="repair.desk.handover.unpaidReason"
                />
                {payLaterLines(payment, due).map((line) => (
                  <p
                    key={line.id}
                    className="mt-2 text-small text-text-muted"
                    data-testid={`repair.desk.handover.${line.id}`}
                  >
                    {line.text}
                  </p>
                ))}
                {payment.access.kind === 'ask' ? (
                  <Button
                    className="mt-3"
                    label={ta('approvals.action.ask')}
                    variant="secondary"
                    size="sm"
                    disabled={payment.unpaidReason.trim() === '' || runner.busy}
                    onClick={() => void runner.run(payment.askPayLater)}
                    data-testid="repair.desk.handover.askPayLater"
                  />
                ) : null}
              </div>
            ) : (
              <PaymentLines
                lines={payment.lines}
                entry={payment.entry}
                accounts={accounts}
                onChange={payment.setLines}
                newKey={payment.newKey}
                qris={payment.qris}
                testId="repair.desk.handover.pay"
              />
            )}
          </section>
        ) : null}
        <div className="mt-4 grid grid-cols-2 gap-4">
          <CaptureTile
            label={tn('repair.handover.photo')}
            actionLabel={tn(photo === null ? 'repair.photo.take' : 'repair.photo.retake')}
            state={photo === null ? null : photoState}
            labels={photoLabels()}
            onCapture={() =>
              capture(() => runtime.capturePhoto({ title: tn('repair.handover.photo') }), setPhoto)
            }
            testId="repair.desk.handover.photo"
          />
          <CaptureTile
            label={tn('repair.handover.signature')}
            actionLabel={tn(
              signature === null ? 'repair.handover.sign' : 'repair.handover.signAgain',
            )}
            state={signature === null ? null : signatureState}
            labels={photoLabels()}
            icon={Signature}
            whole
            onCapture={() =>
              capture(
                () => runtime.captureSignature({ title: tn('repair.handover.signatureTitle') }),
                setSignature,
              )
            }
            testId="repair.desk.handover.signature"
          />
        </div>
        <TextArea
          className="mt-4"
          label={tn(checks.noteNeeded ? 'repair.handover.noteNeeded' : 'repair.handover.note')}
          rows={2}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          data-testid="repair.desk.handover.note"
        />
      </StepDialog>
      {payment.qris.open !== null && qris.port !== undefined ? (
        <QrisDialog
          open={payment.qris.open}
          port={qris.port}
          canSimulate={canSimulateQris(runtime.hasPermission)}
          onPaid={payment.qris.paid}
          onRenew={payment.qris.renew}
          onTakeByHand={payment.qris.takeByHand}
          onClose={payment.qris.close}
          testId="repair.desk.handover.qris"
        />
      ) : null}
      {leave.confirm}
    </>
  );
}

// ── down payment ────────────────────────────────────────────────────────────────────────────

/**
 * Recording a down payment the customer left after intake, or (owners only) correcting one: the
 * same rules as the phone (`downPaymentEntry` and the commands), as one small dialog.
 */
export function DownPaymentDialog({
  ticketId,
  stale,
  mode,
  current,
  total,
  onDone,
  onAsked,
  onClose,
}: StepDialogProps & {
  readonly mode: 'record' | 'correct';
  /** The down payment recorded now; null when none is. */
  readonly current: number | null;
  readonly total: number;
  /** A fix beyond this person was asked of an owner instead. */
  readonly onAsked: () => void;
}): React.JSX.Element {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const [typed, setTyped] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [method, setMethod] = useDownPaymentMethod(ticketId, mode);
  // Until the store's methods load, a method picked earlier would read as cash.
  const loadedAccounts = usePaymentAccounts();
  const accounts = loadedAccounts ?? [];
  const correcting = mode === 'correct';
  const { amount, aboveTotal, gap } = downPaymentEntry({
    mode,
    typed,
    reason,
    current,
    total,
    methodMissing: methodMissing(method.account, accounts),
    referenceMissing: referenceMissing(method.account, method.reference, accounts),
  });
  const testId = `repair.desk.downPayment.${mode}`;
  // Through which method is said once one is picked.
  const changeLine = methodMissing(method.account, accounts)
    ? null
    : downPaymentChangeLine(
        current,
        amount,
        accountLabel(offeredAccount(method.account, accounts), accounts),
      );
  const fix =
    correcting && gap === null && amount !== null && loadedAccounts !== null
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
    if (gap !== null || amount === null || loadedAccounts === null) return;
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
  const leave = useLeaveGuard(stale === null && (typed !== null || reason.trim() !== ''), onClose);
  return (
    <>
      <StepDialog
        title={tn(
          downPaymentTitleKey(mode, runtime.hasPermission(REPAIR_PERMISSION.correctDownPayment)),
        )}
        runner={runner}
        stale={stale}
        onRequestClose={leave.requestClose}
        size="sm"
        testId={testId}
        footer={
          <>
            {/* Above the total is said under the amount; anything else missing is said here. */}
            {gap === null || gap === 'aboveTotal' ? null : (
              <p className="mr-auto text-small text-text-muted">{tn(DOWN_PAYMENT_GAP_KEY[gap])}</p>
            )}
            <CancelButton onClick={leave.requestClose} />
            <Button
              label={asking ? ta('approvals.action.ask') : tn('repair.downPayment.save')}
              variant="primary"
              onClick={submit}
              busy={runner.busy}
              disabled={gap !== null || stale !== null || loadedAccounts === null}
              data-testid={`${testId}.submit`}
            />
          </>
        }
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          {correcting && current !== null ? (
            <div className="flex items-baseline justify-between gap-4 rounded-sm bg-surface-alt px-4 py-3">
              <span className="text-body text-text-muted">{tn('repair.downPayment.current')}</span>
              <span className="tabular text-body font-semibold text-text">
                {formatMoney(current)}
              </span>
            </div>
          ) : null}
          <MoneyField
            label={tn(correcting ? 'repair.downPayment.newAmount' : 'repair.downPayment.amount')}
            hint={
              aboveTotal
                ? undefined
                : tn('repair.downPayment.ofTotal', { amount: formatMoney(total) })
            }
            error={aboveTotal ? tn('repair.problem.downPaymentAboveTotal') : undefined}
            value={typed}
            onChange={setTyped}
            autoFocus
            data-testid={`${testId}.amount`}
          />
          {correcting && (amount ?? 0) === 0 ? null : (
            <PaymentMethodField
              accounts={accounts}
              account={method.account}
              reference={method.reference}
              onChange={setMethod}
              testId={`${testId}.method`}
            />
          )}
          {correcting && changeLine !== null ? (
            <p className="text-small text-text-muted" data-testid={`${testId}.change`}>
              {changeLine}
            </p>
          ) : null}
          {correcting ? (
            <TextArea
              label={tn('repair.downPayment.reason')}
              hint={tn('repair.downPayment.removeHint')}
              rows={2}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              data-testid={`${testId}.reason`}
            />
          ) : null}
          {correcting && ask.limit !== null ? (
            <p className="text-small text-text-muted" data-testid={`${testId}.limit`}>
              {tn('repair.hint.downPaymentLimit', { amount: formatMoney(ask.limit) })}
            </p>
          ) : null}
          {ask.withEarlier === null ? null : (
            <p className="text-small text-text-muted" data-testid={`${testId}.withEarlier`}>
              {tn('repair.hint.downPaymentWithEarlier', { amount: formatMoney(ask.withEarlier) })}
            </p>
          )}
          {asking ? (
            <p className="text-small text-text-muted" data-testid={`${testId}.asks`}>
              {tn(ask.because)}
            </p>
          ) : null}
        </form>
      </StepDialog>
      {leave.confirm}
    </>
  );
}

// ── print ───────────────────────────────────────────────────────────────────────────────────

const SLIP_KEY: Readonly<Record<SlipKind, { title: RepairKey; about: RepairKey }>> = {
  intake: { title: 'repair.print.intake', about: 'repair.print.intakeAbout' },
  handover: { title: 'repair.print.handover', about: 'repair.print.handoverAbout' },
};

/**
 * Printing a slip from the PC: which slip (once the bill exists), on the paper set for this PC, then
 * the same `outputSlip` the phone runs. A print the platform cannot confirm is asked about before it counts.
 */
export function PrintDialog({
  ticket,
  printing,
  onDone,
  onClose,
}: {
  readonly ticket: TicketDetailRow;
  readonly printing: RepairPrinting;
  readonly onDone: () => void;
  readonly onClose: () => void;
}): React.JSX.Element {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const slips = printableSlips(ticket);
  // Once the phone is ready, the bill is what the counter is likeliest to print.
  const [slip, setSlip] = useState<SlipKind>(slips[slips.length - 1]!);
  const { paper } = useDevicePaper(printing, DESK_PAPERS);
  const { state: printers, choose } = useDevicePrinters(printing.printers);
  const [problem, catchProblem, clearProblem] = usePrinterProblem();
  const [asking, setAsking] = useState(false);
  const testId = 'repair.desk.print';
  // Where it will print, said before it does; no printer picked yet is said at once.
  const printer =
    printers.kind === 'ready'
      ? (printers.printers.find((p) => p.name === printers.chosen) ?? null)
      : null;
  const listed = printing.printers !== undefined && printers.kind === 'ready';
  const unpicked = listed && printers.chosen === null;
  // A printer unplugged since it was picked is said too, but printing stays possible: it may be back.
  const missing = listed && printers.chosen !== null && printer === null;
  // Nothing installed at all: there is nothing to pick here, so the dialog says what to do instead.
  const noneInstalled = listed && printers.printers.length === 0;
  const shownProblem =
    problem ?? (unpicked && !noneInstalled ? 'noPrinter' : missing ? 'printerMissing' : null);

  const print = (): void => {
    void runner
      .run(() => catchProblem(outputSlip(runtime, printing, ticket, slip, DESK_PAPERS, 'print')))
      .then((outcome) => {
        if (outcome === 'unconfirmed') setAsking(true);
        else if (outcome === 'done') onDone();
      });
  };
  const confirmPrinted = (): void => {
    setAsking(false);
    void runner
      .run(() => logSlipPrinted(runtime, ticket.id, slip))
      .then((result) => {
        if (result !== undefined) onDone();
      });
  };

  const printed = ticket.slipPrints[slip];
  return (
    <>
      <StepDialog
        title={tn('repair.print.title')}
        runner={runner}
        stale={null}
        onRequestClose={onClose}
        size="sm"
        testId={testId}
        footer={
          <>
            <CancelButton onClick={onClose} />
            <Button
              label={tn('repair.print.print')}
              icon={Printer}
              variant="primary"
              onClick={print}
              busy={runner.busy}
              disabled={unpicked}
              data-testid={`${testId}.submit`}
            />
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div>
            {slips.length > 1 ? (
              <Segmented
                label={tn('repair.print.slip')}
                options={slips.map((value) => ({ value, label: tn(SLIP_KEY[value].title) }))}
                value={slip}
                onChange={setSlip}
                testId={`${testId}.slip`}
              />
            ) : (
              <p className="text-body font-semibold text-text">{tn(SLIP_KEY[slip].title)}</p>
            )}
            <p className="mt-2 text-small text-text-muted" data-testid={`${testId}.about`}>
              {tn(SLIP_KEY[slip].about)}
              {printed === 0 ? null : <> {tn('repair.print.reprint', { count: printed })}</>}
            </p>
            {paper === null ? null : (
              <p className="mt-1 text-small text-text-muted" data-testid={`${testId}.paper`}>
                {printer === null
                  ? tn('repair.print.onPaper', { paper: paperLabel(paper) })
                  : tn('repair.print.onPrinter', {
                      printer: printer.label,
                      paper: paperLabel(paper),
                    })}
              </p>
            )}
          </div>
          <PrinterProblemBanner
            problem={shownProblem}
            onDismiss={problem === null ? undefined : clearProblem}
          />
          {/* No printer yet, or the one picked is gone: picked right here, and kept for next time
              as in Settings, so the customer is not kept waiting on a trip there. */}
          {!(unpicked || missing) || printers.kind !== 'ready' ? null : noneInstalled ? (
            <Banner tone="danger" message={tn('repair.printer.none')} />
          ) : (
            <ChoiceList
              label={tn('repair.printer.printer')}
              options={printers.printers.map((p) => ({ value: p.name, label: p.label }))}
              value={null}
              onChange={(name) => {
                clearProblem();
                void choose(name);
              }}
              testId={`${testId}.printers`}
            />
          )}
        </div>
      </StepDialog>
      <ConfirmDialog
        open={asking}
        title={tn('repair.print.askTitle')}
        message={tn('repair.print.askMessage')}
        confirmLabel={tn('repair.print.askYes')}
        cancelLabel={tn('repair.print.askNo')}
        closeLabel={t('core.action.close')}
        onConfirm={confirmPrinted}
        onCancel={() => setAsking(false)}
        testId={`${testId}.ask`}
      />
    </>
  );
}
