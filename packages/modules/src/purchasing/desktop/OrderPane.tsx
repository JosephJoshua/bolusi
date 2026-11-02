// One order beside the orders list: the supplier, each part with how many came, and every delivery.
// A draft is finished and placed from here; a placed order is received and sent to the supplier;
// either can be cancelled. Live like the phone's: a sync redraws it.
import { formatDate, formatDateTime, t } from '@bolusi/i18n';
import {
  Banner,
  Button,
  Chip,
  ConfirmDialog,
  IconButton,
  Section,
  StatePanel,
  Timeline,
} from '@bolusi/ui-web';
import { SearchX, Send, X } from 'lucide-react';
import { useState } from 'react';

import { useActionRunner } from '../../screen-kit/index.js';
import { ActionError, QueryPanel } from '../../screen-kit/desktop/index.js';
import { tp, type PurchasingKey } from '../i18n.js';
import { orderMessage, orderMessageUrl } from '../order-message.js';
import { STAGE_CHIP, draftOf, orderActions, orderInput, showsReceived } from '../order-form.js';
import type { OrderDetailRow } from '../queries.js';
import { useOrderStoreName, usePurchasingQuery, usePurchasingRuntime } from '../runtime.js';
import { OrderDialog, ReceiveDialog } from './dialogs.js';
import { STAGE_ICON } from './stage.js';

export interface OrderPaneProps {
  readonly orderId: string;
  readonly onClose: () => void;
  /** What the list's last task did ("Pesanan dipesan."), shown until dismissed. */
  readonly notice: PurchasingKey | null;
  readonly onClearNotice: () => void;
}

type Task = 'none' | 'edit' | 'receive' | 'cancel';

export function OrderPane({
  orderId,
  onClose,
  notice,
  onClearNotice,
}: OrderPaneProps): React.JSX.Element {
  const runtime = usePurchasingRuntime();
  const runner = useActionRunner();
  const storeName = useOrderStoreName();
  const [reloadNonce, setReloadNonce] = useState(0);
  const [task, setTask] = useState<Task>('none');
  const [done, setDone] = useState<PurchasingKey | null>(null);
  const say = (key: PurchasingKey | null): void => {
    onClearNotice();
    setDone(key);
  };
  const query = usePurchasingQuery(
    async (rt) => (await rt.query('getOrder', { orderId })).rows[0],
    `desk.order:${orderId}:${String(reloadNonce)}`,
  );
  const order = query.status === 'ready' ? query.data : undefined;
  const shown = done ?? notice;
  const testId = 'purchasing.desk.order';

  const place = (row: OrderDetailRow): void => {
    say(null);
    void runner
      .run(() => runtime.run('editOrder', { orderId: row.id, ...orderInput(draftOf(row), true) }))
      .then((result) => {
        if (result !== undefined) say('purchasing.done.placed');
      });
  };
  const cancel = (row: OrderDetailRow): void => {
    setTask('none');
    say(null);
    void runner
      .run(() => runtime.run('cancelOrder', { orderId: row.id, reason: null }))
      .then((result) => {
        if (result !== undefined) say('purchasing.done.cancelled');
      });
  };
  // Opens WhatsApp on the supplier's number with the order written; without a number the message is
  // copied, to paste into whatever chat the supplier uses.
  // What the pane says stays until something new replaces it, so the button does not jump.
  const send = (row: OrderDetailRow): void => {
    const url = orderMessageUrl(row, storeName);
    if (url !== null) {
      window.open(url, '_blank', 'noopener');
      return;
    }
    navigator.clipboard.writeText(orderMessage(row, storeName)).then(
      () => setDone('purchasing.desk.copied'),
      () => setDone('purchasing.desk.copyFailed'),
    );
  };

  const banner =
    runner.errorCode !== null ? (
      <ActionError errorCode={runner.errorCode} onDismiss={runner.clearError} />
    ) : shown !== null ? (
      <Banner
        tone={shown === 'purchasing.desk.copyFailed' ? 'danger' : 'success'}
        message={tp(shown)}
        onDismiss={() => say(null)}
        dismissLabel={t('core.action.close')}
      />
    ) : null;

  return (
    <section
      aria-label={order?.orderNumber ?? tp('purchasing.list.title')}
      data-testid={testId}
      // Focusable so Enter on the list can move the keyboard here.
      tabIndex={-1}
      className="flex min-h-0 flex-1 flex-col border-l border-border bg-surface focus:outline-none"
    >
      <QueryPanel query={query} onRetry={() => setReloadNonce((n) => n + 1)}>
        {(row) =>
          row === undefined ? (
            <StatePanel
              icon={SearchX}
              title={t('core.errors.ENTITY_NOT_FOUND')}
              action={<Button label={t('core.action.close')} onClick={onClose} />}
              testId={`${testId}.missing`}
            />
          ) : (
            <>
              {renderHeader(row)}
              <div className="min-h-0 flex-1 overflow-y-auto">
                <div className="flex flex-col gap-8 px-6 pb-10 pt-4">
                  {banner}
                  {renderBody(row)}
                </div>
              </div>
            </>
          )
        }
      </QueryPanel>
      {order === undefined ? null : renderTask(order)}
    </section>
  );

  function renderHeader(row: OrderDetailRow): React.JSX.Element {
    const actions = orderActions(row.stage);
    const chip = STAGE_CHIP[row.stage];
    return (
      <header className="flex flex-col gap-4 border-b border-border px-6 pb-4 pt-4">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h2 className="text-title font-bold text-text" data-testid={`${testId}.supplier`}>
              {row.supplierName}
            </h2>
            <p className="tabular text-body text-text-muted" data-testid={`${testId}.number`}>
              {row.orderNumber}
            </p>
          </div>
          <IconButton
            icon={X}
            label={tp('purchasing.desk.close')}
            className="-mr-2 shrink-0"
            onClick={onClose}
            data-testid={`${testId}.close`}
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span data-testid={`${testId}.stage`}>
              <Chip
                label={tp(`purchasing.stage.${row.stage}`)}
                icon={STAGE_ICON[chip.icon]}
                tone={chip.tone}
              />
            </span>
            <span className="text-small text-text-muted">
              {row.orderedAt === null
                ? tp('purchasing.order.created', { date: formatDate(row.createdAt) })
                : tp('purchasing.order.ordered', { date: formatDate(row.orderedAt) })}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {actions.includes('send') ? (
              <Button
                label={tp('purchasing.action.send')}
                icon={Send}
                onClick={() => send(row)}
                disabled={runner.busy}
                data-testid={`${testId}.send`}
              />
            ) : null}
            {actions.includes('place') ? (
              <Button
                label={tp('purchasing.action.place')}
                variant="primary"
                onClick={() => place(row)}
                busy={runner.busy}
                disabled={runner.busy}
                data-testid={`${testId}.place`}
              />
            ) : null}
            {actions.includes('receive') ? (
              <Button
                label={tp('purchasing.action.receive')}
                variant="primary"
                onClick={() => {
                  say(null);
                  setTask('receive');
                }}
                disabled={runner.busy}
                data-testid={`${testId}.receive`}
              />
            ) : null}
          </div>
        </div>
      </header>
    );
  }

  function renderBody(row: OrderDetailRow): React.JSX.Element {
    const actions = orderActions(row.stage);
    const placed = showsReceived(row.stage);
    return (
      <>
        {row.note === null && row.stage !== 'over' ? null : (
          <div className="flex flex-col gap-2">
            {row.note === null ? null : (
              <p className="text-body text-text" data-testid={`${testId}.note`}>
                {row.note}
              </p>
            )}
            {row.stage === 'over' ? (
              <p className="text-body text-warning">{tp('purchasing.order.overHint')}</p>
            ) : null}
          </div>
        )}

        <Section
          title={tp('purchasing.order.lines')}
          action={
            actions.includes('edit') ? (
              <Button
                label={tp('purchasing.action.edit')}
                variant="text"
                size="sm"
                className="-my-1"
                onClick={() => {
                  say(null);
                  setTask('edit');
                }}
                disabled={runner.busy}
                data-testid={`${testId}.edit`}
              />
            ) : undefined
          }
          testId={`${testId}.lines`}
        >
          <ul>
            {row.lines.map((line) => (
              <li
                key={line.itemId}
                className="flex items-baseline gap-4 border-b border-border py-2 last:border-b-0"
                data-testid={`${testId}.line.${line.itemId}`}
              >
                <span className="min-w-0 flex-1 text-body text-text">{line.name}</span>
                <span
                  className={
                    placed && line.received > line.qty
                      ? 'tabular shrink-0 text-body font-semibold text-warning'
                      : 'tabular shrink-0 text-body text-text-muted'
                  }
                  data-testid={`${testId}.line.${line.itemId}.qty`}
                >
                  {placed
                    ? tp('purchasing.order.receivedOf', { received: line.received, qty: line.qty })
                    : tp('purchasing.order.qty', { qty: line.qty })}
                </span>
              </li>
            ))}
          </ul>
        </Section>

        {row.receipts.length === 0 ? null : (
          <Section title={tp('purchasing.order.receipts')} testId={`${testId}.receipts`}>
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
              testId={`${testId}.timeline`}
            />
          </Section>
        )}

        {actions.includes('cancel') ? (
          <div>
            <Button
              label={tp(
                row.stage === 'draft'
                  ? 'purchasing.action.deleteDraft'
                  : 'purchasing.action.cancel',
              )}
              variant="dangerText"
              className="-ml-3"
              onClick={() => setTask('cancel')}
              disabled={runner.busy}
              data-testid={`${testId}.cancel`}
            />
          </div>
        ) : null}
      </>
    );
  }

  function renderTask(row: OrderDetailRow): React.JSX.Element | null {
    switch (task) {
      case 'none':
        return null;
      case 'edit':
        return (
          <OrderDialog
            order={row}
            onClose={() => setTask('none')}
            onDone={(_, placed) => {
              setTask('none');
              setDone(placed ? 'purchasing.done.placed' : 'purchasing.done.drafted');
            }}
          />
        );
      case 'receive':
        return (
          <ReceiveDialog
            order={row}
            onClose={() => setTask('none')}
            onDone={() => {
              setTask('none');
              setDone('purchasing.done.received');
            }}
          />
        );
      case 'cancel': {
        const draft = row.stage === 'draft';
        return (
          <ConfirmDialog
            open
            title={tp(draft ? 'purchasing.cancel.draftTitle' : 'purchasing.cancel.title')}
            message={tp(draft ? 'purchasing.discard.message' : 'purchasing.cancel.message')}
            confirmLabel={tp(draft ? 'purchasing.action.deleteDraft' : 'purchasing.action.cancel')}
            cancelLabel={t('core.action.cancel')}
            closeLabel={t('core.action.close')}
            destructive
            onConfirm={() => cancel(row)}
            onCancel={() => setTask('none')}
            testId={`${testId}.cancelConfirm`}
          />
        );
      }
    }
  }
}
