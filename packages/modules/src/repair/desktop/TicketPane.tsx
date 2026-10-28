// One repair beside the board: who and what, the next steps this user may take, the price with its
// changes, every photo, the condition at intake and the history. Steps that need input open a
// dialog; the rest run in place. Live like the phone's ticket: a change synced in from another
// device redraws it, and an open dialog says when that change means it can no longer finish.
import { formatDateTime, formatMoney, formatPhone, t, translateOpType } from '@bolusi/i18n';
import {
  Banner,
  Button,
  Chip,
  Fact,
  FactGrid,
  IconButton,
  Menu,
  PatternPad,
  PhotoTile,
  PhotoViewer,
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
  TriangleAlert,
  X,
} from 'lucide-react';
import { useMemo, useRef, useState, type ReactNode } from 'react';

import { hasRejectedOp, useActionRunner, type EntitySyncStatuses } from '../../screen-kit/index.js';
import { HANDOVER_PHOTO_SLOTS, REPAIR_OP } from '../constants.js';
import {
  MESSAGE_ACTION_KEY,
  customerMessageKind,
  customerMessageUrl,
  type CustomerMessageKind,
} from '../customer-message.js';
import { decodeScreenLock, patternSteps } from '../screen-lock.js';
import {
  amountOwed,
  arrangeTicketActions,
  balanceAfterDownPayment,
  CONTEXTUAL_ACTIONS,
  downPaymentAction,
  downPaymentStale,
  handoverCost,
  photoInSlot,
  photoThumbnailRef,
  repairAbilities,
  staleStep,
  ticketActions,
  ticketStatus,
  flagsUncollected,
  uncollectedDays,
  workPhotos,
  type TicketAction,
  type StaleStep,
  type TicketStep,
} from '../flows.js';
import type { QuoteLineRow, TicketDetailRow } from '../queries.js';
import { tn, type RepairKey } from '../i18n.js';
import { actionKey, LOCK_KIND_KEY, PRICE_KIND_KEY, optionLabel } from '../labels.js';
import {
  useRepairQuery,
  useRepairRuntime,
  useStoreDisplayName,
  useUncollectedLimit,
} from '../runtime.js';
import type { ThumbnailRef } from '../../screen-kit/index.js';

import {
  ActionError,
  CatalogPhoto,
  DeviceSpecs,
  QueryPanel,
  StatusChip,
  photoLabels,
  usePhotoState,
} from './parts.js';
import {
  AssignDialog,
  CancelDialog,
  DownPaymentDialog,
  HandoverDialog,
  PriceChangeDialog,
  PrintDialog,
  ProposalDialog,
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
  after: 'repair.done.repaired',
  handover: 'repair.desk.done.handover',
};

type Step =
  | { readonly kind: 'none' }
  | Exclude<TicketStep, { readonly kind: 'proposal' }>
  | { readonly kind: 'proposal'; readonly lineId: string; readonly line: QuoteLineRow }
  | { readonly kind: 'downPayment'; readonly mode: 'record' | 'correct' }
  | { readonly kind: 'print' };

interface LoadedTicket {
  readonly ticket: TicketDetailRow | undefined;
  readonly statuses: EntitySyncStatuses;
}

export interface TicketPaneProps {
  readonly ticketId: string;
  /** The clock a phone's wait is counted against (phones not collected). */
  readonly now: () => number;
  readonly onClose: () => void;
  /** Where a refused change is explained; without it the banner only says so. */
  readonly onOpenSyncStatus?: (() => void) | undefined;
}

export function TicketPane({
  ticketId,
  now,
  onClose,
  onOpenSyncStatus,
}: TicketPaneProps): React.JSX.Element {
  const runtime = useRepairRuntime();
  const can = useMemo(() => repairAbilities(runtime.hasPermission), [runtime]);
  const runner = useActionRunner();
  const printing = runtime.printing;
  const [step, setStep] = useState<Step>({ kind: 'none' });
  const [done, setDone] = useState<RepairKey | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  const query = useRepairQuery<LoadedTicket>(
    async (rt) => {
      const page = await rt.query('getTicket', { ticketId });
      return { ticket: page.rows[0], statuses: await rt.ticketSyncStatuses([ticketId]) };
    },
    `desk.ticket:${ticketId}:${String(reloadNonce)}`,
  );
  const ticket = query.status === 'ready' ? query.data.ticket : undefined;
  // An open step outlives a failed re-read: it keeps the last good ticket, so photos taken and
  // text typed in a dialog are not thrown away by a hiccup in the background.
  const lastTicket = useRef<TicketDetailRow | undefined>(undefined);
  if (ticket !== undefined) lastTicket.current = ticket;
  const stepTicket = ticket ?? lastTicket.current;
  const statuses = query.status === 'ready' ? (query.data.statuses[ticketId] ?? []) : [];
  const actions = ticket === undefined ? [] : ticketActions(ticket, can, runtime.userId);
  const stale: StaleStep | null =
    step.kind === 'none' || step.kind === 'print' || ticket === undefined
      ? null
      : step.kind === 'downPayment'
        ? downPaymentStale(ticket, can, step.mode)
        : staleStep(step, ticket, can, runtime.userId);

  const closeStep = (): void => setStep({ kind: 'none' });
  const finishStep = (said: RepairKey | undefined): void => {
    closeStep();
    setDone(said ?? null);
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
              if (result !== undefined) setDone(DONE_KEY[action] ?? null);
            });
        return;
      case 'claim':
        void runner
          .run(() => runtime.run('claimTicket', { ticketId }))
          .then((result) => {
            if (result !== undefined) setDone(DONE_KEY.claim ?? null);
          });
        return;
      case 'markRepaired':
        setStep({ kind: 'after' });
        return;
      case 'handover':
      case 'waitForParts':
      case 'cancel':
      case 'assign':
      case 'changePrice':
      case 'proposePrice':
        setStep({ kind: action });
        return;
    }
  };

  const storeName = useStoreDisplayName();
  const uncollectedLimit = useUncollectedLimit();
  const messageKind = ticket === undefined ? null : customerMessageKind(ticket, can);
  // Writes the message and opens WhatsApp on the customer's number; the person checks it and sends.
  const sendMessage = (kind: CustomerMessageKind, row: TicketDetailRow): void => {
    const url = customerMessageUrl(kind, row, storeName);
    if (url === null) return;
    setDone(null);
    window.open(url, '_blank', 'noopener');
  };

  const label = (action: TicketAction): string =>
    tn(actionKey(action, ticket?.technicianId ?? null));

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
    ) : hasRejectedOp(statuses) ? (
      <Banner
        tone="danger"
        message={t('sync.rejected.banner', { count: 1 })}
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
        message={tn(done)}
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
    return (
      <header className="flex flex-col gap-4 border-b border-border px-6 pb-4 pt-4">
        <div className="flex items-start gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span
              className="tabular shrink-0 whitespace-nowrap text-small font-semibold text-text-muted"
              data-testid="repair.desk.ticket.number"
            >
              {row.ticketNumber}
            </span>
            <StatusChip status={ticketStatus(row)} />
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
          <h2 className="text-title font-bold text-text" data-testid="repair.desk.ticket.customer">
            {row.customerName}
          </h2>
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
        layout.more.length === 0 &&
        printing === undefined &&
        messageKind === null ? null : (
          // The next step leads; printing and the rarer moves ("Lainnya") wait quietly at the end.
          <div className="flex items-center gap-2">
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
              {layout.more.length === 0 ? null : (
                <Menu
                  trigger={
                    <IconButton
                      icon={Ellipsis}
                      label={tn('repair.action.more')}
                      disabled={runner.busy}
                      data-testid="repair.desk.ticket.more"
                    />
                  }
                  items={layout.more.map((action) => ({
                    key: action,
                    label: label(action),
                    onSelect: () => perform(action, row),
                  }))}
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

        <FactGrid>
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
          {row.outcome === 'cancelled' && row.cancelFee !== null ? (
            <Fact label={tn('repair.cancel.fee')} value={formatMoney(row.cancelFee)} />
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
        <TicketPhotos ticket={row} />
        {renderCondition(row)}
        <DeviceSpecs brand={row.deviceBrand} model={row.deviceModel} repairs={can.work} />

        <Section title={tn('repair.ticket.history')} testId="repair.desk.ticket.history">
          <Timeline
            entries={[...row.events].reverse().map((event) => {
              const note = eventNote(event.detail);
              return {
                key: event.id,
                // A change saved before the customer agreed reads as waiting, not as changed.
                title:
                  event.kind === REPAIR_OP.quoteChanged && event.detail['waitsForCustomer'] === true
                    ? tn('repair.price.waitingEvent')
                    : translateOpType(event.kind),
                meta: [formatDateTime(event.at), event.actorName]
                  .filter((part) => part !== null)
                  .join(' · '),
                ...(note === null ? {} : { detail: note }),
              };
            })}
          />
        </Section>

        {actions.includes('cancel') ? (
          <div className="border-t border-border pt-6">
            {/* Kept apart at the end: it is final for the repair, so it never reads as the next step. */}
            <Button
              label={tn('repair.action.cancel')}
              variant="dangerText"
              className="-ml-2"
              onClick={() => perform('cancel', row)}
              disabled={runner.busy}
              data-testid="repair.desk.ticket.action.cancel"
            />
          </div>
        ) : null}
      </>
    );
  }

  function renderPrice(row: TicketDetailRow): React.JSX.Element {
    const pending = row.quoteLines.filter((line) => line.status === 'proposed');
    const deciding = actions.includes('decidePrice');
    const cancelled = row.outcome === 'cancelled';
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
            {formatMoney(row.quoteTotal)}
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
                {formatMoney(row.cancelFee ?? 0)}
              </p>
            </div>
            <p className="text-small text-text-muted">{tn('repair.price.notCharged')}</p>
          </>
        ) : null}
        <DownPaymentLines
          total={amountOwed(row)}
          downPayment={row.downPayment}
          action={downPaymentAction(row, can)}
          disabled={runner.busy}
          onAction={(mode) => {
            setDone(null);
            setStep({ kind: 'downPayment', mode });
          }}
        />
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

  function renderStep(row: TicketDetailRow): React.JSX.Element | null {
    const common = { ticketId, stale, onClose: closeStep };
    switch (step.kind) {
      case 'none':
        return null;
      case 'before':
      case 'after':
        return (
          <WorkPhotosDialog
            {...common}
            stage={step.kind}
            onDone={() => finishStep(DONE_KEY[step.kind])}
          />
        );
      case 'waitForParts':
        return <WaitForPartsDialog {...common} onDone={() => finishStep(undefined)} />;
      case 'cancel':
        return (
          <CancelDialog
            {...common}
            workStarted={row.workStarted}
            onDone={() => finishStep(undefined)}
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
        return <PriceChangeDialog {...common} mode="change" onDone={() => finishStep(undefined)} />;
      case 'proposePrice':
        return (
          <PriceChangeDialog {...common} mode="propose" onDone={() => finishStep(undefined)} />
        );
      case 'proposal':
        return (
          <ProposalDialog
            {...common}
            line={row.quoteLines.find((line) => line.id === step.lineId) ?? step.line}
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
          />
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
            customerName={row.customerName}
            cancelled={row.outcome === 'cancelled'}
            amount={handoverCost(row)}
            downPayment={row.downPayment}
            onDone={() => finishStep(DONE_KEY.handover)}
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

/** The note or reason a person typed with an event (a cancel reason, a parts note), if any. */
function eventNote(detail: Readonly<Record<string, unknown>>): string | null {
  for (const field of ['note', 'reason'] as const) {
    const value = detail[field];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

/**
 * What was paid up front and what is left, under the total, with recording or changing it beside
 * the figure as the phone offers it.
 */
function DownPaymentLines({
  total,
  downPayment,
  action,
  disabled,
  onAction,
}: {
  readonly total: number;
  readonly downPayment: number | null;
  readonly action: 'record' | 'correct' | null;
  readonly disabled: boolean;
  readonly onAction: (mode: 'record' | 'correct') => void;
}): React.JSX.Element | null {
  if (downPayment === null || downPayment === 0) {
    return action === 'record' ? (
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
  }
  const balance = balanceAfterDownPayment(total, downPayment);
  return (
    <dl className="flex flex-col gap-1" data-testid="repair.desk.ticket.balance">
      <div className="flex items-center justify-between gap-4 text-body text-text-muted">
        <dt className="flex items-center gap-2">
          {tn('repair.price.downPayment')}
          {action === 'correct' ? (
            <Tooltip label={tn('repair.downPayment.correctTitle')}>
              <Button
                label={tn('repair.downPayment.change')}
                aria-label={tn('repair.downPayment.correctTitle')}
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
        <dd className="tabular">{formatMoney(-downPayment)}</dd>
      </div>
      <div className="flex justify-between gap-4 text-body font-semibold text-text">
        <dt>{tn(balance.kind === 'due' ? 'repair.price.balance' : 'repair.price.refund')}</dt>
        <dd className="tabular">{formatMoney(balance.amount)}</dd>
      </div>
    </dl>
  );
}
