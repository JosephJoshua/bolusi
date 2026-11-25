/**
 * TransferDetail — one transfer: which stores, each part with how many arrived and how many have
 * not, and what happened since (arrivals, settlements, a cancel). The receiving store receives from
 * here; the sender cancels before anything arrived; the sending owner settles what is left open.
 */
import { t } from '@bolusi/i18n';
import {
  AppShell,
  Banner,
  Button,
  Card,
  Chip,
  Columns,
  ConfirmSheet,
  TextButton,
  Timeline,
  border,
  color,
  space,
  type,
  Text,
} from '@bolusi/ui';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useActionRunner, useJustReplaced } from '../../../screen-kit/index.js';
import {
  ActionErrorBanner,
  QueryView,
  Section,
  type ScreenChrome,
} from '../../../screen-kit/screens/views.js';
import { ti, type InventoryKey } from '../../i18n.js';
import { useInventoryQuery, useInventoryRuntime } from '../../runtime.js';
import { TRANSFER_STAGE_CHIP, otherStoreText } from '../../transfers/form.js';
import type { TransferDetailRow } from '../../transfers/queries.js';
import type { TransferLineState } from '../../transfers/state.js';
import {
  lineProgress,
  lineStatus,
  sentLine,
  summaryHint,
  transferHistory,
  transferLead,
} from '../../transfers/view.js';
import { useStores } from '../../transfers/stores.js';

export interface TransferDetailProps {
  readonly transferId: string;
  readonly chrome: ScreenChrome;
  readonly onBack: () => void;
  readonly onReceive: (transfer: TransferDetailRow) => void;
  readonly onSettle: (transfer: TransferDetailRow) => void;
  /** What the last step did ("Sparepart dikirim."), shown until dismissed. */
  readonly notice: InventoryKey | null;
  readonly onClearNotice: () => void;
  /** Beside the list on a wide screen: the list is in view, so there is no back arrow. */
  readonly hideBack?: boolean | undefined;
  readonly testID?: string | undefined;
}

export function TransferDetail({
  transferId,
  chrome,
  onBack,
  onReceive,
  onSettle,
  notice,
  onClearNotice,
  hideBack = false,
  testID = 'inventory.transfer',
}: TransferDetailProps): React.JSX.Element {
  const runtime = useInventoryRuntime();
  const runner = useActionRunner();
  const stores = useStores();
  const [reloadNonce, setReloadNonce] = useState(0);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [done, setDone] = useState<InventoryKey | null>(null);
  const query = useInventoryQuery(
    async (rt) => (await rt.query('getTransfer', { transferId })).rows[0],
    `transfer:${transferId}:${String(reloadNonce)}`,
  );
  const transfer = query.status === 'ready' ? query.data : undefined;
  const lead = transfer === undefined ? null : transferLead(transfer, runtime);
  const steps = lead?.steps ?? [];
  const primary = lead?.primary ?? null;
  const primaryHeld = useJustReplaced(primary);
  const shownNotice = done ?? notice;
  const say = (key: InventoryKey | null): void => {
    onClearNotice();
    setDone(key);
  };

  const cancel = (row: TransferDetailRow): void => {
    setConfirmCancel(false);
    say(null);
    void runner
      .run(() => runtime.run('cancelTransfer', { transferId: row.id, reason: null }))
      .then((result) => {
        if (result !== undefined) say('inventory.transfer.done.cancelled');
      });
  };

  return (
    <AppShell
      scrollable
      wide={(transfer?.arrivals.length ?? 0) + (transfer?.settlements.length ?? 0) > 0}
      title={
        transfer === undefined ? ti('inventory.transfer.section') : otherStoreText(transfer, stores)
      }
      titleVariant="detail"
      onBack={hideBack ? undefined : onBack}
      backLabel={t('core.action.back')}
      syncChip={chrome.syncChip}
      avatar={chrome.avatar}
      banner={
        runner.errorCode !== null ? (
          <ActionErrorBanner
            errorCode={runner.errorCode}
            onDismiss={runner.clearError}
            testID={`${testID}.error`}
          />
        ) : shownNotice !== null ? (
          <Banner
            variant="info"
            message={ti(shownNotice)}
            onPress={() => say(null)}
            testID={`${testID}.notice`}
          />
        ) : undefined
      }
      bottomAction={
        transfer === undefined || primary === null ? undefined : (
          <Button
            label={ti(
              primary === 'receive'
                ? 'inventory.transfer.action.receive'
                : 'inventory.transfer.action.settle',
            )}
            onPress={() => {
              if (primaryHeld) return;
              if (primary === 'receive') onReceive(transfer);
              else onSettle(transfer);
            }}
            disabled={runner.busy}
            testID={`${testID}.${primary}`}
          />
        )
      }
      overlay={
        confirmCancel && transfer !== undefined ? (
          <ConfirmSheet
            title={ti('inventory.transfer.cancel.title')}
            message={ti('inventory.transfer.cancel.message')}
            confirmLabel={ti('inventory.transfer.action.cancel')}
            tone="destructive"
            onConfirm={() => cancel(transfer)}
            cancelLabel={t('core.action.back')}
            onCancel={() => setConfirmCancel(false)}
            testID={`${testID}.cancelConfirm`}
          />
        ) : undefined
      }
      testID={testID}
    >
      <QueryView
        query={query}
        onBack={onBack}
        onRetry={() => setReloadNonce((n) => n + 1)}
        testID={testID}
      >
        {(row) => (row === undefined ? null : renderTransfer(row))}
      </QueryView>
    </AppShell>
  );

  function renderTransfer(row: TransferDetailRow): React.JSX.Element {
    const stage = TRANSFER_STAGE_CHIP[row.stage];
    const history = transferHistory(row);
    const hint = summaryHint(row);
    return (
      <View testID={`${testID}.content`}>
        <Columns
          testID={`${testID}.columns`}
          start={
            <>
              <Card testID={`${testID}.summary`}>
                <View style={styles.summaryTop}>
                  <Text style={styles.number}>{row.transferNumber}</Text>
                  <Chip
                    label={ti(`inventory.transfer.stage.${row.stage}`)}
                    icon={stage.icon}
                    tone={stage.tone}
                    testID={`${testID}.stage`}
                  />
                </View>
                <Text style={styles.meta}>{sentLine(row)}</Text>
                {row.note === null ? null : <Text style={styles.note}>{row.note}</Text>}
                {hint === null ? null : (
                  <Text
                    style={hint.tone === 'danger' ? styles.warning : styles.hint}
                    testID={hint.tone === 'danger' ? `${testID}.overHint` : undefined}
                  >
                    {ti(hint.key)}
                  </Text>
                )}
              </Card>

              <Section
                title={ti('inventory.transfer.detail.lines')}
                action={
                  lead?.settleQuietly === true ? (
                    <TextButton
                      label={ti('inventory.transfer.action.settle')}
                      onPress={() => onSettle(row)}
                      disabled={runner.busy}
                      testID={`${testID}.settleQuiet`}
                    />
                  ) : undefined
                }
                testID={`${testID}.lines`}
              >
                {row.lines.map((line) => (
                  <TransferLine
                    key={line.itemId}
                    line={line}
                    testID={`${testID}.line.${line.itemId}`}
                  />
                ))}
              </Section>
            </>
          }
          end={
            history.length === 0 ? null : (
              <Section title={ti('inventory.transfer.detail.history')} testID={`${testID}.history`}>
                <Timeline entries={history} testID={`${testID}.timeline`} />
              </Section>
            )
          }
        />

        {steps.includes('cancel') ? (
          <View style={styles.cancel}>
            <TextButton
              label={ti('inventory.transfer.action.cancel')}
              tone="danger"
              onPress={() => setConfirmCancel(true)}
              disabled={runner.busy}
              testID={`${testID}.cancel`}
            />
          </View>
        ) : null}
      </View>
    );
  }
}

function TransferLine({
  line,
  testID,
}: {
  readonly line: TransferLineState;
  readonly testID: string;
}): React.JSX.Element {
  const status = lineStatus(line);
  return (
    <View style={styles.line} testID={testID}>
      <Text style={styles.lineName}>{line.name}</Text>
      <View style={styles.lineQty}>
        <Text style={styles.qty} testID={`${testID}.qty`}>
          {lineProgress(line)}
        </Text>
        {status === null ? null : (
          <Text
            style={[styles.qty, status.tone === 'danger' ? styles.over : styles.short]}
            testID={`${testID}.status`}
          >
            {status.text}
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  summaryTop: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  number: { ...type.heading, color: color.text, fontVariant: ['tabular-nums'], flexShrink: 0 },
  meta: { ...type.bodySm, color: color.textMuted, marginTop: space.xs },
  note: { ...type.body, color: color.text, marginTop: space.sm },
  hint: { ...type.bodySm, color: color.textMuted, marginTop: space.sm },
  warning: { ...type.bodySm, color: color.danger, marginTop: space.sm },
  line: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.md,
    paddingVertical: space.sm,
    borderBottomWidth: border.hairline,
    borderBottomColor: color.border,
  },
  lineName: { ...type.body, color: color.text, flex: 1 },
  lineQty: { alignItems: 'flex-end', gap: space.xs },
  qty: { ...type.bodySm, color: color.textMuted, fontVariant: ['tabular-nums'] },
  short: { color: color.warning },
  over: { color: color.danger },
  cancel: { marginTop: space['2xl'], alignItems: 'flex-start', marginLeft: -space.sm },
});
