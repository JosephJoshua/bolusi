// One transfer beside the list: the other store, each part with how many arrived, and what happened
// since. The receiving store receives from here; the sender cancels before anything arrived; the
// sending owner settles what is left open. It reads and offers what the phone's does (transfers/view).
import { t } from '@bolusi/i18n';
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
import { SearchX, X } from 'lucide-react';
import { useState } from 'react';

import { useActionRunner, useDoneNote } from '../../screen-kit/index.js';
import { ActionError, QueryPanel } from '../../screen-kit/desktop/index.js';
import { ti, type InventoryKey } from '../i18n.js';
import { useInventoryQuery, useInventoryRuntime } from '../runtime.js';
import { TRANSFER_STAGE_CHIP, otherStoreText } from '../transfers/form.js';
import type { TransferDetailRow } from '../transfers/queries.js';
import { useStores } from '../transfers/stores.js';
import {
  lineProgress,
  lineStatus,
  sentLine,
  summaryHint,
  transferHistory,
  transferLead,
} from '../transfers/view.js';
import { STAGE_ICON } from './stage.js';
import { ReceiveTransferDialog, SettleDialog } from './transfer-dialogs.js';

export interface TransferPaneProps {
  readonly transferId: string;
  readonly onClose: () => void;
  /** What the list's last task did ("Sparepart dikirim."), shown until dismissed. */
  readonly notice: InventoryKey | null;
  readonly onClearNotice: () => void;
}

type Task = 'none' | 'receive' | 'settle' | 'cancel';

export function TransferPane({
  transferId,
  onClose,
  notice,
  onClearNotice,
}: TransferPaneProps): React.JSX.Element {
  const runtime = useInventoryRuntime();
  const runner = useActionRunner();
  const stores = useStores();
  const [reloadNonce, setReloadNonce] = useState(0);
  const [task, setTask] = useState<Task>('none');
  const { note: done, say: setDone } = useDoneNote<InventoryKey>((key) => ti(key));
  const say = (key: InventoryKey | null): void => {
    onClearNotice();
    setDone(key);
  };
  const query = useInventoryQuery(
    async (rt) => (await rt.query('getTransfer', { transferId })).rows[0],
    `desk.transfer:${transferId}:${String(reloadNonce)}`,
  );
  const transfer = query.status === 'ready' ? query.data : undefined;
  const shown = done ?? notice;
  const testId = 'inventory.desk.transfer';

  const cancel = (row: TransferDetailRow): void => {
    setTask('none');
    say(null);
    void runner
      .run(() => runtime.run('cancelTransfer', { transferId: row.id, reason: null }))
      .then((result) => {
        if (result !== undefined) say('inventory.transfer.done.cancelled');
      });
  };
  const start = (next: Task): void => {
    say(null);
    setTask(next);
  };

  const banner =
    runner.errorCode !== null ? (
      <ActionError errorCode={runner.errorCode} onDismiss={runner.clearError} />
    ) : shown !== null ? (
      <Banner
        tone="success"
        message={ti(shown)}
        onDismiss={() => say(null)}
        dismissLabel={t('core.action.close')}
      />
    ) : null;

  return (
    <section
      aria-label={transfer?.transferNumber ?? ti('inventory.transfer.section')}
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
      {transfer === undefined ? null : renderTask(transfer)}
    </section>
  );

  function renderHeader(row: TransferDetailRow): React.JSX.Element {
    const { primary } = transferLead(row, runtime);
    const chip = TRANSFER_STAGE_CHIP[row.stage];
    return (
      <header className="flex flex-col gap-4 border-b border-border px-6 pb-4 pt-4">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h2 className="text-title font-bold text-text" data-testid={`${testId}.store`}>
              {otherStoreText(row, stores)}
            </h2>
            <p className="tabular text-body text-text-muted" data-testid={`${testId}.number`}>
              {row.transferNumber}
            </p>
          </div>
          <IconButton
            icon={X}
            label={ti('inventory.transfer.desk.close')}
            className="-mr-2 shrink-0"
            onClick={onClose}
            data-testid={`${testId}.close`}
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span data-testid={`${testId}.stage`}>
              <Chip
                label={ti(`inventory.transfer.stage.${row.stage}`)}
                icon={STAGE_ICON[chip.icon]}
                tone={chip.tone}
              />
            </span>
            <span className="text-small text-text-muted">{sentLine(row)}</span>
          </div>
          {primary === null ? null : (
            <Button
              label={ti(
                primary === 'receive'
                  ? 'inventory.transfer.action.receive'
                  : 'inventory.transfer.action.settle',
              )}
              variant="primary"
              onClick={() => start(primary)}
              disabled={runner.busy}
              data-testid={`${testId}.${primary}`}
            />
          )}
        </div>
      </header>
    );
  }

  function renderBody(row: TransferDetailRow): React.JSX.Element {
    const { steps, settleQuietly } = transferLead(row, runtime);
    const hint = summaryHint(row);
    const history = transferHistory(row);
    return (
      <>
        {row.note === null && hint === null ? null : (
          <div className="flex flex-col gap-2">
            {row.note === null ? null : (
              <p className="text-body text-text" data-testid={`${testId}.note`}>
                {row.note}
              </p>
            )}
            {hint === null ? null : (
              <p
                className={
                  hint.tone === 'danger' ? 'text-body text-danger' : 'text-body text-text-muted'
                }
                data-testid={`${testId}.hint`}
              >
                {ti(hint.key)}
              </p>
            )}
          </div>
        )}

        <Section
          title={ti('inventory.transfer.detail.lines')}
          action={
            settleQuietly ? (
              <Button
                label={ti('inventory.transfer.action.settle')}
                variant="text"
                size="sm"
                className="-my-1"
                onClick={() => start('settle')}
                disabled={runner.busy}
                data-testid={`${testId}.settleQuiet`}
              />
            ) : undefined
          }
          testId={`${testId}.lines`}
        >
          <ul>
            {row.lines.map((line) => {
              const status = lineStatus(line);
              return (
                <li
                  key={line.itemId}
                  className="flex items-baseline gap-4 border-b border-border py-2 last:border-b-0"
                  data-testid={`${testId}.line.${line.itemId}`}
                >
                  <span className="min-w-0 flex-1 text-body text-text">{line.name}</span>
                  <span className="flex shrink-0 flex-col items-end">
                    <span className="tabular text-body text-text-muted">{lineProgress(line)}</span>
                    {status === null ? null : (
                      <span
                        className={
                          status.tone === 'danger'
                            ? 'tabular text-body font-semibold text-danger'
                            : 'tabular text-body font-semibold text-warning'
                        }
                        data-testid={`${testId}.line.${line.itemId}.status`}
                      >
                        {status.text}
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </Section>

        {history.length === 0 ? null : (
          <Section title={ti('inventory.transfer.detail.history')} testId={`${testId}.history`}>
            <Timeline entries={history} testId={`${testId}.timeline`} />
          </Section>
        )}

        {steps.includes('cancel') ? (
          <div>
            <Button
              label={ti('inventory.transfer.action.cancel')}
              variant="dangerText"
              className="-ml-3"
              onClick={() => start('cancel')}
              disabled={runner.busy}
              data-testid={`${testId}.cancel`}
            />
          </div>
        ) : null}
      </>
    );
  }

  function renderTask(row: TransferDetailRow): React.JSX.Element | null {
    switch (task) {
      case 'none':
        return null;
      case 'receive':
        return (
          <ReceiveTransferDialog
            transfer={row}
            onClose={() => setTask('none')}
            onDone={() => {
              setTask('none');
              setDone('inventory.transfer.done.received');
            }}
          />
        );
      case 'settle':
        return (
          <SettleDialog
            transfer={row}
            onClose={() => setTask('none')}
            onDone={() => {
              setTask('none');
              setDone('inventory.transfer.done.settled');
            }}
          />
        );
      case 'cancel':
        return (
          <ConfirmDialog
            open
            title={ti('inventory.transfer.cancel.title')}
            message={ti('inventory.transfer.cancel.message')}
            confirmLabel={ti('inventory.transfer.action.cancel')}
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
