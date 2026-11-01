/**
 * TicketDetail — one repair: who and what, where it stands, the price with its changes, every
 * photo, the history, and the next steps this user may take. Each step that needs input opens its
 * own full-screen step (TicketSteps.tsx); the rest run in place. The rejected-op banner shows here,
 * where the change was made (05-operation-log §8).
 */
import { formatDateTime, formatMoney, formatPhone, t } from '@bolusi/i18n';
import {
  AppShell,
  Banner,
  Button,
  Card,
  Chip,
  Icon,
  ListRow,
  PatternLock,
  RollingText,
  Sheet,
  TextButton,
  Timeline,
  border,
  color,
  radius,
  size,
  space,
  touch,
  type,
  Text,
} from '@bolusi/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Linking, Platform, Pressable, StyleSheet, View } from 'react-native';

import { ApprovalSection, ApprovalStep } from '../../approvals/screens/ApprovalViews.js';
import { ta } from '../../approvals/i18n.js';
import type { ApprovalRow } from '../../approvals/queries.js';
import { describeRepairApproval } from '../approval-copy.js';
import { HANDOVER_PHOTO_SLOTS } from '../constants.js';
import {
  MESSAGE_ACTION_KEY,
  customerMessageKind,
  customerMessageUrl,
  type CustomerMessageKind,
} from '../customer-message.js';
import { decodeScreenLock, patternSteps } from '../screen-lock.js';
import { whatsAppAppUrl, whatsAppUrl } from '../../shared/whatsapp.js';
import type { QuoteLineRow, TicketDetailRow } from '../queries.js';
import {
  rejectedCount,
  useActionRunner,
  type DiscardGuard,
  type EntitySyncStatuses,
  type StepBack,
} from '../../screen-kit/index.js';

import { tn, type RepairKey } from '../i18n.js';
import {
  actionKey,
  downPaymentTitleKey,
  historyEntry,
  LOCK_KIND_KEY,
  PRICE_KIND_KEY,
  optionLabel,
  warrantyLine,
} from '../labels.js';
import {
  discountsStanding,
  amountOwed,
  arrangeTicketActions,
  CONTEXTUAL_ACTIONS,
  FINAL_ACTIONS,
  canSetRepairTypes,
  canUseParts,
  partUse,
  claimIntakeDraft,
  downPaymentAction,
  downPaymentStale,
  paidLabelKey,
  photoInSlot,
  photoThumbnailRef,
  repairAbilities,
  repairTypesStale,
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
  type StaleStep,
  type TicketAction,
  type TicketStep,
  repairedDoneKey,
} from '../flows.js';
import { useClearAskedNotice } from '../asked-notice.js';
import {
  ActionErrorBanner,
  DownPaymentRows,
  CatalogPhoto,
  DeviceSpecs,
  Fact,
  FactGrid,
  QueryView,
  Section,
  StatusChip,
  repairStyles,
  type RepairChrome,
} from './parts.js';
import { usePhotoBrowser, type BrowsablePhoto } from './photos.js';
import { TicketVideoSection } from './video.js';
import {
  readApprovals,
  moneyRuntimeOf,
  useRepairQuery,
  useRepairRuntime,
  useStoreDisplayName,
  useUncollectedLimit,
} from '../runtime.js';
import { PrintStep } from './PrintStep.js';
import { CorrectDetailsStep } from './CorrectDetailsStep.js';
import { tm } from '../../money/i18n.js';
import { MoneyRuntimeProvider } from '../../money/runtime.js';
import { ReduceChargeStep, RefundStep } from '../../money/screens/KasSteps.js';
import { INVENTORY_PERMISSION } from '../../inventory/constants.js';
import { ti } from '../../inventory/i18n.js';
import type { UsedPartRow } from '../../inventory/queries.js';
import { InventoryRuntimeProvider } from '../../inventory/runtime.js';
import { PutBackStep, TakePartStep, UsedPartsSection } from '../../inventory/screens/UsedParts.js';
import {
  AssignStep,
  CancelStep,
  UndoHandoverStep,
  ChangeCancelFeeStep,
  DownPaymentStep,
  WaitForPartsStep,
  PriceChangeStep,
  ProposalStep,
  RepairTypesStep,
  WorkPhotosStep,
} from './TicketSteps.js';

/** What an action that runs in place says once it lands, in the fixed banner slot. */
const DONE_KEY: Partial<Record<TicketAction, RepairKey>> = {
  claim: 'repair.done.claim',
  start: 'repair.done.start',
  resume: 'repair.done.start',
  reopen: 'repair.done.start',
};

/** The open step, if any. A proposal keeps the line as it was opened, for when no fresher read is at hand. */
type Step =
  | { readonly kind: 'none' }
  | { readonly kind: Exclude<TicketStep['kind'], 'proposal' | 'handover' | 'correctDetails'> }
  | { readonly kind: 'proposal'; readonly lineId: string; readonly line: QuoteLineRow }
  /** The servisan as it read when the correction opened: the form starts from it. */
  | { readonly kind: 'correctDetails'; readonly ticket: TicketDetailRow }
  | { readonly kind: 'downPayment'; readonly mode: 'record' | 'correct' }
  | { readonly kind: 'repairTypes' }
  | { readonly kind: 'print' }
  | { readonly kind: 'takePart' }
  | { readonly kind: 'putBackPart'; readonly part: UsedPartRow }
  | { readonly kind: 'approval'; readonly requestId: string }
  | { readonly kind: 'refund' }
  | { readonly kind: 'reduce' };

export interface TicketDetailProps {
  readonly ticketId: string;
  /**
   * Just opened by an intake or handed over: opens on its slip, as the customer is still at the
   * counter. Read once, when the screen opens.
   */
  readonly printFirst?: boolean | undefined;
  readonly chrome: RepairChrome;
  /** The clock a phone's wait is counted against (phones not collected). */
  readonly now: () => number;
  readonly onBack: () => void;
  /** Beside the board on a tablet there is nothing to go back to: the board is already in view. */
  readonly hideBack?: boolean | undefined;
  /** It was opened just now by an intake: its number lands like a stamp once it shows. */
  readonly justOpened?: boolean | undefined;
  readonly onHandover: (ticketId: string) => void;
  readonly onOpenSyncStatus: () => void;
  /** Starts a warranty claim's intake from this servisan; without it the claim is not offered. */
  readonly onStartClaim?: ((draft: IntakeDraft) => void) | undefined;
  /** Opens a linked servisan: the one a claim is on, or a claim on this one. */
  readonly onOpenTicket?: ((ticketId: string) => void) | undefined;
  /** Hardware back closes an open step back to the ticket before it leaves the ticket. */
  readonly onRegisterStepBack?: ((back: StepBack | null) => void) | undefined;
  /** Leaving the surface (header sync chip, lock) asks the open step first, like back does. */
  readonly onRegisterDiscardGuard?: ((guard: DiscardGuard | null) => void) | undefined;
  readonly testID?: string | undefined;
}

interface LoadedTicket {
  readonly ticket: TicketDetailRow | undefined;
  readonly statuses: EntitySyncStatuses;
  /** The approval requests on it (a discount or a cancel asked of an owner), newest first. */
  readonly approvals: readonly ApprovalRow[];
}

export function TicketDetail({
  ticketId,
  printFirst = false,
  chrome,
  now,
  onBack,
  hideBack = false,
  justOpened = false,
  onHandover,
  onOpenSyncStatus,
  onStartClaim,
  onOpenTicket,
  onRegisterStepBack,
  onRegisterDiscardGuard,
  testID = 'repair.ticket',
}: TicketDetailProps): React.JSX.Element {
  const runtime = useRepairRuntime();
  const can = useMemo(() => repairAbilities(runtime.hasPermission), [runtime]);
  // Money back to the customer and a lowered bill are the ledger's steps, over repair's port.
  const money = useMemo(() => moneyRuntimeOf(runtime, () => null), [runtime]);
  const runner = useActionRunner();
  const [step, setStep] = useState<Step>(() =>
    printFirst && runtime.printing !== undefined ? { kind: 'print' } : { kind: 'none' },
  );
  const [reloadNonce, setReloadNonce] = useState(0);
  // What the last action did, already in words: repair's own steps and the parts steps say it.
  const [done, setDone] = useState<string | null>(null);
  const [passcodeShown, setPasscodeShown] = useState(false);
  const [messageFailed, setMessageFailed] = useState(false);
  const storeName = useStoreDisplayName();
  const uncollectedLimit = useUncollectedLimit();
  // An open step holding photos asks before it is dropped (header back, hardware back).
  const stepGuardRef = useRef<DiscardGuard | null>(null);
  const registerStepGuard = useCallback((guard: DiscardGuard | null): void => {
    stepGuardRef.current = guard;
  }, []);

  const query = useRepairQuery<LoadedTicket>(
    async (rt) => {
      const page = await rt.query('getTicket', { ticketId });
      return {
        ticket: page.rows[0],
        statuses: await rt.ticketSyncStatuses([ticketId]),
        approvals: await readApprovals(rt, ticketId),
      };
    },
    `ticket:${ticketId}:${String(reloadNonce)}`,
  );
  useClearAskedNotice(
    done,
    () => setDone(null),
    query.status === 'ready' ? query.data.approvals : undefined,
  );

  const ticket = query.status === 'ready' ? query.data.ticket : undefined;
  const photos = usePhotoBrowser(
    useMemo(() => (ticket === undefined ? [] : ticketPhotos(ticket)), [ticket]),
    `${testID}.photos`,
  );
  const photosBack = useRef(photos.back);
  photosBack.current = photos.back;
  // The rarer moves ("Lainnya") open in a sheet; back closes it like the photo sheet.
  const [moreOpen, setMoreOpen] = useState(false);
  const moreBack = useRef(moreOpen);
  moreBack.current = moreOpen;
  const rejected =
    query.status === 'ready' ? rejectedCount(query.data.statuses[ticketId] ?? []) : 0;
  const closeStep = (): void => setStep({ kind: 'none' });
  const leaveStep = useCallback((): void => {
    const guard = stepGuardRef.current;
    const close = (): void => setStep({ kind: 'none' });
    if (guard === null) close();
    else guard(close);
  }, []);
  const stepOpen = step.kind !== 'none';

  useEffect(() => {
    onRegisterStepBack?.(() => {
      // An open photo or the photo sheet closes first, then a step, then the ticket.
      if (photosBack.current()) return true;
      if (moreBack.current) {
        setMoreOpen(false);
        return true;
      }
      if (!stepOpen) return false;
      leaveStep();
      return true;
    });
    return () => onRegisterStepBack?.(null);
  }, [stepOpen, onRegisterStepBack, leaveStep]);

  useEffect(() => {
    onRegisterDiscardGuard?.((proceed) => {
      const guard = stepGuardRef.current;
      if (guard === null) proceed();
      else guard(proceed);
    });
    return () => onRegisterDiscardGuard?.(null);
  }, [onRegisterDiscardGuard]);

  // The ticket keeps reading live under an open step, so a change synced from another device while
  // the user fills the step in is caught here rather than as a refusal once they submit.
  const stale: StaleStep | null =
    step.kind === 'none' ||
    step.kind === 'print' ||
    step.kind === 'takePart' ||
    step.kind === 'putBackPart' ||
    step.kind === 'approval' ||
    step.kind === 'refund' ||
    step.kind === 'reduce' ||
    ticket === undefined
      ? null
      : step.kind === 'downPayment'
        ? downPaymentStale(ticket, can, step.mode)
        : step.kind === 'repairTypes'
          ? repairTypesStale(ticket, can)
          : staleStep(step, ticket, can, runtime.userId, now());
  // A step that asked an owner instead (a discount, a cancel, a DP fix, a refund or a lower bill
  // beyond this person) says so.
  const asked = (): void => {
    closeStep();
    setDone(ta('approvals.done.asked'));
  };
  const stepProps = {
    chrome,
    ticketId,
    stale,
    onDone: closeStep,
    onCancel: leaveStep,
    onRegisterDiscardGuard: registerStepGuard,
  };

  switch (step.kind) {
    case 'before':
    case 'after':
      return (
        <WorkPhotosStep
          {...stepProps}
          stage={step.kind}
          onDone={() => {
            closeStep();
            setDone(tn(step.kind === 'before' ? 'repair.done.start' : repairedDoneKey(ticket)));
          }}
        />
      );
    case 'waitForParts':
      return <WaitForPartsStep {...stepProps} />;
    case 'undoHandover':
      return (
        <UndoHandoverStep
          {...stepProps}
          onDone={() => {
            closeStep();
            setDone(tn('repair.done.handoverUndone'));
          }}
        />
      );
    case 'changeCancelFee':
      return (
        <ChangeCancelFeeStep
          {...stepProps}
          current={(ticket?.cancelFee ?? 0) - (ticket?.reduced ?? 0)}
          paid={ticket?.downPayment ?? 0}
          onDone={() => {
            closeStep();
            setDone(tn('repair.done.cancelFeeChanged'));
          }}
        />
      );
    case 'correctDetails':
      return (
        <CorrectDetailsStep
          {...stepProps}
          ticket={step.ticket}
          onDone={() => {
            closeStep();
            setDone(tn('repair.done.corrected'));
          }}
        />
      );
    case 'cancel':
      return (
        <CancelStep
          {...stepProps}
          workStarted={ticket?.workStarted ?? false}
          claimOf={ticket?.claimOfTicketId ?? null}
          onAsked={asked}
          downPayment={ticket?.downPayment ?? 0}
          discounted={discountsStanding(ticket?.quoteLines ?? [])}
        />
      );
    case 'assign':
      return <AssignStep {...stepProps} currentTechnicianId={ticket?.technicianId ?? null} />;
    case 'changePrice':
      return (
        <PriceChangeStep
          {...stepProps}
          mode="change"
          discounted={discountsStanding(ticket?.quoteLines ?? [])}
          onAsked={asked}
        />
      );
    case 'proposePrice':
      return (
        <PriceChangeStep
          {...stepProps}
          mode="propose"
          discounted={discountsStanding(ticket?.quoteLines ?? [])}
        />
      );
    case 'proposal':
      return (
        <ProposalStep
          {...stepProps}
          line={ticket?.quoteLines.find((line) => line.id === step.lineId) ?? step.line}
          total={ticket?.quoteTotal ?? 0}
        />
      );
    case 'downPayment':
      return (
        <DownPaymentStep
          {...stepProps}
          mode={step.mode}
          current={ticket?.downPayment ?? null}
          total={ticket === undefined ? 0 : amountOwed(ticket)}
          onDone={() => {
            closeStep();
            setDone(tn('repair.done.downPayment'));
          }}
          onAsked={asked}
        />
      );
    case 'repairTypes':
      return (
        <RepairTypesStep
          {...stepProps}
          current={ticket?.repairTypes ?? []}
          onDone={() => {
            closeStep();
            setDone(tn('repair.done.repairTypes'));
          }}
        />
      );
    case 'print':
      if (ticket === undefined || runtime.printing === undefined) break;
      return (
        <PrintStep
          chrome={chrome}
          ticket={ticket}
          printing={runtime.printing}
          onCancel={closeStep}
          onDone={(notice) => {
            closeStep();
            setDone(tn(notice));
          }}
        />
      );
    case 'takePart':
    case 'putBackPart': {
      const inventory = runtime.inventory;
      if (ticket === undefined || inventory === undefined) break;
      const use = partUse(ticket);
      return (
        <InventoryRuntimeProvider runtime={inventory}>
          {step.kind === 'takePart' ? (
            <TakePartStep
              chrome={chrome}
              use={use}
              device={{ brand: ticket.deviceBrand, model: ticket.deviceModel }}
              onCancel={closeStep}
              onDone={() => {
                closeStep();
                setDone(ti('inventory.done.taken'));
              }}
            />
          ) : (
            <PutBackStep
              chrome={chrome}
              use={use}
              part={step.part}
              onCancel={closeStep}
              onDone={() => {
                closeStep();
                setDone(ti('inventory.done.putBack'));
              }}
            />
          )}
        </InventoryRuntimeProvider>
      );
    }
    case 'approval': {
      const request =
        query.status === 'ready'
          ? query.data.approvals.find((row) => row.id === step.requestId)
          : undefined;
      if (request === undefined) break;
      return (
        <ApprovalStep
          chrome={chrome}
          port={runtime.approvals}
          request={request}
          description={describeRepairApproval(request)}
          onCancel={closeStep}
          onDone={(notice) => {
            closeStep();
            setDone(notice);
          }}
          testID={`${testID}.approval`}
        />
      );
    }
    case 'refund':
    case 'reduce': {
      if (ticket === undefined) break;
      const moneyStep = {
        chrome,
        target: ticketMoneyTarget(ticket),
        onCancel: leaveStep,
        onRegisterDiscardGuard: registerStepGuard,
        onDone: () => {
          closeStep();
          setDone(tn(step.kind === 'refund' ? 'repair.done.refund' : 'repair.done.reduce'));
        },
        onAsked: asked,
      };
      return (
        <MoneyRuntimeProvider runtime={money}>
          {step.kind === 'refund' ? (
            <RefundStep {...moneyStep} />
          ) : (
            <ReduceChargeStep {...moneyStep} />
          )}
        </MoneyRuntimeProvider>
      );
    }
    case 'none':
      break;
  }

  const runInPlace = (action: TicketAction, run: () => Promise<unknown>): void => {
    setDone(null);
    void runner.run(run).then((result) => {
      const key = DONE_KEY[action];
      if (result !== undefined) setDone(key === undefined ? null : tn(key));
    });
  };

  const perform = (action: TicketAction, row: TicketDetailRow): void => {
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
        else runInPlace(action, () => runtime.run('startWork', { ticketId }));
        return;
      case 'claim':
        runInPlace(action, () => runtime.run('claimTicket', { ticketId }));
        return;
      case 'markRepaired':
        setStep({ kind: 'after' });
        return;
      case 'handover':
        onHandover(ticketId);
        return;
      case 'correctDetails':
        setStep({ kind: action, ticket: row });
        return;
      case 'waitForParts':
      case 'cancel':
      case 'undoHandover':
      case 'changeCancelFee':
      case 'assign':
      case 'changePrice':
      case 'proposePrice':
        setStep({ kind: action });
        return;
    }
  };

  // The next step is the bottom action, in the thumb zone like every other flow; its one real
  // alternative sits under the summary with the rarer moves behind "Lainnya", and cancelling is kept
  // apart at the end so it is never hit by habit.
  const actions = ticket === undefined ? [] : ticketActions(ticket, can, runtime.userId, now());
  const layout =
    ticket === undefined
      ? { next: null, alternative: null, more: [] }
      : arrangeTicketActions(actions, ticket, runtime.userId);
  const primary = layout.next ?? undefined;
  const messageKind =
    ticket === undefined ? null : customerMessageKind(ticket, can, runtime.statusSite);
  const claimAction =
    ticket === undefined || onStartClaim === undefined
      ? null
      : warrantyClaimAction(ticket, can, now());
  // Writes the message and opens WhatsApp on the customer's number; the person checks it and sends.
  // A phone opens the app itself, so a phone without WhatsApp says so instead of landing in a
  // browser; the web preview keeps the wa.me link.
  const sendMessage = (kind: CustomerMessageKind, row: TicketDetailRow): void => {
    const url = customerMessageUrl(
      kind,
      row,
      storeName,
      runtime.statusSite,
      Platform.OS === 'web' ? whatsAppUrl : whatsAppAppUrl,
    );
    if (url === null) return;
    setDone(null);
    setMessageFailed(false);
    Linking.openURL(url).catch(() => setMessageFailed(true));
  };
  // The counter's "cancel" asks an owner to cancel.
  const label = (action: TicketAction): string =>
    action === 'cancel' && !can.cancel
      ? tn('repair.approval.askCancel')
      : tn(actionKey(action, ticket?.technicianId ?? null));

  // One banner at a time, in the fixed slot so it shows wherever the user has scrolled: a refusal of
  // what they just did (WhatsApp not opening included; dismissing it shows what it covered), then a
  // rejected op from sync, then what their last action did.
  const banner =
    runner.errorCode !== null ? (
      <ActionErrorBanner
        errorCode={runner.errorCode}
        onDismiss={runner.clearError}
        testID={`${testID}.actionError`}
      />
    ) : messageFailed ? (
      <Banner
        variant="danger"
        message={tn('repair.message.openFailed')}
        onPress={() => setMessageFailed(false)}
        testID={`${testID}.messageFailed`}
      />
    ) : rejected > 0 ? (
      <Banner
        variant="danger"
        message={t('sync.rejected.banner', { count: rejected })}
        onPress={onOpenSyncStatus}
        testID={`${testID}.rejectedBanner`}
      />
    ) : done !== null ? (
      <Banner
        variant="info"
        message={done}
        onPress={() => setDone(null)}
        testID={`${testID}.done`}
      />
    ) : undefined;

  return (
    <AppShell
      scrollable
      title={ticket?.ticketNumber ?? tn('repair.ticket.title')}
      titleVariant="detail"
      stampTitle={justOpened && ticket !== undefined}
      onBack={hideBack ? undefined : onBack}
      backLabel={t('core.action.back')}
      syncChip={chrome.syncChip}
      avatar={chrome.avatar}
      banner={banner}
      overlay={
        moreOpen && ticket !== undefined ? (
          <Sheet
            title={tn('repair.action.more')}
            closeLabel={t('core.action.close')}
            onClose={() => setMoreOpen(false)}
            testID={`${testID}.more`}
          >
            {moreActions(ticket).map((item) => (
              <ListRow
                key={item.key}
                primaryText={item.label}
                onPress={() => {
                  setMoreOpen(false);
                  item.onPress();
                }}
                testID={`${testID}.action.${item.key}`}
              />
            ))}
          </Sheet>
        ) : (
          photos.overlay
        )
      }
      bottomAction={
        ticket === undefined || primary === undefined ? undefined : (
          <Button
            label={label(primary)}
            onPress={() => perform(primary, ticket)}
            busy={runner.busy}
            disabled={runner.busy}
            testID={`${testID}.action.${primary}`}
          />
        )
      }
      testID={testID}
    >
      <QueryView
        query={query}
        onBack={onBack}
        onRetry={() => setReloadNonce((n) => n + 1)}
        testID={testID}
      >
        {(data) => (data.ticket === undefined ? null : renderTicket(data.ticket, data.approvals))}
      </QueryView>
    </AppShell>
  );

  /** The rarer moves, printing among them: on a phone a slip is a PDF to share, now and then. */
  function moreActions(
    row: TicketDetailRow,
  ): readonly { readonly key: string; readonly label: string; readonly onPress: () => void }[] {
    return [
      ...layout.more.map((action) => ({
        key: action,
        label: label(action),
        onPress: () => perform(action, row),
      })),
      ...(runtime.printing === undefined
        ? []
        : [
            {
              key: 'print',
              label: tn('repair.print.title'),
              onPress: () => setStep({ kind: 'print' }),
            },
          ]),
    ];
  }

  function renderTicket(
    row: TicketDetailRow,
    approvals: readonly ApprovalRow[],
  ): React.JSX.Element {
    const lock = row.devicePasscode === null ? null : decodeScreenLock(row.devicePasscode);
    const device = [row.deviceBrand, row.deviceModel, row.deviceColor]
      .filter((s) => s !== '')
      .join(' · ');
    // An action that changes one fact sits beside that fact; the bottom action is never repeated.
    // Beside the technician's name the verb alone says it: "Pilih" or "Ganti".
    const shortAssignKey: RepairKey =
      row.technicianId === null ? 'repair.action.assignShort' : 'repair.action.reassignShort';
    const contextual = (action: TicketAction): ReactNode =>
      CONTEXTUAL_ACTIONS.has(action) && actions.includes(action) && layout.next !== action ? (
        <TextButton
          label={
            action === 'assign'
              ? tn(shortAssignKey)
              : action === 'changeCancelFee'
                ? tn('repair.cancelFee.short')
                : label(action)
          }
          accessibilityLabel={label(action)}
          onPress={() => perform(action, row)}
          disabled={runner.busy}
          testID={`${testID}.action.${action}`}
        />
      ) : null;
    const more = moreActions(row);
    // The counter and owners call the customer about a phone left too long; technicians need not.
    const waited =
      flagsUncollected(can) && uncollectedLimit.status === 'ready'
        ? uncollectedDays(row, uncollectedLimit.data.days, now())
        : null;
    return (
      <View testID={`${testID}.content`}>
        <Card freshId={row.id} testID={`${testID}.summary`}>
          <View style={styles.statusRow}>
            <StatusChip status={ticketStatus(row)} testID={`${testID}.status`} />
            {row.claimOf === null ? null : (
              <Chip
                label={tn('repair.warrantyClaim.title')}
                icon="repair"
                testID={`${testID}.claimChip`}
              />
            )}
            {waited === null ? null : (
              <Chip
                label={tn('repair.board.waited', { days: waited })}
                icon="warning"
                tone="warning"
                testID={`${testID}.uncollected`}
              />
            )}
          </View>
          <View style={styles.customerRow}>
            <Text style={styles.customer} testID={`${testID}.customer`}>
              {row.customerName}
            </Text>
            {contextual('correctDetails')}
          </View>
          {row.customerPhone === null ? null : (
            // Tap to call: the counter rings the customer when the phone is ready or a price changes.
            <Pressable
              accessibilityRole="link"
              onPress={() => void Linking.openURL(`tel:${row.customerPhone ?? ''}`)}
              style={styles.phone}
              testID={`${testID}.phone`}
            >
              <Icon name="phone" size={size.iconChip} color={color.primary} />
              <Text style={styles.link}>{formatPhone(row.customerPhone)}</Text>
            </Pressable>
          )}
          <View style={styles.deviceBox}>
            <CatalogPhoto
              brand={row.deviceBrand}
              model={row.deviceModel}
              large
              testID={`${testID}.devicePhoto`}
            />
            <View style={styles.deviceText}>
              <Text style={styles.device} testID={`${testID}.device`}>
                {device}
              </Text>
              <Text style={styles.complaintLabel}>{tn('repair.condition.complaint')}</Text>
              <Text style={styles.complaint} testID={`${testID}.complaint`}>
                {row.complaint}
              </Text>
            </View>
          </View>
        </Card>

        <ApprovalSection
          rows={approvals}
          describe={describeRepairApproval}
          onOpen={(request) => setStep({ kind: 'approval', requestId: request.id })}
          testID={`${testID}.approvals`}
        />

        <View style={styles.facts}>
          <FactGrid>
            {renderRepairTypes(row)}
            {renderClaimLinks(row)}
            <Fact
              label={tn('repair.ticket.technician')}
              value={row.technicianName ?? tn('repair.ticket.unassigned')}
              action={contextual('assign')}
              testID={`${testID}.technician`}
            />
            {row.estimatedReadyAt === null ? null : (
              <Fact
                label={tn('repair.ticket.readyBy')}
                value={formatDateTime(row.estimatedReadyAt)}
              />
            )}
            {row.deviceImei === null ? null : (
              <Fact label={tn('repair.device.imei')} value={row.deviceImei} />
            )}
            {lock === null ? null : (
              // The technician needs it to test the phone; hidden until asked so it is not read
              // over a shoulder at the counter.
              <Fact
                label={
                  lock.kind === 'unknown'
                    ? tn('repair.device.passcodeLabel')
                    : `${tn('repair.device.passcodeLabel')} · ${tn(LOCK_KIND_KEY[lock.kind])}`
                }
                value={
                  !passcodeShown
                    ? '••••'
                    : lock.kind === 'pattern'
                      ? patternSteps(lock.value)
                      : lock.value
                }
                testID={`${testID}.passcode`}
                wide
                action={
                  <TextButton
                    label={tn(passcodeShown ? 'repair.passcode.hide' : 'repair.passcode.show')}
                    onPress={() => setPasscodeShown((shown) => !shown)}
                    testID={`${testID}.passcode.toggle`}
                  />
                }
              >
                {passcodeShown && lock.kind === 'pattern' ? (
                  <PatternLock
                    value={lock.value}
                    size={168}
                    accessibilityLabel={tn('repair.lock.patternLabel')}
                    testID={`${testID}.passcode.pattern`}
                  />
                ) : null}
              </Fact>
            )}
          </FactGrid>
          {row.outcomeNote === null || row.outcomeNote === '' ? null : (
            <View style={styles.note}>
              <Text style={styles.complaintLabel}>{tn('repair.ticket.lastNote')}</Text>
              <Text style={styles.complaint}>{row.outcomeNote}</Text>
            </View>
          )}
        </View>

        {layout.alternative === null &&
        more.length === 0 &&
        messageKind === null &&
        claimAction === null ? null : (
          <View style={styles.actions}>
            {claimAction === null ? null : (
              <Button
                label={tn('repair.warrantyClaim.action')}
                variant="secondary"
                size="compact"
                onPress={() =>
                  onStartClaim?.(claimIntakeDraft(row, tn('repair.warrantyClaim.line')))
                }
                disabled={runner.busy}
                testID={`${testID}.action.warrantyClaim`}
              />
            )}
            {messageKind === null ? null : (
              <Button
                label={tn(MESSAGE_ACTION_KEY[messageKind])}
                variant="secondary"
                size="compact"
                onPress={() => sendMessage(messageKind, row)}
                disabled={runner.busy}
                testID={`${testID}.action.message`}
              />
            )}
            {layout.alternative === null ? null : (
              <Button
                label={label(layout.alternative)}
                variant="secondary"
                size="compact"
                onPress={() => perform(layout.alternative!, row)}
                disabled={runner.busy}
                testID={`${testID}.action.${layout.alternative}`}
              />
            )}
            {/* One rare move needs no sheet; several wait behind "Lainnya". Same level as the
                alternative, so the two never read as a choice between a button and a link. */}
            {more.length === 0 ? null : more.length === 1 ? (
              <Button
                label={more[0]!.label}
                variant="secondary"
                size="compact"
                onPress={more[0]!.onPress}
                disabled={runner.busy}
                testID={`${testID}.action.${more[0]!.key}`}
              />
            ) : (
              <Button
                label={tn('repair.action.more')}
                variant="secondary"
                size="compact"
                onPress={() => setMoreOpen(true)}
                disabled={runner.busy}
                testID={`${testID}.more.open`}
              />
            )}
          </View>
        )}

        {renderPrice(
          row,
          contextual('changePrice') ?? contextual('proposePrice') ?? contextual('changeCancelFee'),
        )}
        {runtime.inventory === undefined ||
        !runtime.inventory.hasPermission(INVENTORY_PERMISSION.read) ? null : (
          <InventoryRuntimeProvider runtime={runtime.inventory}>
            <UsedPartsSection
              use={partUse(row)}
              editable={canUseParts(row, runtime.userId, runtime.inventory.hasPermission)}
              flagUnreturned={row.outcome === 'cancelled'}
              onTake={() => setStep({ kind: 'takePart' })}
              onPutBack={(part) => setStep({ kind: 'putBackPart', part })}
              testID={`${testID}.parts`}
            />
          </InventoryRuntimeProvider>
        )}
        {photos.section}
        <TicketVideoSection ticket={row} runner={runner} testID={`${testID}.video`} />
        {renderCondition(row)}
        <DeviceSpecs
          brand={row.deviceBrand}
          model={row.deviceModel}
          repairs={can.work}
          testID={`${testID}.specs`}
        />

        <Section title={tn('repair.ticket.history')} testID={`${testID}.history`}>
          <Timeline
            entries={[...row.events].reverse().map(historyEntry)}
            testID={`${testID}.timeline`}
          />
        </Section>

        {[...FINAL_ACTIONS]
          .filter((action) => actions.includes(action))
          .map((action) => (
            <View key={action} style={styles.cancel}>
              {/* Red text, kept apart at the end: final for the repair, or taking a handover back,
                  so it never looks like the next step. The step it opens says what it means. */}
              <TextButton
                label={tn(actionKey(action, row.technicianId))}
                tone="danger"
                onPress={() => perform(action, row)}
                disabled={runner.busy}
                testID={`${testID}.action.${action}`}
              />
            </View>
          ))}
      </View>
    );
  }

  function renderPrice(row: TicketDetailRow, action: ReactNode): React.JSX.Element {
    const pending = row.quoteLines.filter((line) => line.status === 'proposed');
    // A proposal can only be decided while the ticket is open; on a closed one it is history.
    const deciding = actions.includes('decidePrice');
    // The bottom action already opens the first proposal; per-line buttons only when there are more.
    const perLine = deciding && pending.length > 1;
    const cancelled = row.outcome === 'cancelled';
    const paymentAction = downPaymentAction(row, can);
    const moneyActions = ticketMoneyActions(row, runtime.hasPermission);
    return (
      <Section title={tn('repair.ticket.price')} action={action} testID={`${testID}.price`}>
        {row.quoteLines.map((line) => {
          const counted = line.status === 'intake' || line.status === 'applied';
          return (
            <View key={line.id} style={styles.line} testID={`${testID}.line.${line.id}`}>
              <View style={[repairStyles.row, styles.lineRow]}>
                <View style={repairStyles.rowText}>
                  <Text style={counted ? styles.lineText : styles.lineMuted}>
                    {line.description}
                  </Text>
                  <Text style={styles.lineKind}>{tn(PRICE_KIND_KEY[line.kind])}</Text>
                </View>
                <Text style={[counted ? styles.lineText : styles.lineMuted, styles.amount]}>
                  {formatMoney(line.amount)}
                </Text>
              </View>
              {line.status === 'intake' ? null : (
                <Text
                  style={line.status === 'proposed' ? styles.lineWarning : styles.lineKind}
                  testID={`${testID}.line.${line.id}.status`}
                >
                  {lineCaption(line)}
                </Text>
              )}
              {line.status === 'proposed' && perLine ? (
                <View style={styles.lineAction}>
                  <TextButton
                    label={tn('repair.action.decidePrice')}
                    onPress={() => setStep({ kind: 'proposal', lineId: line.id, line })}
                    disabled={runner.busy}
                    testID={`${testID}.decide.${line.id}`}
                  />
                </View>
              ) : null}
            </View>
          );
        })}
        <View style={[repairStyles.row, styles.total]}>
          <Text style={[cancelled ? styles.notCharged : styles.totalLabel, repairStyles.rowText]}>
            {tn('repair.price.total')}
          </Text>
          <RollingText
            value={row.quoteTotal}
            style={[
              cancelled ? styles.notCharged : styles.totalValue,
              styles.amount,
              repairStyles.rowValue,
            ]}
            testID={`${testID}.total`}
          >
            {formatMoney(row.quoteTotal)}
          </RollingText>
        </View>
        {cancelled ? (
          // The repair price stays as quiet history; the number that leads is what the customer
          // owes, the same fee the board and the handover show (Rp 0 when none was set).
          <>
            <View style={[repairStyles.row, styles.owed]}>
              <Text style={[styles.totalLabel, repairStyles.rowText]}>
                {tn('repair.cancel.fee')}
              </Text>
              <Text
                style={[styles.totalValue, styles.amount, repairStyles.rowValue]}
                testID={`${testID}.cancelFee`}
              >
                {formatMoney(row.cancelFee ?? 0)}
              </Text>
            </View>
            <Text style={repairStyles.caption} testID={`${testID}.notCharged`}>
              {tn('repair.price.notCharged')}
            </Text>
          </>
        ) : null}
        {!deciding || pending.length === 0 ? null : (
          // The total is what the customer agreed to; what a decision would add is said, not summed.
          <Text style={styles.lineWarning} testID={`${testID}.pendingTotal`}>
            {tn('repair.price.pendingTotal', {
              amount: formatMoney(pending.reduce((sum, line) => sum + line.amount, 0)),
            })}
          </Text>
        )}
        <DownPaymentRows
          total={amountOwed(row)}
          reduced={row.reduced}
          downPayment={row.downPayment}
          paidLabel={paidLabelKey(row)}
          returned={row.location === 'returned'}
          action={
            paymentAction === 'correct' ? (
              <TextButton
                label={tn('repair.downPayment.change')}
                accessibilityLabel={tn(downPaymentTitleKey('correct', can.correctDownPayment))}
                onPress={() => setStep({ kind: 'downPayment', mode: 'correct' })}
                disabled={runner.busy}
                testID={`${testID}.downPayment.correct`}
              />
            ) : undefined
          }
          testID={testID}
        />
        {paymentAction === 'record' ? (
          <View style={styles.lineAction}>
            <TextButton
              label={tn('repair.downPayment.recordTitle')}
              icon="add"
              onPress={() => setStep({ kind: 'downPayment', mode: 'record' })}
              disabled={runner.busy}
              testID={`${testID}.downPayment.record`}
            />
          </View>
        ) : null}
        {moneyActions.refund || moneyActions.reduce ? (
          <View style={styles.moneyActions}>
            {moneyActions.refund ? (
              <TextButton
                label={tm('money.refund.title')}
                onPress={() => setStep({ kind: 'refund' })}
                disabled={runner.busy}
                testID={`${testID}.refund`}
              />
            ) : null}
            {moneyActions.reduce ? (
              <TextButton
                label={tm('money.reduce.action')}
                onPress={() => setStep({ kind: 'reduce' })}
                disabled={runner.busy}
                testID={`${testID}.reduce`}
              />
            ) : null}
          </View>
        ) : null}
      </Section>
    );
  }

  /**
   * What is being repaired, changed from here once the diagnosis shows it, and each type's
   * warranty: how long while the phone is in the store, until when once it went home.
   */
  function renderRepairTypes(row: TicketDetailRow): React.JSX.Element | null {
    const editable = canSetRepairTypes(row, can);
    if (row.repairTypes.length === 0 && !editable) return null;
    return (
      <Fact
        label={tn('repair.repairTypes.title')}
        value={
          row.repairTypes.length === 0
            ? tn('repair.repairTypes.none')
            : row.repairTypes.map((type) => warrantyLine(type, row.returnedAt)).join('\n')
        }
        wide
        action={
          editable ? (
            <TextButton
              label={tn(
                row.repairTypes.length === 0
                  ? 'repair.repairTypes.choose'
                  : 'repair.repairTypes.change',
              )}
              accessibilityLabel={tn('repair.repairTypes.title')}
              onPress={() => {
                setDone(null);
                setStep({ kind: 'repairTypes' });
              }}
              disabled={runner.busy}
              testID={`${testID}.action.repairTypes`}
            />
          ) : null
        }
        testID={`${testID}.repairTypes`}
      />
    );
  }

  /**
   * The servisan a claim is on, with the warranty the claim runs under, or the claims on this one,
   * each a tap away.
   */
  function renderClaimLinks(row: TicketDetailRow): ReactNode {
    const { claimOf } = row;
    const links = [
      ...(claimOf === null
        ? []
        : [
            {
              id: claimOf.id,
              value: [
                claimOf.ticketNumber,
                ...claimOf.repairTypes.map((type) => warrantyLine(type, claimOf.returnedAt)),
              ].join('\n'),
              number: claimOf.ticketNumber,
              key: 'of' as const,
            },
          ]),
      ...row.claims.map((claim) => ({
        id: claim.id,
        value: claim.ticketNumber,
        number: claim.ticketNumber,
        key: 'claims' as const,
      })),
    ];
    return links.map((link) => (
      <Fact
        key={link.id}
        label={tn(`repair.warrantyClaim.${link.key}`)}
        value={link.value}
        wide
        action={
          onOpenTicket === undefined ? null : (
            <TextButton
              label={tn('repair.warrantyClaim.open')}
              accessibilityLabel={`${tn(`repair.warrantyClaim.${link.key}`)} ${link.number}`}
              onPress={() => onOpenTicket(link.id)}
              testID={`${testID}.claimLink.${link.id}`}
            />
          )
        }
        testID={`${testID}.claimLink`}
      />
    ));
  }

  function renderCondition(row: TicketDetailRow): React.JSX.Element | null {
    const issues = row.checklist.filter((check) => check.state === 'issue');
    if (issues.length === 0 && row.peripherals.length === 0 && row.intakeNotes === '') return null;
    return (
      <Section title={tn('repair.intake.step.condition')} testID={`${testID}.condition`}>
        {issues.length === 0 ? null : (
          <View style={styles.chipGroup}>
            <Text style={styles.complaintLabel}>{tn('repair.condition.issues')}</Text>
            <View style={styles.chips}>
              {issues.map((check) => (
                <Chip
                  key={check.item}
                  label={optionLabel('checks', { id: check.item, label: check.label })}
                  icon="warning"
                  tone="warning"
                />
              ))}
            </View>
          </View>
        )}
        {row.peripherals.length === 0 ? null : (
          <View style={styles.chipGroup}>
            <Text style={styles.complaintLabel}>{tn('repair.condition.peripherals')}</Text>
            <View style={styles.chips}>
              {row.peripherals.map(({ item, label }) => (
                <Chip
                  key={item}
                  label={optionLabel('accessories', { id: item, label })}
                  icon="check"
                />
              ))}
            </View>
          </View>
        )}
        {row.intakeNotes === '' ? null : (
          <View style={styles.chipGroup}>
            <Text style={styles.complaintLabel}>{tn('repair.condition.notesLabel')}</Text>
            <Text style={styles.complaint}>{row.intakeNotes}</Text>
          </View>
        )}
      </Section>
    );
  }
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
 * Every photo on the ticket in the order it was taken: at intake (the angles the ticket asked for,
 * named as they were then), before, after, at handover.
 */
function ticketPhotos(row: TicketDetailRow): BrowsablePhoto[] {
  const intake = row.intakePhotos.flatMap(({ slot, label }) => {
    const photo = photoInSlot(row, slot);
    return photo === null
      ? []
      : [
          {
            key: slot,
            label: optionLabel('photoAngles', { id: slot, label }),
            group: tn('repair.photo.intake'),
            photo,
          },
        ];
  });
  const work = (['before', 'after'] as const).flatMap((stage) =>
    workPhotos(row, stage).map((photo, index) => ({
      key: photo.slot,
      label: tn(stage === 'before' ? 'repair.photo.beforeN' : 'repair.photo.afterN', {
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
            label: tn(slot === 'signature' ? 'repair.handover.signature' : 'repair.photo.handover'),
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

const styles = StyleSheet.create({
  customerRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: space.sm,
    marginTop: space.md,
  },
  customer: { ...type.title, color: color.text, flexShrink: 1 },
  phone: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    minHeight: touch.min,
  },
  link: { ...type.bodySm, fontWeight: '600', color: color.primary },
  deviceBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    columnGap: space.md,
    marginTop: space.sm,
    padding: space.md,
    borderRadius: radius.sm,
    backgroundColor: color.surfaceAlt,
  },
  deviceText: { flex: 1 },
  device: { ...type.bodyBold, color: color.text },
  complaintLabel: { ...type.caption, color: color.textMuted, marginTop: space.sm },
  complaint: { ...type.bodySm, color: color.text },
  facts: { marginTop: space.lg },
  note: { marginTop: space.xs },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md, marginTop: space.lg },
  statusRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.sm },
  cancel: { marginTop: space['2xl'], alignItems: 'center' },
  line: { paddingVertical: space.sm },
  lineRow: { alignItems: 'flex-start' },
  lineText: { ...type.bodySm, color: color.text },
  lineMuted: { ...type.bodySm, color: color.textMuted },
  lineKind: { ...type.caption, color: color.textMuted },
  lineWarning: { ...type.caption, color: color.warning },
  lineAction: { alignItems: 'flex-start', marginLeft: -space.sm },
  moneyActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: space.md,
    marginLeft: -space.sm,
    marginTop: space.xs,
  },
  total: {
    marginTop: space.sm,
    paddingTop: space.md,
    borderTopWidth: border.hairline,
    borderTopColor: color.border,
  },
  totalLabel: { ...type.bodyBold, color: color.text },
  totalValue: { ...type.heading, color: color.text },
  amount: { fontVariant: ['tabular-nums'] },
  notCharged: { ...type.bodySm, color: color.textMuted, textDecorationLine: 'line-through' },
  owed: { marginTop: space.sm },
  chipGroup: { marginBottom: space.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.xs },
});
