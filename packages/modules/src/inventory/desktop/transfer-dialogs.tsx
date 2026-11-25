// Kiriman's tasks on the counter PC, each a dialog: send parts to another store, receive what came,
// and settle what a transfer left open. The forms' state and checks are the phone's (transfers/form).
import { ChoiceList, IconButton, TextArea } from '@bolusi/ui-web';
import { X } from 'lucide-react';
import { useState } from 'react';

import { useActionRunner } from '../../screen-kit/index.js';
import { TaskDialog, type DiscardCopy } from '../../screen-kit/desktop/index.js';
import { MAX_MOVEMENT_QTY } from '../constants.js';
import { ti } from '../i18n.js';
import { useInventoryRuntime } from '../runtime.js';
import { overStockHint } from '../take-part.js';
import {
  EMPTY_SEND,
  addSendLine,
  canSend,
  countTotal,
  receivableLines,
  receiveInput,
  receiveStart,
  removeSendLine,
  sendChanged,
  sendInput,
  setSendQty,
  settleInput,
  settleLines,
  settleMode,
  settleProblem,
  settleStart,
  stillToCome,
  type SendDraft,
  type SettleCounts,
} from '../transfers/form.js';
import { MAX_TRANSFER_NOTE } from '../transfers/operations.js';
import type { TransferDetailRow } from '../transfers/queries.js';
import { useStores } from '../transfers/stores.js';
import { QtyField } from './fields.js';
import { PartSearch } from './PartSearch.js';

function discardCopy(): DiscardCopy {
  return {
    title: ti('inventory.transfer.discard.title'),
    message: ti('inventory.transfer.discard.message'),
    confirm: ti('inventory.discard.confirm'),
    keep: ti('inventory.discard.keep'),
  };
}

export interface SendDialogProps {
  readonly onClose: () => void;
  readonly onDone: (transferId: string) => void;
}

/** Kirim sparepart: the store it goes to, the parts and how many, and a note for that store. */
export function SendDialog({ onClose, onDone }: SendDialogProps): React.JSX.Element {
  const runtime = useInventoryRuntime();
  const runner = useActionRunner();
  const stores = useStores();
  const [draft, setDraft] = useState<SendDraft>(EMPTY_SEND);
  const testId = 'inventory.desk.send';
  const ready = canSend(draft);
  const send = (): void => {
    void runner
      .run(async () => (await runtime.run('sendTransfer', sendInput(draft))).transferId)
      .then((transferId) => {
        if (transferId !== undefined) onDone(transferId);
      });
  };
  return (
    <TaskDialog
      title={ti('inventory.transfer.form.title')}
      runner={runner}
      dirty={sendChanged(draft)}
      discard={discardCopy()}
      onClose={onClose}
      submitLabel={ti('inventory.transfer.form.send')}
      onSubmit={send}
      submitDisabled={!ready}
      hint={
        ready ? ti('inventory.transfer.form.stockLeaves') : ti('inventory.transfer.form.pickFirst')
      }
      size="lg"
      testId={testId}
    >
      <div>
        <p className="mb-2 text-small font-semibold text-text">
          {ti('inventory.transfer.form.store')}
        </p>
        {stores.length === 0 ? (
          <p className="text-body text-text-muted">{ti('inventory.transfer.form.noStores')}</p>
        ) : (
          <ChoiceList
            options={stores.map((store) => ({ value: store.id, label: store.name }))}
            value={draft.toStoreId}
            onChange={(toStoreId) => setDraft({ ...draft, toStoreId })}
            label={ti('inventory.transfer.form.store')}
            testId={`${testId}.store`}
          />
        )}
      </div>

      <div role="group" aria-label={ti('inventory.transfer.form.lines')}>
        <p className="mb-2 text-small font-semibold text-text">
          {ti('inventory.transfer.form.lines')}
        </p>
        <PartSearch
          label={ti('inventory.transfer.form.addPart')}
          picked={new Set(draft.lines.map((line) => line.itemId))}
          onPick={(item) => setDraft(addSendLine(draft, item))}
          testId={`${testId}.part`}
        />
        {draft.lines.length === 0 ? (
          <p className="mt-3 text-body text-text-muted">{ti('inventory.transfer.form.noParts')}</p>
        ) : (
          <ul className="mt-3 flex flex-col" data-testid={`${testId}.lines`}>
            {draft.lines.map((line) => (
              <li
                key={line.itemId}
                className="flex items-end gap-2 border-b border-border py-3 last:border-b-0"
                data-testid={`${testId}.line.${line.itemId}`}
              >
                <div className="min-w-0 flex-1">
                  {/* The part's name labels its count, so each row reads as one thing. */}
                  <QtyField
                    label={line.name}
                    value={line.qty}
                    onChange={(qty) => setDraft(setSendQty(draft, line.itemId, qty))}
                    min={1}
                    max={MAX_MOVEMENT_QTY}
                    hint={overStockHint(line, line.qty) ?? undefined}
                    testId={`${testId}.line.${line.itemId}.qty`}
                  />
                </div>
                <IconButton
                  icon={X}
                  label={`${ti('inventory.transfer.form.remove')} ${line.name}`}
                  onClick={() => setDraft(removeSendLine(draft, line.itemId))}
                  data-testid={`${testId}.line.${line.itemId}.remove`}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <TextArea
        label={ti('inventory.transfer.form.note')}
        value={draft.note}
        onChange={(event) => setDraft({ ...draft, note: event.target.value })}
        maxLength={MAX_TRANSFER_NOTE}
        rows={2}
        data-testid={`${testId}.note`}
      />
    </TaskDialog>
  );
}

export interface TransferTaskProps {
  readonly transfer: TransferDetailRow;
  readonly onClose: () => void;
  readonly onDone: () => void;
}

/** Terima kiriman: how many of each part came, starting at what is still to come. */
export function ReceiveTransferDialog({
  transfer,
  onClose,
  onDone,
}: TransferTaskProps): React.JSX.Element {
  const runtime = useInventoryRuntime();
  const runner = useActionRunner();
  const start = receiveStart(transfer);
  const [counts, setCounts] = useState(start);
  const [note, setNote] = useState('');
  const total = countTotal(counts);
  const testId = 'inventory.desk.receiveTransfer';
  const save = (): void => {
    void runner
      .run(() => runtime.run('receiveTransfer', receiveInput(transfer, counts, note)))
      .then((result) => {
        if (result !== undefined) onDone();
      });
  };
  return (
    <TaskDialog
      title={ti('inventory.transfer.receive.title')}
      description={transfer.transferNumber}
      runner={runner}
      dirty={JSON.stringify(counts) !== JSON.stringify(start) || note !== ''}
      discard={discardCopy()}
      onClose={onClose}
      submitLabel={ti('inventory.transfer.receive.save')}
      onSubmit={save}
      submitDisabled={total === 0}
      hint={total === 0 ? ti('inventory.transfer.receive.nothing') : null}
      size="md"
      testId={testId}
    >
      <p className="text-body text-text-muted">{ti('inventory.transfer.receive.hint')}</p>
      {receivableLines(transfer).map((line, index) => {
        const toCome = stillToCome(line);
        const count = counts[line.itemId] ?? 0;
        return (
          <QtyField
            key={line.itemId}
            label={line.name}
            value={count}
            onChange={(qty) => setCounts({ ...counts, [line.itemId]: qty })}
            max={toCome}
            autoFocus={index === 0}
            hint={
              count < toCome
                ? ti('inventory.transfer.detail.missing', { count: toCome - count })
                : undefined
            }
            testId={`${testId}.line.${line.itemId}`}
          />
        );
      })}
      <TextArea
        label={ti('inventory.transfer.receive.note')}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        maxLength={MAX_TRANSFER_NOTE}
        rows={2}
        data-testid={`${testId}.note`}
      />
    </TaskDialog>
  );
}

/**
 * Selesaikan kiriman: parts that never arrived go back on this store's shelf or are written off
 * with a reason; parts the other store recorded beyond what was sent are settled as arrived.
 */
export function SettleDialog({ transfer, onClose, onDone }: TransferTaskProps): React.JSX.Element {
  const runtime = useInventoryRuntime();
  const runner = useActionRunner();
  const start = settleStart(transfer);
  const [counts, setCounts] = useState<SettleCounts>(start);
  const [reason, setReason] = useState('');
  const over = settleMode(transfer) === 'over';
  const problem = settleProblem(transfer, counts, reason);
  const writesOff = Object.values(counts.lost).some((qty) => qty > 0);
  const testId = 'inventory.desk.settle';
  const set = (outcome: keyof SettleCounts, itemId: string, qty: number): void =>
    setCounts((now) => ({ ...now, [outcome]: { ...now[outcome], [itemId]: qty } }));
  const save = (): void => {
    void runner
      .run(() => runtime.run('settleTransfer', settleInput(transfer, counts, reason)))
      .then((result) => {
        if (result !== undefined) onDone();
      });
  };
  return (
    <TaskDialog
      title={ti('inventory.transfer.settle.title')}
      description={transfer.transferNumber}
      runner={runner}
      dirty={JSON.stringify(counts) !== JSON.stringify(start) || reason !== ''}
      discard={discardCopy()}
      onClose={onClose}
      submitLabel={ti('inventory.transfer.settle.save')}
      onSubmit={save}
      submitDisabled={problem !== null}
      hint={
        problem === null
          ? null
          : ti(
              problem === 'nothing'
                ? 'inventory.transfer.settle.nothing'
                : problem === 'tooMany'
                  ? 'inventory.transfer.settle.tooMany'
                  : 'inventory.transfer.settle.needReason',
            )
      }
      size="md"
      testId={testId}
    >
      <p className="text-body text-text-muted">
        {ti(over ? 'inventory.transfer.settle.hintOver' : 'inventory.transfer.settle.hintMissing')}
      </p>
      {settleLines(transfer).map((line) => {
        const open = over ? -line.missing : line.missing;
        const back = counts.back[line.itemId] ?? 0;
        const lost = counts.lost[line.itemId] ?? 0;
        return (
          <div
            key={line.itemId}
            role="group"
            aria-label={line.name}
            className="flex flex-col gap-2 border-b border-border pb-4 last:border-b-0"
            data-testid={`${testId}.line.${line.itemId}`}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="min-w-0 text-body font-semibold text-text">{line.name}</span>
              <span className="tabular text-small text-warning">
                {ti(over ? 'inventory.transfer.settle.over' : 'inventory.transfer.settle.open', {
                  count: open,
                })}
              </span>
            </div>
            {over ? (
              <QtyField
                label={ti('inventory.transfer.settle.arrived')}
                value={counts.arrived[line.itemId] ?? 0}
                onChange={(qty) => set('arrived', line.itemId, qty)}
                max={open}
                testId={`${testId}.line.${line.itemId}.arrived`}
              />
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <QtyField
                  label={ti('inventory.transfer.settle.back')}
                  value={back}
                  onChange={(qty) => set('back', line.itemId, qty)}
                  max={open - lost}
                  testId={`${testId}.line.${line.itemId}.back`}
                />
                <QtyField
                  label={ti('inventory.transfer.settle.lost')}
                  value={lost}
                  onChange={(qty) => set('lost', line.itemId, qty)}
                  max={open - back}
                  testId={`${testId}.line.${line.itemId}.lost`}
                />
              </div>
            )}
          </div>
        );
      })}
      {/* Asked for only once something is written off: the reason is for the write-off. */}
      {over || !writesOff ? null : (
        <TextArea
          label={ti('inventory.transfer.settle.reason')}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={MAX_TRANSFER_NOTE}
          rows={2}
          data-testid={`${testId}.reason`}
        />
      )}
    </TaskDialog>
  );
}
