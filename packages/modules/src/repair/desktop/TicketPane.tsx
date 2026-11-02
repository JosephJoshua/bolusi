// One repair beside the board: who and what, the next steps this user may take, the price with its
// changes, every photo, the condition at intake and the history. Steps that need input open a
// dialog; the rest run in place. Live like the phone's ticket: a change synced in from another
// device redraws it, and an open dialog says when that change means it can no longer finish.
import { formatDateTime, formatMoney, formatPhone, t } from '@bolusi/i18n';
import {
  Banner,
  Button,
  Chip,
  Fact,
  FactGrid,
  FreshGlow,
  IconButton,
  Menu,
  PatternPad,
  PhotoTile,
  PhotoViewer,
  RollingText,
  Section,
  StatePanel,
  Timeline,
  Tooltip,
} from '@bolusi/ui-web';
import {
  Check,
  CloudOff,
  Copy,
  Ellipsis,
  Eye,
  EyeOff,
  MessageCircle,
  Phone,
  Plus,
  Printer,
  SearchX,
  ShieldCheck,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { rejectedCount, useActionRunner, type EntitySyncStatuses } from '../../screen-kit/index.js';
import { HANDOVER_PHOTO_SLOTS } from '../constants.js';
import { TicketVideoSection } from './video.js';
import {
  MESSAGE_ACTION_KEY,
  customerMessageKind,
  customerMessageUrl,
  type CustomerMessageKind,
} from '../customer-message.js';
import { decodeScreenLock, patternSteps } from '../screen-lock.js';
import {
  discountsStanding,
  amountOwed,
  arrangeTicketActions,
  balanceAfterDownPayment,
  balanceLabelKey,
  canSetRepairTypes,
  canTakeParts,
  canUseParts,
  takePartIsCorrection,
  claimIntakeDraft,
  CONTEXTUAL_ACTIONS,
  FINAL_ACTIONS,
  downPaymentAction,
  downPaymentStale,
  paidLabelKey,
  partUse,
  photoInSlot,
  repairTypesStale,
  photoThumbnailRef,
  repairAbilities,
  staleStep,
  ticketActions,
  ticketMoneyActions,
  ticketMoneyTarget,
  ticketStatus,
  flagsUncollected,
  uncollectedDays,
  warrantyClaimAction,
  workPhotos,
  type IntakeDraft,
  type TicketAction,
  type StaleStep,
  type TicketStep,
  repairedDoneKey,
} from '../flows.js';
import { useClearAskedNotice } from '../asked-notice.js';
import type { QuoteLineRow, TicketDetailRow } from '../queries.js';
import { tn, type RepairKey } from '../i18n.js';
import { ApprovalDialog, ApprovalSection } from '../../approvals/desktop/ApprovalViews.js';
import { ta } from '../../approvals/i18n.js';
import type { ApprovalRow } from '../../approvals/queries.js';
import { describeRepairApproval } from '../approval-copy.js';
import {
  cancelFeeText,
  actionKey,
  downPaymentTitleKey,
  historyEntry,
  LOCK_KIND_KEY,
  PRICE_KIND_KEY,
  optionLabel,
  paidRow,
  warrantyLine,
} from '../labels.js';
import {
  readApprovals,
  moneyRuntimeOf,
  useRepairQuery,
  useRepairRuntime,
  useStoreDisplayName,
  useUncollectedLimit,
} from '../runtime.js';
import type { ThumbnailRef } from '../../screen-kit/index.js';

import { ActionError, QueryPanel } from '../../screen-kit/desktop/index.js';
import { tm } from '../../money/i18n.js';
import { ReduceChargeDialog, RefundDialog } from '../../money/desktop/KasDialogs.js';
import { MoneyRuntimeProvider } from '../../money/runtime.js';
import { INVENTORY_PERMISSION } from '../../inventory/constants.js';
import { TakePartDialog, UsedPartsSection } from '../../inventory/desktop/UsedParts.js';
import { ti } from '../../inventory/i18n.js';
import { InventoryRuntimeProvider } from '../../inventory/runtime.js';
import { CatalogPhoto, DeviceSpecs, StatusChip, photoLabels, usePhotoState } from './parts.js';
import {
  AssignDialog,
  CancelDialog,
  CorrectDetailsDialog,
  DownPaymentDialog,
  HandoverDialog,
  PriceChangeDialog,
  PrintDialog,
  ProposalDialog,
  RepairTypesDialog,
  UndoHandoverDialog,
  ChangeCancelFeeDialog,
  WaitForPartsDialog,
  WorkPhotosDialog,
} from './steps.js';

/** What an action that runs in place, or a step that lands, says afterwards. */
const DONE_KEY: Partial<Record<TicketAction | 'before' | 'after', RepairKey>> = {
  claim: 'repair.done.claim',
  start: 'repair.done.start',
  resume: 'repair.done.start',
  reopen: 'repair.done.start',
  before: 'repair.done.start',
  handover: 'repair.desk.done.handover',
};

type Step =
  | { readonly kind: 'none' }
  | Exclude<TicketStep, { readonly kind: 'proposal' }>
  | { readonly kind: 'proposal'; readonly lineId: string; readonly line: QuoteLineRow }
  | { readonly kind: 'downPayment'; readonly mode: 'record' | 'correct' }
  | { readonly kind: 'repairTypes' }
  | { readonly kind: 'print' }
  | { readonly kind: 'approval'; readonly requestId: string }
  | { readonly kind: 'refund' }
  | { readonly kind: 'reduce' }
  | { readonly kind: 'takePart' };

interface LoadedTicket {
  readonly ticket: TicketDetailRow | undefined;
  readonly statuses: EntitySyncStatuses;
  readonly approvals: readonly ApprovalRow[];
}

export interface TicketPaneProps {
  readonly ticketId: string;
  /** An intake opened it just now: the number lands like a stamp. */
  readonly justOpened?: boolean | undefined;
  /** The clock a phone's wait is counted against (phones not collected). */
  readonly now: () => number;
  readonly onClose: () => void;
  /** Where a refused change is explained; without it the banner only says so. */
  readonly onOpenSyncStatus?: (() => void) | undefined;
  /** Starts a warranty claim's intake from this servisan; without it the claim is not offered. */
  readonly onStartClaim?: ((draft: IntakeDraft) => void) | undefined;
  /** Opens a linked servisan: the one a claim is on, or a claim on this one. */
  readonly onOpenTicket?: ((ticketId: string) => void) | undefined;
  /** Just opened by an intake: offers its slip at once, as the customer is still at the counter. */
  readonly printFirst?: boolean | undefined;
  /** The slip was offered, so coming back to this servisan later does not offer it again. */
  readonly onPrintOffered?: (() => void) | undefined;
}

export function TicketPane({
  ticketId,
  justOpened = false,
  now,
  printFirst = false,
  onPrintOffered,
  onClose,
  onOpenSyncStatus,
  onStartClaim,
  onOpenTicket,
}: TicketPaneProps): React.JSX.Element {
  const runtime = useRepairRuntime();
  const can = useMemo(() => repairAbilities(runtime.hasPermission), [runtime]);
  // Money back to the customer and a lowered bill are the ledger's dialogs, over repair's port.
  const money = useMemo(() => moneyRuntimeOf(runtime, () => null), [runtime]);
  const runner = useActionRunner();
  const printing = runtime.printing;
  const [step, setStep] = useState<Step>({ kind: 'none' });
  // What just happened, in words: a repair step's, or an approval's.
  const [done, setDone] = useState<string | null>(null);
  const say = (key: RepairKey | undefined): void => setDone(key === undefined ? null : tn(key));
  const [reloadNonce, setReloadNonce] = useState(0);

  const query = useRepairQuery<LoadedTicket>(
    async (rt) => {
      const page = await rt.query('getTicket', { ticketId });
      return {
        ticket: page.rows[0],
        statuses: await rt.ticketSyncStatuses([ticketId]),
        approvals: await readApprovals(rt, ticketId),
      };
    },
    `desk.ticket:${ticketId}:${String(reloadNonce)}`,
  );
  useClearAskedNotice(
    done,
    () => setDone(null),
    query.status === 'ready' ? query.data.approvals : undefined,
  );
  const ticket = query.status === 'ready' ? query.data.ticket : undefined;
  // An open step outlives a failed re-read: it keeps the last good ticket, so photos taken and
  // text typed in a dialog are not thrown away by a hiccup in the background.
  const lastTicket = useRef<TicketDetailRow | undefined>(undefined);
  if (ticket !== undefined) lastTicket.current = ticket;
  const stepTicket = ticket ?? lastTicket.current;
  const statuses = query.status === 'ready' ? (query.data.statuses[ticketId] ?? []) : [];
  const actions = ticket === undefined ? [] : ticketActions(ticket, can, runtime.userId, now());
  const stale: StaleStep | null =
    step.kind === 'none' ||
    step.kind === 'print' ||
    step.kind === 'approval' ||
    step.kind === 'refund' ||
    step.kind === 'takePart' ||
    step.kind === 'reduce' ||
    ticket === undefined
      ? null
      : step.kind === 'downPayment'
        ? downPaymentStale(ticket, can, step.mode)
        : step.kind === 'repairTypes'
          ? repairTypesStale(ticket, can)
          : staleStep(step, ticket, can, runtime.userId, now());

  // The slip the customer takes away is offered as soon as there is one: after the intake, and after
  // the handover once the servisan reads as picked up (its slip prints what was handed over).
  const [printNext, setPrintNext] = useState<'opened' | 'returned' | null>(
    printFirst ? 'opened' : null,
  );
  useEffect(() => {
    if (printNext === null || ticket === undefined || step.kind !== 'none') return;
    if (printNext === 'returned' && ticket.location !== 'returned') return;
    setPrintNext(null);
    if (printNext === 'opened') onPrintOffered?.();
    if (printing !== undefined) setStep({ kind: 'print' });
  }, [printNext, ticket, step.kind, printing, onPrintOffered]);
  const closeStep = (): void => setStep({ kind: 'none' });
  const finishStep = (said: RepairKey | undefined): void => {
    closeStep();
    say(said);
  };
  // A request sent instead of the step: it waits on an owner, and says so.
  const asked = (): void => {
    closeStep();
    setDone(ta('approvals.done.asked'));
  };

  const perform = (action: TicketAction, row: TicketDetailRow): void => {
    setDone(null);
    switch (action) {
      case 'decidePrice': {
        const line = row.quoteLines.find((candidate) => candidate.status === 'proposed');
        if (line !== undefined) setStep({ kind: 'proposal', lineId: line.id, line });
        return;
      }
      case 'start':
      case 'resume':
      case 'reopen':
        // The first start needs a before photo; a resume keeps the ones already taken.
        if (workPhotos(row, 'before').length === 0) setStep({ kind: 'before' });
        else
          void runner
            .run(() => runtime.run('startWork', { ticketId }))
            .then((result) => {
              if (result !== undefined) say(DONE_KEY[action]);
            });
        return;
      case 'claim':
        void runner
          .run(() => runtime.run('claimTicket', { ticketId }))
          .then((result) => {
            if (result !== undefined) say(DONE_KEY.claim);
          });
        return;
      case 'markRepaired':
        setStep({ kind: 'after' });
        return;
      case 'handover':
      case 'waitForParts':
      case 'cancel':
      case 'undoHandover':
      case 'changeCancelFee':
      case 'correctDetails':
      case 'assign':
      case 'changePrice':
      case 'proposePrice':
        setStep({ kind: action });
        return;
    }
  };

  const storeName = useStoreDisplayName();
  const uncollectedLimit = useUncollectedLimit();
  const messageKind =
    ticket === undefined ? null : customerMessageKind(ticket, can, runtime.statusSite);
  const claimAction =
    ticket === undefined || onStartClaim === undefined
      ? null
      : warrantyClaimAction(ticket, can, now());
  // Writes the message and opens WhatsApp on the customer's number; the person checks it and sends.
  const sendMessage = (kind: CustomerMessageKind, row: TicketDetailRow): void => {
    const url = customerMessageUrl(kind, row, storeName, runtime.statusSite);
    if (url === null) return;
    setDone(null);
    window.open(url, '_blank', 'noopener');
  };

  const label = (action: TicketAction): string =>
    action === 'cancel' && !can.cancel
      ? tn('repair.approval.askCancel')
      : tn(actionKey(action, ticket?.technicianId ?? null));

  // The next step leads; a correction stays beside what it corrects (the price, the technician).
  const layout =
    ticket === undefined
      ? { next: null, alternative: null, more: [] }
      : arrangeTicketActions(actions, ticket, runtime.userId);
  const contextual = (action: TicketAction, row: TicketDetailRow): ReactNode =>
    CONTEXTUAL_ACTIONS.has(action) && actions.includes(action) && layout.next !== action ? (
      // The short word beside a fact ("Ubah"), named in full on hover.
      <Tooltip label={label(action)}>
        <Button
          label={
            action === 'assign'
              ? tn(
                  row.technicianId === null
                    ? 'repair.action.assignShort'
                    : 'repair.action.reassignShort',
                )
              : action === 'changeCancelFee'
                ? tn('repair.cancelFee.short')
                : label(action)
          }
          aria-label={label(action)}
          variant="text"
          size="sm"
          className="-my-1"
          onClick={() => perform(action, row)}
          disabled={runner.busy}
          data-testid={`repair.desk.ticket.action.${action}`}
        />
      </Tooltip>
    ) : null;

  const banner =
    runner.errorCode !== null ? (
      <ActionError errorCode={runner.errorCode} onDismiss={runner.clearError} />
    ) : rejectedCount(statuses) > 0 ? (
      <Banner
        tone="danger"
        message={t('sync.pc.rejectedBanner', { count: rejectedCount(statuses) })}
        action={
          onOpenSyncStatus === undefined ? undefined : (
            <Button
              label={tn('repair.board.checkSync')}
              variant="text"
              size="sm"
              className="-my-1"
              onClick={onOpenSyncStatus}
            />
          )
        }
      />
    ) : done !== null ? (
      <Banner
        tone="success"
        message={done}
        onDismiss={() => setDone(null)}
        dismissLabel={t('core.action.close')}
      />
    ) : null;

  return (
    <section
      aria-label={ticket?.ticketNumber ?? tn('repair.ticket.title')}
      data-testid="repair.desk.ticket"
      // Focusable so Enter on the board can move the keyboard here.
      tabIndex={-1}
      className="flex min-h-0 flex-1 flex-col border-l border-border bg-surface focus:outline-none"
    >
      <QueryPanel query={query} onRetry={() => setReloadNonce((n) => n + 1)}>
        {(data) =>
          data.ticket === undefined ? (
            <StatePanel
              icon={SearchX}
              title={t('core.errors.ENTITY_NOT_FOUND')}
              action={<Button label={t('core.action.close')} onClick={onClose} />}
              testId="repair.desk.ticket.missing"
            />
          ) : (
            <>
              {renderHeader(data.ticket)}
              <div className="min-h-0 flex-1 overflow-y-auto">
                <div className="flex flex-col gap-8 px-6 pb-10 pt-2">{renderBody(data.ticket)}</div>
              </div>
            </>
          )
        }
      </QueryPanel>
      {stepTicket === undefined ? null : renderStep(stepTicket)}
    </section>
  );

  function renderHeader(row: TicketDetailRow): React.JSX.Element {
    const pending = statuses.includes('local');
    // The counter and owners call the customer about a phone left too long; technicians need not.
    const waited =
      flagsUncollected(can) && uncollectedLimit.status === 'ready'
        ? uncollectedDays(row, uncollectedLimit.data.days, now())
        : null;
    // The rarer moves, then corrections to a servisan that went home (money back, a part taken
    // late): those are never a button of their own that reads as the next step.
    const inventory = runtime.inventory;
    const more = [
      ...layout.more.map((action) => ({
        key: action,
        label: label(action),
        onSelect: () => perform(action, row),
      })),
      ...(ticketMoneyActions(row, runtime.hasPermission).refund === 'correction'
        ? [
            {
              key: 'refund',
              label: tm('money.refund.title'),
              onSelect: () => {
                setDone(null);
                setStep({ kind: 'refund' });
              },
            },
          ]
        : []),
      ...(inventory !== undefined &&
      inventory.hasPermission(INVENTORY_PERMISSION.read) &&
      takePartIsCorrection(row) &&
      canTakeParts(row, runtime.userId, inventory.hasPermission)
        ? [
            {
              key: 'takePart',
              label: ti('inventory.use.takeTitle'),
              onSelect: () => {
                setDone(null);
                setStep({ kind: 'takePart' });
              },
            },
          ]
        : []),
    ];
    return (
      <header className="relative isolate flex flex-col gap-4 border-b border-border px-6 pb-4 pt-4">
        {/* The open servisan glows once when another device changes it. */}
        <FreshGlow id={row.id} />
        <div className="flex items-start gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span
              className={`tabular shrink-0 whitespace-nowrap text-small font-semibold text-text-muted${
                justOpened ? ' animate-stamp' : ''
              }`}
              data-testid="repair.desk.ticket.number"
            >
              {row.ticketNumber}
            </span>
            <StatusChip status={ticketStatus(row)} />
            {row.claimOf === null ? null : (
              <Chip label={tn('repair.warrantyClaim.title')} icon={ShieldCheck} tone="info" />
            )}
            {waited === null ? null : (
              <Chip
                label={tn('repair.board.waited', { days: waited })}
                icon={TriangleAlert}
                tone="warning"
              />
            )}
            {pending ? <Chip label={t('sync.chip.pending')} icon={CloudOff} /> : null}
          </div>
          <IconButton
            icon={X}
            label={tn('repair.desk.closeTicket')}
            className="-mr-2 ml-auto shrink-0"
            onClick={onClose}
            data-testid="repair.desk.ticket.close"
          />
        </div>
        <div>
          <div className="flex items-baseline gap-2">
            <h2
              className="min-w-0 text-title font-bold text-text"
              data-testid="repair.desk.ticket.customer"
            >
              {row.customerName}
            </h2>
            {contextual('correctDetails', row)}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-body text-text-muted">
            {row.customerPhone === null ? null : <CopyablePhone phone={row.customerPhone} />}
            <span>
              {tn('repair.desk.receivedBy', {
                at: formatDateTime(row.createdAt),
                name: row.createdByName ?? '–',
              })}
            </span>
          </div>
        </div>
        {layout.next === null &&
        layout.alternative === null &&
        more.length === 0 &&
        printing === undefined &&
        messageKind === null &&
        claimAction === null ? null : (
          // The next step leads; printing and the rarer moves ("Lainnya") wait quietly at the end.
          // A narrow pane wraps them rather than push the last one out of sight.
          <div className="flex flex-wrap items-center gap-2">
            {layout.next === null ? null : (
              <Button
                label={label(layout.next)}
                variant="primary"
                onClick={() => perform(layout.next!, row)}
                busy={runner.busy}
                data-testid={`repair.desk.ticket.action.${layout.next}`}
              />
            )}
            {layout.alternative === null ? null : (
              <Button
                label={label(layout.alternative)}
                onClick={() => perform(layout.alternative!, row)}
                disabled={runner.busy}
                data-testid={`repair.desk.ticket.action.${layout.alternative}`}
              />
            )}
            {messageKind === null ? null : (
              <Button
                label={tn(MESSAGE_ACTION_KEY[messageKind])}
                icon={MessageCircle}
                onClick={() => sendMessage(messageKind, row)}
                disabled={runner.busy}
                data-testid="repair.desk.ticket.action.message"
              />
            )}
            {claimAction === null ? null : (
              <Button
                label={tn('repair.warrantyClaim.action')}
                icon={ShieldCheck}
                onClick={() =>
                  onStartClaim?.(claimIntakeDraft(row, tn('repair.warrantyClaim.line')))
                }
                disabled={runner.busy}
                data-testid="repair.desk.ticket.action.warrantyClaim"
              />
            )}
            <div className="-mr-2 ml-auto flex items-center gap-1">
              {printing === undefined ? null : (
                <IconButton
                  icon={Printer}
                  label={tn('repair.print.title')}
                  onClick={() => {
                    setDone(null);
                    setStep({ kind: 'print' });
                  }}
                  disabled={runner.busy}
                  data-testid="repair.desk.ticket.action.print"
                />
              )}
              {more.length === 0 ? null : (
                <Menu
                  trigger={
                    <IconButton
                      icon={Ellipsis}
                      label={tn('repair.action.more')}
                      disabled={runner.busy}
                      data-testid="repair.desk.ticket.more"
                    />
                  }
                  items={more}
                />
              )}
            </div>
          </div>
        )}
        {banner}
      </header>
    );
  }

  function renderBody(row: TicketDetailRow): React.JSX.Element {
    const device = [row.deviceBrand, row.deviceModel, row.deviceColor]
      .filter((s) => s !== '')
      .join(' · ');
    return (
      <>
        <div className="flex items-start gap-4 rounded-sm bg-surface-alt px-4 py-3">
          <CatalogPhoto brand={row.deviceBrand} model={row.deviceModel} />
          <div className="min-w-0">
            <p
              className="text-body font-semibold text-text"
              data-testid="repair.desk.ticket.device"
            >
              {device}
            </p>
            <p className="mt-2 text-small text-text-muted">{tn('repair.condition.complaint')}</p>
            <p className="text-body text-text" data-testid="repair.desk.ticket.complaint">
              {row.complaint}
            </p>
          </div>
        </div>

        {query.status === 'ready' ? (
          <ApprovalSection
            rows={query.data.approvals}
            describe={describeRepairApproval}
            onOpen={(request) => {
              setDone(null);
              setStep({ kind: 'approval', requestId: request.id });
            }}
            testId="repair.desk.ticket.approvals"
          />
        ) : null}

        <FactGrid>
          {renderRepairTypes(row)}
          {renderClaimLinks(row)}
          <Fact
            label={tn('repair.ticket.technician')}
            value={row.technicianName ?? tn('repair.ticket.unassigned')}
            action={contextual('assign', row)}
            testId="repair.desk.ticket.technician"
          />
          {row.estimatedReadyAt === null ? null : (
            <Fact
              label={tn('repair.ticket.readyBy')}
              value={formatDateTime(row.estimatedReadyAt)}
            />
          )}
          {row.outcome === 'cancelled' ? (
            <Fact
              // Once cut, the bill is what the customer pays, as the board's total says.
              label={tn(row.reduced > 0 ? 'repair.price.billed' : 'repair.cancel.fee')}
              value={cancelFeeText((row.cancelFee ?? 0) - row.reduced)}
              action={contextual('changeCancelFee', row)}
              testId="repair.desk.ticket.cancelFeeFact"
            />
          ) : null}
          {row.deviceImei === null ? null : (
            <Fact label={tn('repair.device.imei')} value={row.deviceImei} />
          )}
          {row.devicePasscode === null ? null : <Passcode value={row.devicePasscode} />}
        </FactGrid>
        {row.outcomeNote === null || row.outcomeNote === '' ? null : (
          <div className="-mt-4">
            <p className="text-small text-text-muted">{tn('repair.ticket.lastNote')}</p>
            <p className="text-body text-text">{row.outcomeNote}</p>
          </div>
        )}

        {renderPrice(row)}
        {renderParts(row)}
        <TicketPhotos ticket={row} />
        <TicketVideoSection ticket={row} runner={runner} testId="repair.desk.ticket.video" />
        {renderCondition(row)}
        <DeviceSpecs brand={row.deviceBrand} model={row.deviceModel} repairs={can.work} />

        <Section title={tn('repair.ticket.history')} testId="repair.desk.ticket.history">
          <Timeline entries={[...row.events].reverse().map(historyEntry)} />
        </Section>

        {[...FINAL_ACTIONS]
          .filter((action) => actions.includes(action))
          .map((action) => (
            <div key={action} className="border-t border-border pt-6">
              {/* Kept apart at the end: final for the repair, or taking a handover back, so it
                  never reads as the next step. */}
              <Button
                label={label(action)}
                variant="dangerText"
                className="-ml-2"
                onClick={() => perform(action, row)}
                disabled={runner.busy}
                data-testid={`repair.desk.ticket.action.${action}`}
              />
            </div>
          ))}
      </>
    );
  }

  function renderPrice(row: TicketDetailRow): React.JSX.Element {
    const pending = row.quoteLines.filter((line) => line.status === 'proposed');
    const deciding = actions.includes('decidePrice');
    const cancelled = row.outcome === 'cancelled';
    const moneyActions = ticketMoneyActions(row, runtime.hasPermission);
    return (
      <Section
        title={tn('repair.ticket.price')}
        action={contextual('changePrice', row) ?? contextual('proposePrice', row)}
        testId="repair.desk.ticket.price"
      >
        <div className="flex flex-col">
          {row.quoteLines.map((line) => {
            const counted = line.status === 'intake' || line.status === 'applied';
            return (
              <div
                key={line.id}
                className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 border-b border-border py-2 last:border-b-0"
                data-testid={`repair.desk.ticket.line.${line.id}`}
              >
                <div className="min-w-0">
                  <p className={counted ? 'text-body text-text' : 'text-body text-text-muted'}>
                    {line.description}
                  </p>
                  <p className="text-small text-text-muted">
                    {tn(PRICE_KIND_KEY[line.kind])}
                    {line.status === 'intake' ? null : (
                      <span className={line.status === 'proposed' ? 'text-warning' : undefined}>
                        {' · '}
                        {lineCaption(line)}
                      </span>
                    )}
                  </p>
                  {line.status === 'proposed' && deciding && pending.length > 1 ? (
                    <Button
                      label={tn('repair.action.decidePrice')}
                      variant="text"
                      size="sm"
                      className="-ml-2"
                      disabled={runner.busy}
                      onClick={() => setStep({ kind: 'proposal', lineId: line.id, line })}
                    />
                  ) : null}
                </div>
                <p
                  className={`tabular text-body ${counted ? 'text-text' : 'text-text-muted'} ${line.status === 'declined' ? 'line-through' : ''}`}
                >
                  {formatMoney(line.amount)}
                </p>
              </div>
            );
          })}
        </div>
        <div className="flex items-baseline justify-between gap-4 border-t-2 border-text pt-3">
          <p
            className={
              cancelled
                ? 'text-small text-text-muted line-through'
                : 'text-body font-semibold text-text'
            }
          >
            {tn('repair.price.total')}
          </p>
          <p
            className={`tabular ${cancelled ? 'text-small text-text-muted line-through' : 'text-title font-bold text-text'}`}
            data-testid="repair.desk.ticket.total"
          >
            <RollingText value={row.quoteTotal}>{formatMoney(row.quoteTotal)}</RollingText>
          </p>
        </div>
        {cancelled ? (
          // The repair price stays as quiet history; the number that leads is what the customer
          // owes, the same fee the board and the handover show (Rp 0 when none was set).
          <>
            <div className="flex items-baseline justify-between gap-4">
              <p className="text-body font-semibold text-text">{tn('repair.cancel.fee')}</p>
              <p
                className="tabular text-title font-bold text-text"
                data-testid="repair.desk.ticket.cancelFee"
              >
                {cancelFeeText(row.cancelFee ?? 0)}
              </p>
            </div>
            <p className="text-small text-text-muted">{tn('repair.price.notCharged')}</p>
          </>
        ) : null}
        <DownPaymentLines
          total={amountOwed(row)}
          reduced={row.reduced}
          downPayment={row.downPayment}
          paidLabel={paidLabelKey(row)}
          returned={row.location === 'returned'}
          action={downPaymentAction(row, can)}
          correctLabel={tn(downPaymentTitleKey('correct', can.correctDownPayment))}
          disabled={runner.busy}
          onAction={(mode) => {
            setDone(null);
            setStep({ kind: 'downPayment', mode });
          }}
        />
        {moneyActions.refund === 'due' || moneyActions.reduce ? (
          <div className="-ml-2 flex flex-wrap gap-2">
            {moneyActions.refund === 'due' ? (
              <Button
                label={tm('money.refund.title')}
                variant="text"
                size="sm"
                onClick={() => {
                  setDone(null);
                  setStep({ kind: 'refund' });
                }}
                disabled={runner.busy}
                data-testid="repair.desk.ticket.refund"
              />
            ) : null}
            {moneyActions.reduce ? (
              <Button
                label={tm('money.reduce.action')}
                variant="text"
                size="sm"
                onClick={() => {
                  setDone(null);
                  setStep({ kind: 'reduce' });
                }}
                disabled={runner.busy}
                data-testid="repair.desk.ticket.reduce"
              />
            ) : null}
          </div>
        ) : null}
        {!deciding || pending.length === 0 ? null : (
          <p className="flex items-center gap-1 text-small font-semibold text-warning">
            <TriangleAlert size={14} aria-hidden />
            {tn('repair.price.pendingTotal', {
              amount: formatMoney(pending.reduce((sum, line) => sum + line.amount, 0)),
            })}
          </p>
        )}
      </Section>
    );
  }

  function renderCondition(row: TicketDetailRow): React.JSX.Element | null {
    const issues = row.checklist.filter((check) => check.state === 'issue');
    const fine = row.checklist.filter((check) => check.state === 'ok');
    if (row.checklist.length === 0 && row.peripherals.length === 0 && row.intakeNotes === '')
      return null;
    return (
      <Section title={tn('repair.intake.step.condition')} testId="repair.desk.ticket.condition">
        <div className="flex flex-col gap-3">
          {issues.length === 0 ? null : (
            <ChipGroup label={tn('repair.condition.issues')}>
              {issues.map((check) => (
                <Chip
                  key={check.item}
                  label={optionLabel('checks', { id: check.item, label: check.label })}
                  icon={TriangleAlert}
                  tone="warning"
                />
              ))}
            </ChipGroup>
          )}
          {fine.length === 0 ? null : (
            <ChipGroup label={tn('repair.desk.checksOk')}>
              {fine.map((check) => (
                <Chip
                  key={check.item}
                  label={optionLabel('checks', { id: check.item, label: check.label })}
                  icon={Check}
                />
              ))}
            </ChipGroup>
          )}
          {row.peripherals.length === 0 ? null : (
            <ChipGroup label={tn('repair.condition.peripherals')}>
              {row.peripherals.map(({ item, label: name }) => (
                <Chip
                  key={item}
                  label={optionLabel('accessories', { id: item, label: name })}
                  icon={Check}
                />
              ))}
            </ChipGroup>
          )}
          {row.intakeNotes === '' ? null : (
            <div>
              <p className="text-small text-text-muted">{tn('repair.condition.notesLabel')}</p>
              <p className="text-body text-text">{row.intakeNotes}</p>
            </div>
          )}
        </div>
      </Section>
    );
  }

  /** What is being repaired and each type's warranty (the phone's ticket shows the same). */
  function renderRepairTypes(row: TicketDetailRow): React.JSX.Element | null {
    const editable = canSetRepairTypes(row, can);
    if (row.repairTypes.length === 0 && !editable) return null;
    return (
      <Fact
        label={tn('repair.repairTypes.title')}
        value={
          row.repairTypes.length === 0
            ? tn('repair.repairTypes.none')
            : row.repairTypes.map((type) => (
                <span key={type.item} className="block">
                  {warrantyLine(type, row.returnedAt)}
                </span>
              ))
        }
        action={
          editable ? (
            <Button
              label={tn(
                row.repairTypes.length === 0
                  ? 'repair.repairTypes.choose'
                  : 'repair.repairTypes.change',
              )}
              aria-label={tn('repair.repairTypes.title')}
              variant="text"
              size="sm"
              onClick={() => {
                setDone(null);
                setStep({ kind: 'repairTypes' });
              }}
              disabled={runner.busy}
              data-testid="repair.desk.ticket.action.repairTypes"
            />
          ) : null
        }
        wide
        testId="repair.desk.ticket.repairTypes"
      />
    );
  }

  /**
   * The servisan a claim is on, with the warranty the claim runs under, or the claims on this one,
   * each a click away (the phone's ticket shows the same).
   */
  function renderClaimLinks(row: TicketDetailRow): React.ReactNode {
    const { claimOf } = row;
    const links = [
      ...(claimOf === null
        ? []
        : [
            {
              id: claimOf.id,
              number: claimOf.ticketNumber,
              lines: claimOf.repairTypes.map((type) => warrantyLine(type, claimOf.returnedAt)),
              key: 'of' as const,
            },
          ]),
      ...row.claims.map((claim) => ({
        id: claim.id,
        number: claim.ticketNumber,
        lines: [],
        key: 'claims' as const,
      })),
    ];
    return links.map((link) => (
      <Fact
        key={link.id}
        label={tn(`repair.warrantyClaim.${link.key}`)}
        value={[link.number, ...link.lines].map((line) => (
          <span key={line} className="block">
            {line}
          </span>
        ))}
        action={
          onOpenTicket === undefined ? null : (
            <Button
              label={tn('repair.warrantyClaim.open')}
              aria-label={`${tn(`repair.warrantyClaim.${link.key}`)} ${link.number}`}
              variant="text"
              size="sm"
              onClick={() => onOpenTicket(link.id)}
              data-testid={`repair.desk.ticket.claimLink.${link.id}`}
            />
          )
        }
        wide
        testId="repair.desk.ticket.claimLink"
      />
    ));
  }

  /** The parts taken for it: the store's own record, never on the bill. */
  function renderParts(row: TicketDetailRow): React.JSX.Element | null {
    const inventory = runtime.inventory;
    if (inventory === undefined || !inventory.hasPermission(INVENTORY_PERMISSION.read)) return null;
    return (
      <InventoryRuntimeProvider runtime={inventory}>
        <UsedPartsSection
          use={partUse(row)}
          device={{ brand: row.deviceBrand, model: row.deviceModel }}
          editable={canUseParts(row, runtime.userId, inventory.hasPermission)}
          takeable={
            !takePartIsCorrection(row) && canTakeParts(row, runtime.userId, inventory.hasPermission)
          }
          flagUnreturned={row.outcome === 'cancelled'}
          onDone={setDone}
          testId="repair.desk.ticket.parts"
        />
      </InventoryRuntimeProvider>
    );
  }

  function renderStep(row: TicketDetailRow): React.JSX.Element | null {
    const common = { ticketId, stale, onClose: closeStep };
    switch (step.kind) {
      case 'none':
        return null;
      case 'approval': {
        const request =
          query.status === 'ready'
            ? query.data.approvals.find((candidate) => candidate.id === step.requestId)
            : undefined;
        if (request === undefined) return null;
        return (
          <ApprovalDialog
            port={runtime.approvals}
            request={request}
            description={describeRepairApproval(request)}
            onClose={closeStep}
            onDone={(notice) => {
              closeStep();
              setDone(notice);
            }}
            testId="repair.desk.approval"
          />
        );
      }
      case 'before':
      case 'after':
        return (
          <WorkPhotosDialog
            {...common}
            stage={step.kind}
            onDone={() =>
              finishStep(step.kind === 'after' ? repairedDoneKey(row) : DONE_KEY[step.kind])
            }
          />
        );
      case 'waitForParts':
        return <WaitForPartsDialog {...common} onDone={() => finishStep(undefined)} />;
      case 'cancel':
        return (
          <CancelDialog
            {...common}
            workStarted={row.workStarted}
            price={row.quoteTotal}
            claimOf={row.claimOfTicketId}
            downPayment={row.downPayment ?? 0}
            discounted={discountsStanding(row.quoteLines)}
            onDone={() => finishStep(undefined)}
            onAsked={asked}
          />
        );
      case 'undoHandover':
        return (
          <UndoHandoverDialog {...common} onDone={() => finishStep('repair.done.handoverUndone')} />
        );
      case 'changeCancelFee':
        return (
          <ChangeCancelFeeDialog
            {...common}
            ticket={row}
            onAsked={asked}
            current={(row.cancelFee ?? 0) - row.reduced}
            paid={row.downPayment ?? 0}
            onDone={() => finishStep('repair.done.cancelFeeChanged')}
          />
        );
      case 'correctDetails':
        return (
          <CorrectDetailsDialog
            stale={stale}
            onClose={closeStep}
            ticket={row}
            onDone={() => finishStep('repair.done.corrected')}
          />
        );
      case 'assign':
        return (
          <AssignDialog
            {...common}
            currentTechnicianId={row.technicianId}
            onDone={() => finishStep(undefined)}
          />
        );
      case 'changePrice':
        return (
          <PriceChangeDialog
            {...common}
            mode="change"
            discounted={discountsStanding(row.quoteLines)}
            onDone={() => finishStep(undefined)}
            onAsked={asked}
          />
        );
      case 'proposePrice':
        return (
          <PriceChangeDialog
            {...common}
            mode="propose"
            discounted={discountsStanding(row.quoteLines)}
            onDone={() => finishStep(undefined)}
          />
        );
      case 'proposal':
        return (
          <ProposalDialog
            {...common}
            line={row.quoteLines.find((line) => line.id === step.lineId) ?? step.line}
            total={row.quoteTotal}
            onDone={() => finishStep(undefined)}
          />
        );
      case 'downPayment':
        return (
          <DownPaymentDialog
            {...common}
            mode={step.mode}
            current={row.downPayment}
            total={amountOwed(row)}
            onDone={() => finishStep('repair.done.downPayment')}
            onAsked={asked}
          />
        );
      case 'repairTypes':
        return (
          <RepairTypesDialog
            {...common}
            current={row.repairTypes}
            onDone={() => finishStep('repair.done.repairTypes')}
          />
        );
      case 'refund':
      case 'reduce': {
        const props = {
          target: ticketMoneyTarget(row),
          onClose: closeStep,
          onDone: () =>
            finishStep(step.kind === 'refund' ? 'repair.done.refund' : 'repair.done.reduce'),
          onAsked: asked,
        };
        return (
          <MoneyRuntimeProvider runtime={money}>
            {step.kind === 'refund' ? (
              <RefundDialog {...props} />
            ) : (
              <ReduceChargeDialog {...props} />
            )}
          </MoneyRuntimeProvider>
        );
      }
      case 'takePart':
        if (runtime.inventory === undefined) return null;
        return (
          <InventoryRuntimeProvider runtime={runtime.inventory}>
            <TakePartDialog
              use={partUse(row)}
              device={{ brand: row.deviceBrand, model: row.deviceModel }}
              onClose={closeStep}
              onDone={() => {
                closeStep();
                setDone(ti('inventory.done.taken'));
              }}
            />
          </InventoryRuntimeProvider>
        );
      case 'print':
        if (printing === undefined) return null;
        return (
          <PrintDialog
            ticket={row}
            printing={printing}
            onClose={closeStep}
            onDone={() => finishStep('repair.done.printed')}
          />
        );
      case 'handover':
        return (
          <HandoverDialog
            {...common}
            ticket={row}
            customerName={row.customerName}
            onDone={() => {
              finishStep(DONE_KEY.handover);
              setPrintNext('returned');
            }}
          />
        );
    }
  }
}

const COPY_LABEL = {
  idle: 'repair.desk.copyPhone',
  copied: 'repair.desk.copied',
  failed: 'repair.desk.copyFailed',
} as const satisfies Record<string, RepairKey>;

function CopyablePhone({ phone }: { readonly phone: string }): React.JSX.Element {
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <span className="inline-flex items-center gap-1" data-testid="repair.desk.ticket.phone">
      <Phone size={14} aria-hidden />
      <span className="tabular text-text">{formatPhone(phone)}</span>
      <IconButton
        icon={copy === 'copied' ? Check : Copy}
        label={tn(COPY_LABEL[copy])}
        size="sm"
        onClick={() => {
          navigator.clipboard.writeText(phone).then(
            () => setCopy('copied'),
            () => setCopy('failed'),
          );
        }}
        onBlur={() => setCopy('idle')}
      />
    </span>
  );
}

/** The screen lock, hidden until asked so it is not read over a shoulder at the counter. */
/**
 * The phone's screen lock, hidden until asked so it is not read over a shoulder at the counter:
 * the technician needs it to test the phone. A pattern shows its steps and the drawing.
 */
function Passcode({ value }: { readonly value: string }): React.JSX.Element {
  const [shown, setShown] = useState(false);
  const lock = decodeScreenLock(value);
  return (
    <Fact
      label={
        lock.kind === 'unknown'
          ? tn('repair.device.passcodeLabel')
          : `${tn('repair.device.passcodeLabel')} · ${tn(LOCK_KIND_KEY[lock.kind])}`
      }
      value={
        !shown ? (
          <span className="tabular">••••</span>
        ) : lock.kind === 'pattern' ? (
          <span className="flex flex-col gap-2">
            <span className="tabular">{patternSteps(lock.value)}</span>
            <PatternPad
              value={lock.value}
              size={144}
              label={tn('repair.lock.patternLabel')}
              testId="repair.desk.ticket.passcode.pattern"
            />
          </span>
        ) : (
          <span className="tabular">{lock.value}</span>
        )
      }
      testId="repair.desk.ticket.passcode"
      action={
        <Tooltip label={tn(shown ? 'repair.passcode.hide' : 'repair.passcode.show')}>
          <button
            type="button"
            aria-label={tn(shown ? 'repair.passcode.hide' : 'repair.passcode.show')}
            aria-pressed={shown}
            onClick={() => setShown((current) => !current)}
            className="flex size-7 cursor-pointer items-center justify-center self-start rounded-xs text-text-muted hover:bg-surface-alt hover:text-text"
          >
            {shown ? <EyeOff size={16} aria-hidden /> : <Eye size={16} aria-hidden />}
          </button>
        </Tooltip>
      }
    />
  );
}

function ChipGroup({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}): React.JSX.Element {
  return (
    <div>
      <p className="mb-1 text-small text-text-muted">{label}</p>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

interface TicketPhoto {
  readonly key: string;
  readonly caption: string;
  readonly group: string;
  readonly ref: ThumbnailRef;
}

/** Every photo on the ticket in the order it was taken: at intake, before, after, at handover. */
function ticketPhotos(row: TicketDetailRow): TicketPhoto[] {
  const intake = row.intakePhotos.flatMap(({ slot, label }) => {
    const photo = photoInSlot(row, slot);
    return photo === null
      ? []
      : [
          {
            key: slot,
            caption: optionLabel('photoAngles', { id: slot, label }),
            group: tn('repair.photo.intake'),
            photo,
          },
        ];
  });
  const work = (['before', 'after'] as const).flatMap((stage) =>
    workPhotos(row, stage).map((photo, index) => ({
      key: photo.slot,
      caption: tn(stage === 'before' ? 'repair.photo.beforeN' : 'repair.photo.afterN', {
        n: index + 1,
      }),
      group: tn(stage === 'before' ? 'repair.photo.before' : 'repair.photo.after'),
      photo,
    })),
  );
  const handover = HANDOVER_PHOTO_SLOTS.flatMap((slot) => {
    const photo = photoInSlot(row, slot);
    return photo === null
      ? []
      : [
          {
            key: slot,
            caption: tn(
              slot === 'signature' ? 'repair.handover.signature' : 'repair.photo.handover',
            ),
            group: tn('repair.photo.handover'),
            photo,
          },
        ];
  });
  return [...intake, ...work, ...handover].map(({ photo, ...rest }) => ({
    ...rest,
    ref: photoThumbnailRef(photo),
  }));
}

function TicketPhotos({ ticket }: { readonly ticket: TicketDetailRow }): React.JSX.Element | null {
  const photos = useMemo(() => ticketPhotos(ticket), [ticket]);
  // The open photo by key, so a photo syncing in ahead of it does not swap what is shown.
  const [openKey, setOpenKey] = useState<string | null>(null);
  const found = openKey === null ? -1 : photos.findIndex((photo) => photo.key === openKey);
  const open = found < 0 ? null : found;
  const setOpen = (index: number | null): void =>
    setOpenKey(index === null ? null : (photos[index]?.key ?? null));
  const [saveFailed, setSaveFailed] = useState(false);
  const runtime = useRepairRuntime();
  // Only the open photo is shown full size, so only its state is needed (the tiles resolve their own).
  const openState = usePhotoState(open === null ? null : (photos[open]?.ref ?? null));
  if (photos.length === 0) return null;
  const groups = [...new Set(photos.map((photo) => photo.group))];
  return (
    <Section title={tn('repair.photo.title')} testId="repair.desk.ticket.photos">
      <div className="flex flex-col gap-4">
        {groups.map((group) => (
          <div key={group}>
            <p className="mb-2 text-small text-text-muted">{group}</p>
            <div className="flex flex-wrap gap-3">
              {photos.map((photo, index) =>
                photo.group !== group ? null : (
                  <TicketPhotoTile key={photo.key} photo={photo} onOpen={() => setOpen(index)} />
                ),
              )}
            </div>
          </div>
        ))}
      </div>
      <PhotoViewer
        photos={photos.map((photo, index) => ({
          key: photo.key,
          caption: photo.caption,
          group: photo.group,
          state: index === open ? openState : { kind: 'loading' },
        }))}
        index={open}
        onIndexChange={(index) => {
          setSaveFailed(false);
          setOpen(index);
        }}
        onClose={() => {
          setSaveFailed(false);
          setOpen(null);
        }}
        notice={saveFailed ? tn('repair.photo.shareFailed') : null}
        onDownload={
          runtime.sharePhoto === undefined
            ? undefined
            : (photo) => {
                const ref = photos.find((candidate) => candidate.key === photo.key)?.ref;
                if (ref === undefined) return;
                void runtime.sharePhoto?.(ref).then((result) => setSaveFailed(result === 'failed'));
              }
        }
        labels={{
          ...photoLabels(),
          close: t('core.action.close'),
          previous: tn('repair.desk.photoPrevious'),
          next: tn('repair.desk.photoNext'),
          download: tn('repair.desk.photoDownload'),
          position: (index, total) => tn('repair.photo.position', { index, total }),
        }}
      />
    </Section>
  );
}

function TicketPhotoTile({
  photo,
  onOpen,
}: {
  readonly photo: TicketPhoto;
  readonly onOpen: () => void;
}): React.JSX.Element {
  const state = usePhotoState(photo.ref);
  return (
    <PhotoTile
      state={state}
      caption={photo.caption}
      labels={photoLabels()}
      openLabel={tn('repair.photo.open')}
      onOpen={onOpen}
      size="sm"
      testId={`repair.desk.ticket.photo.${photo.key}`}
    />
  );
}

function lineCaption(line: QuoteLineRow): string {
  const status = tn(
    line.status === 'proposed'
      ? 'repair.price.status.proposed'
      : line.status === 'declined'
        ? 'repair.price.status.declined'
        : line.customerAgreed === true
          ? 'repair.price.status.agreed'
          : 'repair.price.status.notAgreed',
  );
  return line.reason === null || line.reason === '' ? status : `${status} · ${line.reason}`;
}

/**
 * What was paid up front and what is left, under the total, with recording or changing it beside
 * the figure as the phone offers it.
 */
function DownPaymentLines({
  total,
  reduced,
  downPayment,
  paidLabel,
  returned,
  action,
  correctLabel,
  disabled,
  onAction,
}: {
  /** What is owed, already less `reduced`. */
  readonly total: number;
  /** What an owner took off the bill, shown above what was paid. */
  readonly reduced: number;
  readonly downPayment: number | null;
  readonly paidLabel: RepairKey;
  /** The phone went home: what is left to give back is still owed. */
  readonly returned: boolean;
  readonly action: 'record' | 'correct' | null;
  /** "Ubah DP", or for the counter, asking an owner to. */
  readonly correctLabel: string;
  readonly disabled: boolean;
  readonly onAction: (mode: 'record' | 'correct') => void;
}): React.JSX.Element | null {
  const record =
    action === 'record' ? (
      <Button
        label={tn('repair.downPayment.recordTitle')}
        icon={Plus}
        variant="text"
        size="sm"
        className="-ml-2 self-start"
        onClick={() => onAction('record')}
        disabled={disabled}
        data-testid="repair.desk.ticket.downPayment.record"
      />
    ) : null;
  const paid = downPayment ?? 0;
  if (paid === 0 && reduced === 0) return record;
  const balance = balanceAfterDownPayment(total, paid);
  const paidText = paidRow(paid, paidLabel);
  return (
    <>
      <dl className="flex flex-col gap-1" data-testid="repair.desk.ticket.balance">
        {reduced === 0 ? null : (
          <div className="flex items-center justify-between gap-4 text-body text-text-muted">
            <dt>{tn('repair.price.reduced')}</dt>
            <dd className="tabular" data-testid="repair.desk.ticket.reduced">
              {formatMoney(-reduced)}
            </dd>
          </div>
        )}
        {reduced === 0 ? null : (
          // What the bill is after the cut, so a fee that was cut never reads as what is billed.
          <div className="flex items-center justify-between gap-4 text-body font-semibold text-text">
            <dt>{tn('repair.price.billed')}</dt>
            <dd className="tabular" data-testid="repair.desk.ticket.billed">
              {formatMoney(total)}
            </dd>
          </div>
        )}
        {paid === 0 ? null : (
          <div className="flex items-center justify-between gap-4 text-body text-text-muted">
            <dt className="flex items-center gap-2">
              {paidText.label}
              {action === 'correct' ? (
                <Tooltip label={correctLabel}>
                  <Button
                    label={tn('repair.downPayment.change')}
                    aria-label={correctLabel}
                    variant="text"
                    size="sm"
                    className="-my-1"
                    onClick={() => onAction('correct')}
                    disabled={disabled}
                    data-testid="repair.desk.ticket.downPayment.correct"
                  />
                </Tooltip>
              ) : null}
            </dt>
            <dd className="tabular" data-testid="repair.desk.ticket.paid">
              <RollingText value={paid}>{paidText.amount}</RollingText>
            </dd>
          </div>
        )}
        <div className="flex justify-between gap-4 text-body font-semibold text-text">
          <dt>{tn(balanceLabelKey(balance.kind, returned))}</dt>
          <dd className="tabular">
            <RollingText value={balance.kind === 'due' ? balance.amount : -balance.amount}>
              {formatMoney(balance.amount)}
            </RollingText>
          </dd>
        </div>
      </dl>
      {paid === 0 ? record : null}
    </>
  );
}
