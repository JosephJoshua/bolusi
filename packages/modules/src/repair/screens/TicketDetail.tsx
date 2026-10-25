/**
 * TicketDetail — one repair: who and what, where it stands, the price with its changes, every
 * photo, the history, and the next steps this user may take. Each step that needs input opens its
 * own full-screen step (TicketSteps.tsx); the rest run in place. The rejected-op banner shows here,
 * where the change was made (05-operation-log §8).
 */
import { formatDateTime, formatMoney, t, translateOpType } from '@bolusi/i18n';
import { AppShell, Banner, Button, Card, PhotoSlot, color, space, touch, type } from '@bolusi/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  Field,
  PhotoGrid,
  PhotoThumb,
  QueryView,
  Section,
  StatusChip,
  repairStyles,
  type RepairChrome,
} from './parts.js';
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
      if (!stepOpen) return false;
      leaveStep();
      return true;
    });
    return () => onRegisterStepBack?.(null);
  }, [stepOpen, onRegisterStepBack, leaveStep]);

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
    return (
      <View testID={`${testID}.content`}>
        <Card testID={`${testID}.summary`}>
          <View style={repairStyles.row}>
            <Text style={repairStyles.heading} testID={`${testID}.customer`}>
              {row.customerName}
            </Text>
            <StatusChip status={ticketStatus(row)} testID={`${testID}.status`} />
          </View>
          {row.customerPhone === null ? null : (
            // Tap to call: the counter rings the customer when the phone is ready or a price changes.
            <Pressable
              accessibilityRole="link"
              onPress={() => void Linking.openURL(`tel:${row.customerPhone ?? ''}`)}
              style={styles.phone}
              testID={`${testID}.phone`}
            >
              <Text style={styles.phoneText}>{row.customerPhone}</Text>
            </Pressable>
          )}
          <Text style={[repairStyles.body, styles.device]} testID={`${testID}.device`}>
            {[row.deviceBrand, row.deviceModel, row.deviceColor].filter((s) => s !== '').join(' ')}
          </Text>
          <Text style={repairStyles.body} testID={`${testID}.complaint`}>
            {row.complaint}
          </Text>
          <Field
            label={tn('repair.ticket.technician')}
            value={row.technicianName ?? tn('repair.ticket.unassigned')}
            testID={`${testID}.technician`}
          />
          {row.estimatedReadyAt === null ? null : (
            <Field
              label={tn('repair.ticket.readyBy')}
              value={formatDateTime(row.estimatedReadyAt)}
            />
          )}
          {row.deviceImei === null ? null : (
            <Field label={tn('repair.device.imei')} value={row.deviceImei} />
          )}
          {row.devicePasscode === null ? null : (
            // The technician needs it to test the phone; hidden until asked so it is not read over
            // a shoulder at the counter.
            <View style={styles.passcode}>
              <View style={styles.passcodeField}>
                <Field
                  label={tn('repair.device.passcode')}
                  value={passcodeShown ? row.devicePasscode : '••••'}
                  testID={`${testID}.passcode`}
                />
              </View>
              <Pressable
                accessibilityRole="button"
                onPress={() => setPasscodeShown((shown) => !shown)}
                style={styles.reveal}
                testID={`${testID}.passcode.toggle`}
              >
                <Text style={styles.phoneText}>
                  {tn(passcodeShown ? 'repair.passcode.hide' : 'repair.passcode.show')}
                </Text>
              </Pressable>
            </View>
          )}
          {row.outcomeNote === null || row.outcomeNote === '' ? null : (
            <Field label={tn('repair.ticket.lastNote')} value={row.outcomeNote} />
          )}
        </Card>

        {others.length === 0 ? null : (
          <View style={styles.actions}>
            {others.map((action) => (
              <View key={action} style={styles.secondaryAction}>
                <Button
                  label={label(action)}
                  variant="secondary"
                  onPress={() => perform(action, row)}
                  disabled={runner.busy}
                  testID={`${testID}.action.${action}`}
                />
              </View>
            ))}
          </View>
        )}

        {renderPrice(row)}
        {renderPhotos(row)}
        {renderCondition(row)}

        <Section title={tn('repair.ticket.history')} testID={`${testID}.history`}>
          {[...row.events].reverse().map((event) => (
            <Text key={event.id} style={styles.event}>
              {`${formatDateTime(event.at)} · ${translateOpType(event.kind)}`}
              {event.actorName === null ? '' : ` · ${event.actorName}`}
            </Text>
          ))}
        </Section>

        {canCancel ? (
          <View style={styles.cancel}>
            {/* Outlined, not solid red: it is final for the repair, so it never looks like the
                next step. The step it opens says what cancelling means. */}
            <Button
              label={tn(ACTION_KEY.cancel)}
              variant="secondary"
              onPress={() => perform('cancel', row)}
              disabled={runner.busy}
              testID={`${testID}.action.cancel`}
            />
          </View>
        ) : null}
      </View>
    );
  }

  function renderPrice(row: TicketDetailRow): React.JSX.Element {
    const pending = row.quoteLines.filter((line) => line.status === 'proposed');
    // A proposal can only be decided while the ticket is open; on a closed one it is history.
    const deciding = actions.includes('decidePrice');
    // The bottom action already opens the first proposal; per-line buttons only when there are more.
    const perLine = deciding && pending.length > 1;
    return (
      <Section title={tn('repair.ticket.price')} testID={`${testID}.price`}>
        {row.quoteLines.map((line) => (
          <View key={line.id} style={styles.line} testID={`${testID}.line.${line.id}`}>
            <View style={repairStyles.row}>
              <Text
                style={[
                  line.status === 'intake' || line.status === 'applied'
                    ? repairStyles.body
                    : repairStyles.muted,
                  repairStyles.rowText,
                ]}
              >{`${tn(PRICE_KIND_KEY[line.kind])} · ${line.description}`}</Text>
              <Text
                style={
                  line.status === 'intake' || line.status === 'applied'
                    ? repairStyles.body
                    : repairStyles.muted
                }
              >
                {formatMoney(line.amount)}
              </Text>
            </View>
            {line.status === 'intake' ? null : (
              <Text
                style={line.status === 'proposed' ? repairStyles.warning : repairStyles.caption}
                testID={`${testID}.line.${line.id}.status`}
              >
                {lineCaption(line)}
              </Text>
            )}
            {line.status === 'proposed' && perLine ? (
              <View style={styles.secondaryAction}>
                <Button
                  label={tn('repair.action.decidePrice')}
                  variant="secondary"
                  onPress={() => setStep({ kind: 'proposal', line })}
                  disabled={runner.busy}
                  testID={`${testID}.decide.${line.id}`}
                />
              </View>
            ) : null}
          </View>
        ))}
        <View style={[repairStyles.row, styles.total]}>
          <Text style={repairStyles.heading}>{tn('repair.price.total')}</Text>
          <Text style={repairStyles.heading} testID={`${testID}.total`}>
            {formatMoney(row.quoteTotal)}
          </Text>
        </View>
        {!deciding || pending.length === 0 ? null : (
          // The total is what the customer agreed to; what a decision would add is said, not summed.
          <Text style={repairStyles.warning} testID={`${testID}.pendingTotal`}>
            {tn('repair.price.pendingTotal', {
              amount: formatMoney(pending.reduce((sum, line) => sum + line.amount, 0)),
            })}
          </Text>
        )}
      </Section>
    );
  }

  function renderPhotos(row: TicketDetailRow): React.JSX.Element {
    const before = workPhotos(row, 'before');
    const after = workPhotos(row, 'after');
    const handover = HANDOVER_PHOTO_SLOTS.flatMap((slot) => {
      const photo = photoInSlot(row, slot);
      return photo === null ? [] : [{ slot, photo }];
    });
    return (
      <>
        <Section title={tn('repair.photo.intake')} testID={`${testID}.intakePhotos`}>
          <PhotoGrid>
            {INTAKE_PHOTO_SLOTS.map((slot) => {
              const photo = photoInSlot(row, slot);
              return (
                <View key={slot} style={repairStyles.gridCell}>
                  <PhotoSlot
                    label={tn(INTAKE_SLOT_KEY[slot])}
                    actionLabel={tn(INTAKE_SLOT_KEY[slot])}
                    image={
                      photo === null ? null : (
                        <PhotoThumb
                          photo={photoThumbnailRef(photo)}
                          testID={`${testID}.photo.${slot}`}
                        />
                      )
                    }
                  />
                </View>
              );
            })}
          </PhotoGrid>
        </Section>
        {[
          { key: 'before', title: tn('repair.photo.before'), photos: before },
          { key: 'after', title: tn('repair.photo.after'), photos: after },
        ].map((group) =>
          group.photos.length === 0 ? null : (
            <Section key={group.key} title={group.title} testID={`${testID}.${group.key}Photos`}>
              <PhotoGrid>
                {group.photos.map((photo) => (
                  <View key={photo.slot} style={repairStyles.gridCell}>
                    <PhotoThumb
                      photo={photoThumbnailRef(photo)}
                      testID={`${testID}.photo.${photo.slot}`}
                    />
                  </View>
                ))}
              </PhotoGrid>
            </Section>
          ),
        )}
        {handover.length === 0 ? null : (
          <Section title={tn('repair.photo.handover')} testID={`${testID}.handoverPhotos`}>
            <PhotoGrid>
              {handover.map(({ slot, photo }) => (
                <View key={slot} style={repairStyles.gridCell}>
                  <PhotoThumb photo={photoThumbnailRef(photo)} testID={`${testID}.photo.${slot}`} />
                </View>
              ))}
            </PhotoGrid>
          </Section>
        )}
      </>
    );
  }

  function renderCondition(row: TicketDetailRow): React.JSX.Element | null {
    const issues = row.checklist.filter((check) => check.state === 'issue');
    if (issues.length === 0 && row.peripherals.length === 0 && row.intakeNotes === '') return null;
    return (
      <Section title={tn('repair.intake.step.condition')} testID={`${testID}.condition`}>
        {issues.length === 0 ? null : (
          <Field
            label={tn('repair.condition.issues')}
            value={issues.map((check) => checkLabel(check.item)).join(', ')}
          />
        )}
        {row.peripherals.length === 0 ? null : (
          <Field
            label={tn('repair.condition.peripherals')}
            value={row.peripherals.map(peripheralLabel).join(', ')}
          />
        )}
        {row.intakeNotes === '' ? null : <Text style={repairStyles.muted}>{row.intakeNotes}</Text>}
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

const styles = StyleSheet.create({
  device: { marginTop: space.sm },
  actions: { marginTop: space.md },
  cancel: { marginTop: space.xl },
  secondaryAction: { marginTop: space.sm },
  phone: { alignSelf: 'flex-start', minHeight: touch.min, justifyContent: 'center' },
  phoneText: { ...type.bodySm, color: color.primary },
  passcode: { flexDirection: 'row', alignItems: 'center' },
  passcodeField: { flex: 1 },
  reveal: { minHeight: touch.min, justifyContent: 'center', marginLeft: space.md },
  line: { marginBottom: space.sm },
  total: { marginTop: space.sm },
  event: { ...repairStyles.muted, marginBottom: space.xs },
});
