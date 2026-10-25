/**
 * Handover — giving the device back: a photo of the handover and the customer's signature, both
 * required, then one tap records it. On a repaired phone the price shown is what the customer owes;
 * on a cancelled one the repair price is not charged. Payment itself is still the store's paper cash
 * book in this slice.
 */
import { formatMoney } from '@bolusi/i18n';
import { Card, PhotoSlot, TextInput } from '@bolusi/ui';
import type { MediaRef } from '@bolusi/schemas';
import { useState } from 'react';
import { Text, View } from 'react-native';

import { useActionRunner, type DiscardGuard } from '../../screen-kit/index.js';

import { tn } from './i18n.js';
import { capturedThumbnailRef, ticketStatus } from '../flows.js';
import {
  Field,
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

  const discard = useDiscardConfirm({
    dirty: photo !== null || signature !== null,
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
              <View style={repairStyles.row}>
                <Text style={repairStyles.heading}>{ticket.customerName}</Text>
                <StatusChip status={ticketStatus(ticket)} testID={`${testID}.status`} />
              </View>
              <Text style={repairStyles.body}>
                {`${ticket.ticketNumber} · ${ticket.deviceBrand} ${ticket.deviceModel}`}
              </Text>
              {ticket.outcome === 'cancelled' ? (
                <Text style={[repairStyles.muted, repairStyles.gap]} testID={`${testID}.cancelled`}>
                  {tn('repair.handover.cancelled')}
                </Text>
              ) : (
                <Field
                  label={tn('repair.price.total')}
                  value={formatMoney(ticket.quoteTotal)}
                  testID={`${testID}.total`}
                />
              )}
            </Card>
          )
        }
      </QueryView>
      <View style={repairStyles.gap}>
        <PhotoGrid>
          <View style={repairStyles.gridCell}>
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
          <View style={repairStyles.gridCell}>
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
