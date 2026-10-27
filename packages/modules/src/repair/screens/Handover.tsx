/**
 * Handover — giving the device back: a photo of the handover and the customer's signature, both
 * required, then one tap records it. The amount shown is what the customer owes and signs for: the
 * price on a repaired phone, the cancellation fee on a cancelled one. Payment itself is still the
 * store's paper cash book in this slice.
 */
import { formatMoney } from '@bolusi/i18n';
import { Card, PhotoSlot, TextInput, border, color, space, type } from '@bolusi/ui';
import type { MediaRef } from '@bolusi/schemas';
import { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useActionRunner, type DiscardGuard } from '../../screen-kit/index.js';

import { tn } from './i18n.js';
import { capturedThumbnailRef, repairAbilities, staleStep, ticketStatus } from '../flows.js';
import {
  FlowScreen,
  PhotoGrid,
  PhotoThumb,
  QueryView,
  StatusChip,
  repairStyles,
  type RepairChrome,
} from './parts.js';
import { useDiscardConfirm } from './discard.js';
import { useRepairQuery, useRepairRuntime } from './runtime.js';

export interface HandoverProps {
  readonly ticketId: string;
  readonly chrome: RepairChrome;
  readonly onDone: () => void;
  readonly onCancel: () => void;
  /** Lets hardware back ask before dropping the photo and signature taken here. */
  readonly onRegisterDiscardGuard?: ((guard: DiscardGuard | null) => void) | undefined;
  readonly testID?: string | undefined;
}

export function Handover({
  ticketId,
  chrome,
  onDone,
  onCancel,
  onRegisterDiscardGuard,
  testID = 'repair.handover',
}: HandoverProps): React.JSX.Element {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const [photo, setPhoto] = useState<MediaRef | null>(null);
  const [signature, setSignature] = useState<MediaRef | null>(null);
  const [note, setNote] = useState('');
  const [reloadNonce, setReloadNonce] = useState(0);
  const query = useRepairQuery(
    async (rt) => (await rt.query('getTicket', { ticketId })).rows[0],
    `handover:${ticketId}:${String(reloadNonce)}`,
  );

  // Handed back, reopened or held by a new proposal on another device meanwhile: say so rather
  // than take a signature for a handover that would be refused.
  const can = useMemo(() => repairAbilities(runtime.hasPermission), [runtime]);
  const ticket = query.status === 'ready' ? query.data : undefined;
  const stale =
    ticket === undefined ? null : staleStep({ kind: 'handover' }, ticket, can, runtime.userId);

  const discard = useDiscardConfirm({
    dirty: stale === null && (photo !== null || signature !== null || note.trim() !== ''),
    onRegisterDiscardGuard,
    testID,
  });

  const capture = (
    take: () => Promise<{ readonly mediaRef: MediaRef } | null>,
    keep: (ref: MediaRef) => void,
  ): void => {
    void runner.run(take).then((captured) => {
      if (captured !== undefined && captured !== null) keep(captured.mediaRef);
    });
  };

  const submit = (): void => {
    if (photo === null || signature === null) return;
    void runner
      .run(() => runtime.run('returnDevice', { ticketId, handoverPhoto: photo, signature, note }))
      .then((result) => {
        if (result !== undefined) onDone();
      });
  };

  return (
    <FlowScreen
      chrome={chrome}
      title={tn('repair.action.handover')}
      onBack={() => discard.requestLeave(onCancel)}
      overlay={discard.overlay}
      primaryLabel={tn('repair.action.handover')}
      onPrimary={submit}
      primaryDisabled={photo === null || signature === null}
      primaryHint={tn('repair.hint.handover')}
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
        {(ticket) =>
          ticket === undefined ? null : (
            <Card testID={`${testID}.summary`}>
              <StatusChip status={ticketStatus(ticket)} testID={`${testID}.status`} />
              <Text style={styles.customer}>{ticket.customerName}</Text>
              <Text style={repairStyles.muted}>
                {`${ticket.deviceBrand} ${ticket.deviceModel} · ${ticket.ticketNumber}`}
              </Text>
              {ticket.outcome === 'cancelled' ? (
                // What the customer signs for: the cancellation fee, never the repair price. A
                // ticket cancelled before fees existed charged nothing.
                <View style={styles.total}>
                  <View style={repairStyles.row}>
                    <Text style={[styles.totalLabel, repairStyles.rowText]}>
                      {tn('repair.cancel.fee')}
                    </Text>
                    <Text style={repairStyles.heading} testID={`${testID}.total`}>
                      {formatMoney(ticket.cancelFee ?? 0)}
                    </Text>
                  </View>
                  <Text style={repairStyles.muted} testID={`${testID}.cancelled`}>
                    {tn('repair.handover.cancelled')}
                  </Text>
                </View>
              ) : (
                <View style={[repairStyles.row, styles.total]}>
                  <Text style={[styles.totalLabel, repairStyles.rowText]}>
                    {tn('repair.price.total')}
                  </Text>
                  <Text style={repairStyles.heading} testID={`${testID}.total`}>
                    {formatMoney(ticket.quoteTotal)}
                  </Text>
                </View>
              )}
            </Card>
          )
        }
      </QueryView>
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
          label={tn('repair.handover.note')}
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
  // Two captures side by side, each half the row.
  half: { flexBasis: '47%', flexGrow: 1 },
});
