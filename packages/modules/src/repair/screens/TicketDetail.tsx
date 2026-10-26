/**
 * TicketDetail — one repair: who and what, where it stands, the price with its changes, every
 * photo, the history, and the next steps this user may take. Each step that needs input opens its
 * own full-screen step (TicketSteps.tsx); the rest run in place. The rejected-op banner shows here,
 * where the change was made (05-operation-log §8).
 */
import { formatDateTime, formatMoney, t, translateOpType } from '@bolusi/i18n';
import {
  AppShell,
  Banner,
  Button,
  Card,
  Chip,
  Icon,
  TextButton,
  Timeline,
  border,
  color,
  radius,
  size,
  space,
  touch,
  type,
} from '@bolusi/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { HANDOVER_PHOTO_SLOTS, INTAKE_PHOTO_SLOTS } from '../constants.js';
import type { QuoteLineRow, TicketDetailRow } from '../queries.js';
import {
  hasRejectedOp,
  useActionRunner,
  type DiscardGuard,
  type EntitySyncStatuses,
  type StepBack,
} from '../../screen-kit/index.js';

import { tn, type RepairKey } from './i18n.js';
import { INTAKE_SLOT_KEY, PRICE_KIND_KEY, checkLabel, peripheralLabel } from './labels.js';
import {
  photoInSlot,
  photoThumbnailRef,
  repairAbilities,
  ticketActions,
  ticketStatus,
  workPhotos,
  type TicketAction,
} from '../flows.js';
import {
  ActionErrorBanner,
  Fact,
  FactGrid,
  QueryView,
  Section,
  StatusChip,
  repairStyles,
  type RepairChrome,
} from './parts.js';
import { usePhotoBrowser, type BrowsablePhoto } from './photos.js';
import { useRepairQuery, useRepairRuntime } from './runtime.js';
import {
  AssignStep,
  NoteStep,
  PriceChangeStep,
  ProposalStep,
  WorkPhotosStep,
} from './TicketSteps.js';

/** What an action that runs in place says once it lands, in the fixed banner slot. */
const DONE_KEY: Partial<Record<TicketAction, RepairKey>> = {
  claim: 'repair.done.claim',
  start: 'repair.done.start',
  resume: 'repair.done.start',
  reopen: 'repair.done.start',
};

const ACTION_KEY: Readonly<Record<TicketAction, RepairKey>> = {
  decidePrice: 'repair.action.decidePrice',
  claim: 'repair.action.claim',
  start: 'repair.action.start',
  resume: 'repair.action.resume',
  reopen: 'repair.action.reopen',
  waitForParts: 'repair.action.waitForParts',
  markRepaired: 'repair.action.markRepaired',
  assign: 'repair.action.assign',
  changePrice: 'repair.action.changePrice',
  proposePrice: 'repair.action.proposePrice',
  handover: 'repair.action.handover',
  cancel: 'repair.action.cancel',
};

type Step =
  | { readonly kind: 'none' }
  | { readonly kind: 'before' }
  | { readonly kind: 'after' }
  | { readonly kind: 'waitForParts' }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'assign' }
  | { readonly kind: 'changePrice' }
  | { readonly kind: 'proposePrice' }
  | { readonly kind: 'proposal'; readonly line: QuoteLineRow };

export interface TicketDetailProps {
  readonly ticketId: string;
  readonly chrome: RepairChrome;
  readonly onBack: () => void;
  readonly onHandover: (ticketId: string) => void;
  readonly onOpenSyncStatus: () => void;
  /** Hardware back closes an open step back to the ticket before it leaves the ticket. */
  readonly onRegisterStepBack?: ((back: StepBack | null) => void) | undefined;
  /** Leaving the surface (header sync chip, lock) asks the open step first, like back does. */
  readonly onRegisterDiscardGuard?: ((guard: DiscardGuard | null) => void) | undefined;
  readonly testID?: string | undefined;
}

interface LoadedTicket {
  readonly ticket: TicketDetailRow | undefined;
  readonly statuses: EntitySyncStatuses;
}

export function TicketDetail({
  ticketId,
  chrome,
  onBack,
  onHandover,
  onOpenSyncStatus,
  onRegisterStepBack,
  onRegisterDiscardGuard,
  testID = 'repair.ticket',
}: TicketDetailProps): React.JSX.Element {
  const runtime = useRepairRuntime();
  const can = useMemo(() => repairAbilities(runtime.hasPermission), [runtime]);
  const runner = useActionRunner();
  const [step, setStep] = useState<Step>({ kind: 'none' });
  const [reloadNonce, setReloadNonce] = useState(0);
  const [done, setDone] = useState<RepairKey | null>(null);
  const [passcodeShown, setPasscodeShown] = useState(false);
  // An open step holding photos asks before it is dropped (header back, hardware back).
  const stepGuardRef = useRef<DiscardGuard | null>(null);
  const registerStepGuard = useCallback((guard: DiscardGuard | null): void => {
    stepGuardRef.current = guard;
  }, []);

  const query = useRepairQuery<LoadedTicket>(
    async (rt) => {
      const page = await rt.query('getTicket', { ticketId });
      return { ticket: page.rows[0], statuses: await rt.ticketSyncStatuses([ticketId]) };
    },
    `ticket:${ticketId}:${String(reloadNonce)}`,
  );

  const ticket = query.status === 'ready' ? query.data.ticket : undefined;
  const photos = usePhotoBrowser(
    useMemo(() => (ticket === undefined ? [] : ticketPhotos(ticket)), [ticket]),
    `${testID}.photos`,
  );
  const photosBack = useRef(photos.back);
  photosBack.current = photos.back;
  const rejected = query.status === 'ready' && hasRejectedOp(query.data.statuses[ticketId] ?? []);
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

  const stepProps = {
    chrome,
    ticketId,
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
            setDone(step.kind === 'before' ? 'repair.done.start' : 'repair.done.repaired');
          }}
        />
      );
    case 'waitForParts':
    case 'cancel':
      return <NoteStep {...stepProps} kind={step.kind} />;
    case 'assign':
      return <AssignStep {...stepProps} currentTechnicianId={ticket?.technicianId ?? null} />;
    case 'changePrice':
      return <PriceChangeStep {...stepProps} mode="change" />;
    case 'proposePrice':
      return <PriceChangeStep {...stepProps} mode="propose" />;
    case 'proposal':
      return <ProposalStep {...stepProps} line={step.line} />;
    case 'none':
      break;
  }

  const runInPlace = (action: TicketAction, run: () => Promise<unknown>): void => {
    setDone(null);
    void runner.run(run).then((result) => {
      if (result !== undefined) setDone(DONE_KEY[action] ?? null);
    });
  };

  const perform = (action: TicketAction, row: TicketDetailRow): void => {
    switch (action) {
      case 'decidePrice': {
        const line = row.quoteLines.find((candidate) => candidate.status === 'proposed');
        if (line !== undefined) setStep({ kind: 'proposal', line });
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
      case 'waitForParts':
      case 'cancel':
      case 'assign':
      case 'changePrice':
      case 'proposePrice':
        setStep({ kind: action });
        return;
    }
  };

  // The likeliest next step is the bottom action, in the thumb zone like every other flow; the
  // rest sit under the summary, and cancelling is kept apart at the end so it is never hit by habit.
  const actions = ticket === undefined ? [] : ticketActions(ticket, can, runtime.userId);
  const [primary, ...others] = actions.filter((action) => action !== 'cancel');
  const canCancel = actions.includes('cancel');
  const label = (action: TicketAction): string =>
    tn(
      action === 'assign' && ticket?.technicianId != null
        ? 'repair.action.reassign'
        : ACTION_KEY[action],
    );

  // One banner at a time, in the fixed slot so it shows wherever the user has scrolled: a refusal of
  // what they just did, then a rejected op from sync, then what their last action did.
  const banner =
    runner.errorCode !== null ? (
      <ActionErrorBanner
        errorCode={runner.errorCode}
        onDismiss={runner.clearError}
        testID={`${testID}.actionError`}
      />
    ) : rejected ? (
      <Banner
        variant="danger"
        message={t('sync.rejected.banner', { count: 1 })}
        onPress={onOpenSyncStatus}
        testID={`${testID}.rejectedBanner`}
      />
    ) : done !== null ? (
      <Banner
        variant="info"
        message={tn(done)}
        onPress={() => setDone(null)}
        testID={`${testID}.done`}
      />
    ) : undefined;

  return (
    <AppShell
      scrollable
      title={ticket?.ticketNumber ?? tn('repair.ticket.title')}
      titleVariant="detail"
      onBack={onBack}
      backLabel={t('core.action.back')}
      syncChip={chrome.syncChip}
      avatar={chrome.avatar}
      banner={banner}
      overlay={photos.overlay}
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
        {(data) => (data.ticket === undefined ? null : renderTicket(data.ticket))}
      </QueryView>
    </AppShell>
  );

  function renderTicket(row: TicketDetailRow): React.JSX.Element {
    const device = [row.deviceBrand, row.deviceModel, row.deviceColor]
      .filter((s) => s !== '')
      .join(' · ');
    // An action that changes one fact sits beside that fact; the bottom action is never repeated.
    // Beside the technician's name the verb alone says it: "Pilih" or "Ganti".
    const shortAssignKey: RepairKey =
      row.technicianId === null ? 'repair.action.assignShort' : 'repair.action.reassignShort';
    const contextual = (action: TicketAction): ReactNode =>
      others.some((candidate) => candidate === action) ? (
        <TextButton
          label={action === 'assign' ? tn(shortAssignKey) : label(action)}
          accessibilityLabel={label(action)}
          onPress={() => perform(action, row)}
          disabled={runner.busy}
          testID={`${testID}.action.${action}`}
        />
      ) : null;
    const statusActions = others.filter((action) => !CONTEXTUAL_ACTIONS.has(action));
    return (
      <View testID={`${testID}.content`}>
        <Card testID={`${testID}.summary`}>
          <StatusChip status={ticketStatus(row)} testID={`${testID}.status`} />
          <Text style={styles.customer} testID={`${testID}.customer`}>
            {row.customerName}
          </Text>
          {row.customerPhone === null ? null : (
            // Tap to call: the counter rings the customer when the phone is ready or a price changes.
            <Pressable
              accessibilityRole="link"
              onPress={() => void Linking.openURL(`tel:${row.customerPhone ?? ''}`)}
              style={styles.phone}
              testID={`${testID}.phone`}
            >
              <Icon name="phone" size={size.iconChip} color={color.primary} />
              <Text style={styles.link}>{row.customerPhone}</Text>
            </Pressable>
          )}
          <View style={styles.deviceBox}>
            <Text style={styles.device} testID={`${testID}.device`}>
              {device}
            </Text>
            <Text style={styles.complaintLabel}>{tn('repair.condition.complaint')}</Text>
            <Text style={styles.complaint} testID={`${testID}.complaint`}>
              {row.complaint}
            </Text>
          </View>
        </Card>

        <View style={styles.facts}>
          <FactGrid>
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
            {row.devicePasscode === null ? null : (
              // The technician needs it to test the phone; hidden until asked so it is not read
              // over a shoulder at the counter.
              <Fact
                label={tn('repair.device.passcodeLabel')}
                value={passcodeShown ? row.devicePasscode : '••••'}
                testID={`${testID}.passcode`}
                action={
                  <TextButton
                    label={tn(passcodeShown ? 'repair.passcode.hide' : 'repair.passcode.show')}
                    onPress={() => setPasscodeShown((shown) => !shown)}
                    testID={`${testID}.passcode.toggle`}
                  />
                }
              />
            )}
          </FactGrid>
          {row.outcomeNote === null || row.outcomeNote === '' ? null : (
            <View style={styles.note}>
              <Text style={styles.complaintLabel}>{tn('repair.ticket.lastNote')}</Text>
              <Text style={styles.complaint}>{row.outcomeNote}</Text>
            </View>
          )}
        </View>

        {statusActions.length === 0 ? null : (
          <View style={styles.actions}>
            {statusActions.map((action) => (
              <Button
                key={action}
                label={label(action)}
                variant="secondary"
                size="compact"
                onPress={() => perform(action, row)}
                disabled={runner.busy}
                testID={`${testID}.action.${action}`}
              />
            ))}
          </View>
        )}

        {renderPrice(row, contextual('changePrice') ?? contextual('proposePrice'))}
        {photos.section}
        {renderCondition(row)}

        <Section title={tn('repair.ticket.history')} testID={`${testID}.history`}>
          <Timeline
            entries={[...row.events].reverse().map((event) => {
              const note = eventNote(event.detail);
              return {
                key: event.id,
                title: translateOpType(event.kind),
                meta: [formatDateTime(event.at), event.actorName]
                  .filter((part) => part !== null)
                  .join(' · '),
                ...(note === null ? {} : { detail: note }),
              };
            })}
            testID={`${testID}.timeline`}
          />
        </Section>

        {canCancel ? (
          <View style={styles.cancel}>
            {/* Red text, kept apart at the end: it is final for the repair, so it never looks like
                the next step. The step it opens says what cancelling means. */}
            <TextButton
              label={tn(ACTION_KEY.cancel)}
              tone="danger"
              onPress={() => perform('cancel', row)}
              disabled={runner.busy}
              testID={`${testID}.action.cancel`}
            />
          </View>
        ) : null}
      </View>
    );
  }

  function renderPrice(row: TicketDetailRow, action: ReactNode): React.JSX.Element {
    const pending = row.quoteLines.filter((line) => line.status === 'proposed');
    // A proposal can only be decided while the ticket is open; on a closed one it is history.
    const deciding = actions.includes('decidePrice');
    // The bottom action already opens the first proposal; per-line buttons only when there are more.
    const perLine = deciding && pending.length > 1;
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
                    onPress={() => setStep({ kind: 'proposal', line })}
                    disabled={runner.busy}
                    testID={`${testID}.decide.${line.id}`}
                  />
                </View>
              ) : null}
            </View>
          );
        })}
        <View style={[repairStyles.row, styles.total]}>
          <Text style={styles.totalLabel}>{tn('repair.price.total')}</Text>
          <Text style={[styles.totalValue, styles.amount]} testID={`${testID}.total`}>
            {formatMoney(row.quoteTotal)}
          </Text>
        </View>
        {!deciding || pending.length === 0 ? null : (
          // The total is what the customer agreed to; what a decision would add is said, not summed.
          <Text style={styles.lineWarning} testID={`${testID}.pendingTotal`}>
            {tn('repair.price.pendingTotal', {
              amount: formatMoney(pending.reduce((sum, line) => sum + line.amount, 0)),
            })}
          </Text>
        )}
      </Section>
    );
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
                  label={checkLabel(check.item)}
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
              {row.peripherals.map((item) => (
                <Chip key={item} label={peripheralLabel(item)} icon="check" />
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

/** Every photo on the ticket in the order it was taken: at intake, before, after, at handover. */
function ticketPhotos(row: TicketDetailRow): BrowsablePhoto[] {
  const intake = INTAKE_PHOTO_SLOTS.flatMap((slot) => {
    const photo = photoInSlot(row, slot);
    return photo === null
      ? []
      : [{ key: slot, label: tn(INTAKE_SLOT_KEY[slot]), group: tn('repair.photo.intake'), photo }];
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

/** Actions shown beside the fact they change rather than in the row of status actions. */
const CONTEXTUAL_ACTIONS: ReadonlySet<TicketAction> = new Set([
  'assign',
  'changePrice',
  'proposePrice',
]);

/** The note or reason a person typed with an event (a cancel reason, a parts note), if any. */
function eventNote(detail: Readonly<Record<string, unknown>>): string | null {
  for (const field of ['note', 'reason'] as const) {
    const value = detail[field];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

const styles = StyleSheet.create({
  customer: { ...type.title, color: color.text, marginTop: space.md },
  phone: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    minHeight: touch.min,
  },
  link: { ...type.bodySm, fontWeight: '600', color: color.primary },
  deviceBox: {
    marginTop: space.sm,
    padding: space.md,
    borderRadius: radius.sm,
    backgroundColor: color.surfaceAlt,
  },
  device: { ...type.bodyBold, color: color.text },
  complaintLabel: { ...type.caption, color: color.textMuted, marginTop: space.sm },
  complaint: { ...type.bodySm, color: color.text },
  facts: { marginTop: space.lg },
  note: { marginTop: space.xs },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md, marginTop: space.lg },
  cancel: { marginTop: space['2xl'], alignItems: 'center' },
  line: { paddingVertical: space.sm },
  lineRow: { alignItems: 'flex-start' },
  lineText: { ...type.bodySm, color: color.text },
  lineMuted: { ...type.bodySm, color: color.textMuted },
  lineKind: { ...type.caption, color: color.textMuted },
  lineWarning: { ...type.caption, color: color.warning },
  lineAction: { alignItems: 'flex-start', marginLeft: -space.sm },
  total: {
    marginTop: space.sm,
    paddingTop: space.md,
    borderTopWidth: border.hairline,
    borderTopColor: color.border,
  },
  totalLabel: { ...type.bodyBold, color: color.text },
  totalValue: { ...type.heading, color: color.text },
  amount: { fontVariant: ['tabular-nums'] },
  chipGroup: { marginBottom: space.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.xs },
});
