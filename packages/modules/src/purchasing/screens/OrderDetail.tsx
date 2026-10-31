/**
 * OrderDetail — one order: who it is from, each part with how many have arrived, and every
 * delivery. A draft is finished and placed from here; a placed order is received and sent to the
 * supplier on WhatsApp; either can be cancelled. What arrived stays in stock whatever happens next.
 */
import { formatDate, formatDateTime, t } from '@bolusi/i18n';
import {
  AppShell,
  Banner,
  Button,
  Card,
  Chip,
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
import { Linking, Platform, Share, StyleSheet, View } from 'react-native';

import { useActionRunner } from '../../screen-kit/index.js';
import {
  ActionErrorBanner,
  QueryView,
  Section,
  type ScreenChrome,
} from '../../screen-kit/screens/views.js';
import { tp, type PurchasingKey } from '../i18n.js';
import { orderMessage, orderMessageUrl } from '../order-message.js';
import { whatsAppAppUrl, whatsAppUrl } from '../../shared/whatsapp.js';
import { STAGE_CHIP, draftOf, orderActions, orderInput, showsReceived } from '../order-form.js';
import type { OrderDetailRow } from '../queries.js';
import { useOrderStoreName, usePurchasingQuery, usePurchasingRuntime } from '../runtime.js';

export interface OrderDetailProps {
  readonly orderId: string;
  readonly chrome: ScreenChrome;
  readonly onBack: () => void;
  readonly onEdit: (order: OrderDetailRow) => void;
  readonly onReceive: (order: OrderDetailRow) => void;
  /** What the last step did ("Pesanan dipesan."), shown until dismissed. */
  readonly notice: PurchasingKey | null;
  readonly onClearNotice: () => void;
  readonly testID?: string | undefined;
}

export function OrderDetail({
  orderId,
  chrome,
  onBack,
  onEdit,
  onReceive,
  notice,
  onClearNotice,
  testID = 'purchasing.order',
}: OrderDetailProps): React.JSX.Element {
  const runtime = usePurchasingRuntime();
  const runner = useActionRunner();
  const storeName = useOrderStoreName();
  const [reloadNonce, setReloadNonce] = useState(0);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [done, setDone] = useState<PurchasingKey | null>(null);
  const query = usePurchasingQuery(
    async (rt) => (await rt.query('getOrder', { orderId })).rows[0],
    `order:${orderId}:${String(reloadNonce)}`,
  );
  const order = query.status === 'ready' ? query.data : undefined;
  const actions = order === undefined ? [] : orderActions(order.stage);
  const shownNotice = done ?? notice;
  const say = (key: PurchasingKey | null): void => {
    onClearNotice();
    setDone(key);
  };

  const place = (row: OrderDetailRow): void => {
    say(null);
    void runner
      .run(() => runtime.run('editOrder', { orderId: row.id, ...orderInput(draftOf(row), true) }))
      .then((result) => {
        if (result !== undefined) say('purchasing.done.placed');
      });
  };

  const cancel = (row: OrderDetailRow): void => {
    setConfirmCancel(false);
    say(null);
    void runner
      .run(() => runtime.run('cancelOrder', { orderId: row.id, reason: null }))
      .then((result) => {
        if (result !== undefined) say('purchasing.done.cancelled');
      });
  };

  // Writes the order and opens WhatsApp on the supplier's number, or the share sheet without one;
  // the buyer checks it and sends. As a servisan's messages: a phone opens the app itself, so one
  // without WhatsApp says so instead of landing in a browser; the web preview keeps wa.me.
  const send = (row: OrderDetailRow): void => {
    say(null);
    const url = orderMessageUrl(
      row,
      storeName,
      Platform.OS === 'web' ? whatsAppUrl : whatsAppAppUrl,
    );
    const opened =
      url === null ? Share.share({ message: orderMessage(row, storeName) }) : Linking.openURL(url);
    opened.catch(() => setDone('purchasing.message.sendFailed'));
  };

  const primary =
    order === undefined
      ? null
      : actions.includes('place')
        ? 'place'
        : actions.includes('receive')
          ? 'receive'
          : null;

  return (
    <AppShell
      scrollable
      title={order?.supplierName ?? tp('purchasing.list.title')}
      titleVariant="detail"
      onBack={onBack}
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
            message={tp(shownNotice)}
            onPress={() => say(null)}
            testID={`${testID}.notice`}
          />
        ) : undefined
      }
      bottomAction={
        order === undefined || primary === null ? undefined : primary === 'place' ? (
          <Button
            label={tp('purchasing.action.place')}
            onPress={() => place(order)}
            busy={runner.busy}
            disabled={runner.busy}
            testID={`${testID}.place`}
          />
        ) : (
          <Button
            label={tp('purchasing.action.receive')}
            onPress={() => onReceive(order)}
            disabled={runner.busy}
            testID={`${testID}.receive`}
          />
        )
      }
      overlay={
        confirmCancel && order !== undefined ? (
          <ConfirmSheet
            title={tp(
              order.stage === 'draft' ? 'purchasing.cancel.draftTitle' : 'purchasing.cancel.title',
            )}
            message={order.stage === 'draft' ? undefined : tp('purchasing.cancel.message')}
            confirmLabel={tp(
              order.stage === 'draft'
                ? 'purchasing.action.deleteDraft'
                : 'purchasing.action.cancel',
            )}
            tone="destructive"
            onConfirm={() => cancel(order)}
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
        {(row) => (row === undefined ? null : renderOrder(row))}
      </QueryView>
    </AppShell>
  );

  function renderOrder(row: OrderDetailRow): React.JSX.Element {
    const stage = STAGE_CHIP[row.stage];
    const draft = row.stage === 'draft';
    return (
      <View testID={`${testID}.content`}>
        <Card testID={`${testID}.summary`}>
          <View style={styles.summaryTop}>
            <Text style={styles.number}>{row.orderNumber}</Text>
            <Chip
              label={tp(`purchasing.stage.${row.stage}`)}
              icon={stage.icon}
              tone={stage.tone}
              testID={`${testID}.stage`}
            />
          </View>
          <Text style={styles.meta}>
            {row.orderedAt === null
              ? tp('purchasing.order.created', { date: formatDate(row.createdAt) })
              : tp('purchasing.order.ordered', { date: formatDate(row.orderedAt) })}
          </Text>
          {row.note === null ? null : <Text style={styles.note}>{row.note}</Text>}
          {row.stage === 'over' ? (
            <Text style={styles.warning}>{tp('purchasing.order.overHint')}</Text>
          ) : null}
          {row.stage === 'cancelled' && row.cancelReason !== null ? (
            <Text style={styles.meta}>{row.cancelReason}</Text>
          ) : null}
          {actions.includes('send') ? (
            <View style={styles.send}>
              <Button
                label={tp('purchasing.action.send')}
                variant="secondary"
                onPress={() => send(row)}
                testID={`${testID}.send`}
              />
            </View>
          ) : null}
        </Card>

        <Section
          title={tp('purchasing.order.lines')}
          action={
            actions.includes('edit') ? (
              <TextButton
                label={tp('purchasing.action.edit')}
                onPress={() => onEdit(row)}
                disabled={runner.busy}
                testID={`${testID}.edit`}
              />
            ) : undefined
          }
          testID={`${testID}.lines`}
        >
          {row.lines.map((line) => (
            <View key={line.itemId} style={styles.line} testID={`${testID}.line.${line.itemId}`}>
              <Text style={styles.lineName}>{line.name}</Text>
              <Text
                style={[styles.lineQty, line.received > line.qty ? styles.over : null]}
                testID={`${testID}.line.${line.itemId}.qty`}
              >
                {showsReceived(row.stage)
                  ? tp('purchasing.order.receivedOf', { received: line.received, qty: line.qty })
                  : tp('purchasing.order.qty', { qty: line.qty })}
              </Text>
            </View>
          ))}
        </Section>

        {row.receipts.length === 0 ? null : (
          <Section title={tp('purchasing.order.receipts')} testID={`${testID}.receipts`}>
            <Timeline
              entries={row.receipts.map((receipt) => ({
                key: receipt.id,
                title: receipt.lines
                  .map((line) =>
                    tp('purchasing.order.receiptLine', { name: line.name, qty: line.qty }),
                  )
                  .join(', '),
                meta: [formatDateTime(receipt.at), receipt.userName]
                  .filter((part) => part !== null)
                  .join(' · '),
                ...(receipt.note === null ? {} : { detail: receipt.note }),
              }))}
              testID={`${testID}.timeline`}
            />
          </Section>
        )}

        {actions.includes('cancel') ? (
          <View style={styles.cancel}>
            <TextButton
              label={tp(draft ? 'purchasing.action.deleteDraft' : 'purchasing.action.cancel')}
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

const styles = StyleSheet.create({
  // The number never breaks: a stage chip that does not fit beside it moves under it.
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
  warning: { ...type.bodySm, color: color.warning, marginTop: space.sm },
  send: { marginTop: space.md },
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm,
    borderBottomWidth: border.hairline,
    borderBottomColor: color.border,
  },
  lineName: { ...type.body, color: color.text, flex: 1 },
  lineQty: { ...type.bodySm, color: color.textMuted, fontVariant: ['tabular-nums'] },
  over: { color: color.warning },
  cancel: { marginTop: space['2xl'], alignItems: 'flex-start', marginLeft: -space.sm },
});
