// Supplier bills on the counter PC, for whoever reads them: the bill open beside the Tagihan list,
// an order's bills in its pane, and the dialogs that record, correct or void one. The form's state
// and checks are the phone's (`bills/bill-form`).
import { formatDate, formatDateTime, formatMoney, formatPhone, t } from '@bolusi/i18n';
import {
  Banner,
  Button,
  Chip,
  ChoiceList,
  IconButton,
  Section,
  StatePanel,
  TextArea,
  TextField,
  ToggleChip,
  type ColumnDef,
} from '@bolusi/ui-web';
import { Ban, SearchX, X } from 'lucide-react';
import { useState } from 'react';

import { useActionRunner } from '../../screen-kit/index.js';
import { QueryPanel, TaskDialog } from '../../screen-kit/desktop/index.js';
import { QtyField } from '../../inventory/desktop/fields.js';
import { groupedRupiah, acceptsRupiahText } from '../../shared/rupiah.js';
import {
  MAX_BILL_CHARGES,
  MAX_LINE_QTY,
  MAX_PURCHASING_NOTE,
  MAX_SUPPLIER_REF,
  MAX_UNIT_PRICE,
} from '../constants.js';
import { tp, type PurchasingKey } from '../i18n.js';
import {
  BILL_TERMS,
  addBillLine,
  billDraftChanged,
  billDraftOf,
  billGap,
  billInput,
  billCheckKey,
  billLineHint,
  draftTotal,
  dueOnOf,
  dueText,
  linePrice,
  notaText,
  removeBillLine,
  setBillLine,
  type BillDraft,
  type BilledDay,
} from '../bills/bill-form.js';
import type { BillDetailRow, BillRow } from '../bills/queries.js';
import type { OrderDetailRow } from '../queries.js';
import { usePurchasingQuery, usePurchasingRuntime } from '../runtime.js';
import { PartSearch, discardCopy } from './dialogs.js';

// ── the Tagihan list ───────────────────────────────────────────────────────────────────────────

export function billColumns(): ColumnDef<BillRow, unknown>[] {
  return [
    {
      id: 'supplier',
      accessorFn: (row) => row.supplierName,
      header: tp('purchasing.bill.col.supplier'),
      meta: { track: 'minmax(220px, 3fr)' },
      cell: ({ row: { original: row } }) => (
        <span className="flex min-w-0 flex-col">
          <span className="text-body font-semibold text-text">{row.supplierName}</span>
          <span className="tabular text-small text-text-muted">{notaText(row)}</span>
        </span>
      ),
    },
    {
      id: 'bill',
      accessorFn: (row) => row.billNumber,
      header: tp('purchasing.bill.col.bill'),
      meta: { track: 'minmax(150px, 1fr)', fold: 1 },
      cell: ({ row: { original: row } }) => (
        <span className="flex min-w-0 flex-col">
          <span className="tabular whitespace-nowrap text-body text-text">{row.billNumber}</span>
          {row.orderNumber === null ? null : (
            <span className="tabular text-small text-text-muted">{row.orderNumber}</span>
          )}
        </span>
      ),
    },
    {
      id: 'due',
      accessorFn: (row) => row.dueOn,
      header: tp('purchasing.bill.col.due'),
      meta: { track: 'minmax(170px, 1fr)', fold: 2 },
      cell: ({ row: { original: row } }) =>
        row.status === 'void' ? (
          <Chip label={tp('purchasing.bill.statusVoid')} icon={Ban} tone="neutral" />
        ) : (
          <span className="tabular text-body text-text">
            {row.dueOn === null ? tp('purchasing.bill.noDue') : formatDate(row.dueOn)}
          </span>
        ),
    },
    {
      id: 'total',
      accessorFn: (row) => row.total,
      header: tp('purchasing.bill.col.total'),
      meta: { track: 'minmax(140px, auto)', align: 'end' },
      cell: ({ row: { original: row } }) => (
        <span
          className={
            row.status === 'void'
              ? 'tabular whitespace-nowrap text-body text-text-muted line-through'
              : 'tabular whitespace-nowrap text-body font-semibold text-text'
          }
        >
          {formatMoney(row.total)}
        </span>
      ),
    },
  ];
}

// ── one bill beside the list ───────────────────────────────────────────────────────────────────

export interface BillPaneProps {
  readonly billId: string;
  readonly onClose: () => void;
  readonly notice: PurchasingKey | null;
  readonly onClearNotice: () => void;
}

export function BillPane({
  billId,
  onClose,
  notice,
  onClearNotice,
}: BillPaneProps): React.JSX.Element {
  const [reloadNonce, setReloadNonce] = useState(0);
  const [task, setTask] = useState<'none' | 'edit' | 'void'>('none');
  const [done, setDone] = useState<PurchasingKey | null>(null);
  const query = usePurchasingQuery(
    async (rt) => (await rt.query('getBill', { billId })).rows[0],
    `desk.bill:${billId}:${String(reloadNonce)}`,
  );
  const bill = query.status === 'ready' ? query.data : undefined;
  const shown = done ?? notice;
  const testId = 'purchasing.desk.bill';
  const say = (key: PurchasingKey | null): void => {
    onClearNotice();
    setDone(key);
  };

  return (
    <section
      aria-label={bill?.billNumber ?? tp('purchasing.bill.tab')}
      data-testid={testId}
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
              <header className="flex flex-col gap-4 border-b border-border px-6 pb-4 pt-4">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <h2 className="text-title font-bold text-text">{row.supplierName}</h2>
                    <p className="tabular text-body text-text-muted">{row.billNumber}</p>
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
                    {row.status === 'void' ? (
                      <Chip label={tp('purchasing.bill.statusVoid')} icon={Ban} tone="neutral" />
                    ) : null}
                    <span className="text-small text-text-muted">{dueText(row)}</span>
                  </div>
                  {row.status === 'open' ? (
                    <Button
                      label={tp('purchasing.action.edit')}
                      onClick={() => {
                        say(null);
                        setTask('edit');
                      }}
                      data-testid={`${testId}.edit`}
                    />
                  ) : null}
                </div>
              </header>
              <div className="min-h-0 flex-1 overflow-y-auto">
                <div className="flex flex-col gap-8 px-6 pb-10 pt-4">
                  {shown === null ? null : (
                    <Banner
                      tone="success"
                      message={tp(shown)}
                      onDismiss={() => say(null)}
                      dismissLabel={t('core.action.close')}
                    />
                  )}
                  <BillBody bill={row} testId={testId} />
                  {row.status === 'open' ? (
                    <div>
                      <Button
                        label={tp('purchasing.bill.voidTitle')}
                        variant="dangerText"
                        className="-ml-3"
                        onClick={() => setTask('void')}
                        data-testid={`${testId}.void`}
                      />
                    </div>
                  ) : null}
                </div>
              </div>
            </>
          )
        }
      </QueryPanel>
      {bill === undefined ? null : task === 'edit' ? (
        <BillDialog
          bill={bill}
          start={null}
          onClose={() => setTask('none')}
          onDone={() => {
            setTask('none');
            setDone('purchasing.done.billSaved');
          }}
        />
      ) : task === 'void' ? (
        <VoidBillDialog
          bill={bill}
          onClose={() => setTask('none')}
          onDone={() => {
            setTask('none');
            setDone('purchasing.done.billVoided');
          }}
        />
      ) : null}
    </section>
  );
}

/** A bill's nota, parts with their checks, totals and history: the pane's body. */
function BillBody({
  bill,
  testId,
}: {
  readonly bill: BillDetailRow;
  readonly testId: string;
}): React.JSX.Element {
  const open = bill.status === 'open';
  const hints = bill.lines.map(billLineHint);
  const check = open ? billCheckKey(bill.lines) : null;
  return (
    <>
      <div className="flex flex-col gap-1">
        <p className="text-body text-text">{notaText(bill)}</p>
        {bill.orderNumber === null ? null : (
          <p className="tabular text-body text-text-muted">
            {tp('purchasing.bill.order', { number: bill.orderNumber })}
          </p>
        )}
        {bill.note === null ? null : <p className="text-body text-text">{bill.note}</p>}
        {open ? null : (
          <p className="text-body text-text-muted" data-testid={`${testId}.voided`}>
            {[
              bill.voidedAt === null
                ? null
                : bill.voidedByName === null
                  ? tp('purchasing.bill.voided', { date: formatDateTime(bill.voidedAt) })
                  : tp('purchasing.bill.voidedBy', {
                      name: bill.voidedByName,
                      date: formatDateTime(bill.voidedAt),
                    }),
              bill.voidReason,
            ]
              .filter((part) => part !== null)
              .join(' · ')}
          </p>
        )}
        {check === null ? null : (
          <p className="text-body text-warning" data-testid={`${testId}.check`}>
            {tp(check)}
          </p>
        )}
      </div>
      <Section title={tp('purchasing.bill.lines')} testId={`${testId}.lines`}>
        <ul>
          {bill.lines.map((line, i) => (
            <li
              key={line.itemId}
              className="flex items-baseline gap-4 border-b border-border py-2"
              data-testid={`${testId}.line.${line.itemId}`}
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-body text-text">{line.name}</span>
                <span className="tabular text-small text-text-muted">
                  {tp('purchasing.bill.linePrice', {
                    qty: line.qty,
                    price: formatMoney(line.unitPrice),
                  })}
                </span>
                {hints[i] === null ? null : (
                  <span className="text-small font-semibold text-warning">{hints[i]}</span>
                )}
              </span>
              <span className="tabular shrink-0 text-body text-text">
                {formatMoney(line.amount)}
              </span>
            </li>
          ))}
        </ul>
        <dl className="mt-2 flex flex-col gap-1">
          {bill.charges === 0 ? null : (
            <>
              <TotalLine label={tp('purchasing.bill.subtotal')} value={bill.total - bill.charges} />
              <TotalLine label={tp('purchasing.bill.charges')} value={bill.charges} />
            </>
          )}
          <TotalLine
            label={tp('purchasing.bill.total')}
            value={bill.total}
            strong
            struck={!open}
            testId={`${testId}.total`}
          />
        </dl>
      </Section>
      <p className="text-small text-text-muted">
        {bill.createdByName === null
          ? tp('purchasing.bill.recordedAt', { date: formatDate(bill.createdAt) })
          : tp('purchasing.bill.recorded', {
              name: bill.createdByName,
              date: formatDate(bill.createdAt),
            })}
      </p>
    </>
  );
}

function TotalLine({
  label,
  value,
  strong = false,
  struck = false,
  testId,
}: {
  readonly label: string;
  readonly value: number;
  readonly strong?: boolean;
  readonly struck?: boolean;
  readonly testId?: string;
}): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-4" data-testid={testId}>
      <dt className={strong ? 'text-body font-semibold text-text' : 'text-body text-text-muted'}>
        {label}
      </dt>
      <dd
        className={[
          'tabular whitespace-nowrap text-body',
          strong ? 'font-semibold text-text' : 'text-text',
          struck ? 'text-text-muted line-through' : '',
        ].join(' ')}
      >
        {formatMoney(value)}
      </dd>
    </div>
  );
}

// ── an order's bills, in its pane ──────────────────────────────────────────────────────────────

export function OrderBillsSection({
  order,
  onNewBill,
  testId,
}: {
  readonly order: OrderDetailRow;
  readonly onNewBill: () => void;
  readonly testId: string;
}): React.JSX.Element {
  const query = usePurchasingQuery(
    async (rt) => (await rt.query('listBills', { filter: 'open', orderId: order.id })).rows,
    `desk.orderBills:${order.id}`,
  );
  return (
    <Section
      title={tp('purchasing.bill.orderBills')}
      action={
        <Button
          label={tp('purchasing.bill.new')}
          variant="text"
          size="sm"
          className="-my-1"
          onClick={onNewBill}
          data-testid={`${testId}.new`}
        />
      }
      testId={testId}
    >
      <QueryPanel query={query} onRetry={() => undefined}>
        {(rows) =>
          rows.length === 0 ? (
            <p className="text-body text-text-muted">{tp('purchasing.bill.orderNoBills')}</p>
          ) : (
            <ul>
              {rows.map((row) => (
                <li
                  key={row.id}
                  className="flex items-baseline gap-4 border-b border-border py-2 last:border-b-0"
                  data-testid={`${testId}.row.${row.id}`}
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="tabular text-body text-text">
                      {row.billNumber} · {notaText(row)}
                    </span>
                    <span className="text-small text-text-muted">{dueText(row)}</span>
                  </span>
                  <span className="tabular shrink-0 text-body font-semibold text-text">
                    {formatMoney(row.total)}
                  </span>
                </li>
              ))}
            </ul>
          )
        }
      </QueryPanel>
    </Section>
  );
}

// ── the dialogs ────────────────────────────────────────────────────────────────────────────────

/** Rupiah typed as digits and shown grouped; a keystroke past `max` is not taken. */
function PriceField({
  label,
  value,
  onChange,
  max,
  testId,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (text: string) => void;
  readonly max: number;
  readonly testId: string;
}): React.JSX.Element {
  return (
    <TextField
      label={label}
      prefix={tp('purchasing.desk.currency')}
      inputMode="numeric"
      selectOnFocus
      inputClassName="tabular text-right"
      value={value}
      onChange={(event) => {
        const text = event.target.value;
        if (acceptsRupiahText(text, max)) onChange(groupedRupiah(text));
      }}
      data-testid={testId}
    />
  );
}

const DAYS: readonly BilledDay[] = ['today', 'yesterday', 'other'];
const DAY_KEY: Readonly<Record<BilledDay, PurchasingKey>> = {
  today: 'purchasing.bill.today',
  yesterday: 'purchasing.bill.yesterday',
  other: 'purchasing.bill.otherDay',
};

export interface BillDialogProps {
  /** The bill being corrected; null for a new one, which opens at `start`. */
  readonly bill?: BillDetailRow | undefined;
  readonly start: BillDraft | null;
  readonly onClose: () => void;
  readonly onDone: (billId: string) => void;
}

/** Catat tagihan, or a bill corrected: the supplier's nota, its parts and prices, and its terms. */
export function BillDialog({ bill, start, onClose, onDone }: BillDialogProps): React.JSX.Element {
  const runtime = usePurchasingRuntime();
  const runner = useActionRunner();
  const [from] = useState(() => start ?? billDraftOfBill(bill));
  const [draft, setDraft] = useState<BillDraft>(from);
  const [reloadNonce, setReloadNonce] = useState(0);
  const testId = 'purchasing.desk.billForm';
  const suppliers = usePurchasingQuery(
    async (rt) => (await rt.query('listSuppliers', { text: '', includeArchived: false })).rows,
    `desk.billForm.suppliers:${String(reloadNonce)}`,
  );
  const at = Date.now();
  const gap = billGap(draft, at);
  const due = dueOnOf(draft, at);

  const save = (): void => {
    if (gap !== null) return;
    const input = billInput(draft, at);
    void runner
      .run(async () =>
        bill === undefined
          ? (await runtime.run('recordBill', input)).billId
          : (await runtime.run('editBill', { billId: bill.id, ...input })).billId,
      )
      .then((billId) => {
        if (billId !== undefined) onDone(billId);
      });
  };

  return (
    <TaskDialog
      title={tp(bill === undefined ? 'purchasing.bill.newTitle' : 'purchasing.bill.editTitle')}
      description={bill?.billNumber ?? draft.orderNumber ?? undefined}
      runner={runner}
      dirty={billDraftChanged(draft, from)}
      discard={discardCopy()}
      onClose={onClose}
      submitLabel={tp('purchasing.bill.save')}
      onSubmit={save}
      submitDisabled={gap !== null}
      hint={gap === null ? null : tp(gap)}
      size="lg"
      testId={testId}
    >
      <div>
        <p className="mb-2 text-small font-semibold text-text">{tp('purchasing.bill.supplier')}</p>
        <QueryPanel query={suppliers} onRetry={() => setReloadNonce((n) => n + 1)}>
          {(rows) =>
            draft.orderId !== null ? (
              <p className="text-body text-text" data-testid={`${testId}.fromOrder`}>
                {rows.find((row) => row.id === draft.supplierId)?.name ?? ''}
              </p>
            ) : rows.length === 0 ? (
              <p className="text-body text-text-muted">{tp('purchasing.form.noSuppliers')}</p>
            ) : (
              <ChoiceList
                options={rows.map((row) => ({
                  value: row.id,
                  label: row.phone === null ? row.name : `${row.name} · ${formatPhone(row.phone)}`,
                }))}
                value={draft.supplierId}
                onChange={(supplierId) => setDraft({ ...draft, supplierId })}
                label={tp('purchasing.bill.supplier')}
                testId={`${testId}.supplier`}
              />
            )
          }
        </QueryPanel>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TextField
          label={tp('purchasing.bill.supplierRef')}
          value={draft.supplierRef}
          onChange={(event) => setDraft({ ...draft, supplierRef: event.target.value })}
          maxLength={MAX_SUPPLIER_REF}
          data-testid={`${testId}.supplierRef`}
        />
        <div role="group" aria-label={tp('purchasing.bill.billedOn')}>
          <p className="mb-2 text-small font-semibold text-text">
            {tp('purchasing.bill.billedOn')}
          </p>
          <div className="flex flex-wrap gap-2">
            {DAYS.map((day) => (
              <ToggleChip
                key={day}
                label={tp(DAY_KEY[day])}
                selected={draft.billedDay === day}
                onToggle={() => setDraft({ ...draft, billedDay: day })}
                testId={`${testId}.day.${day}`}
              />
            ))}
          </div>
          {draft.billedDay === 'other' ? (
            <div className="mt-2">
              <TextField
                label={tp('purchasing.bill.dateField')}
                value={draft.billedText}
                onChange={(event) => setDraft({ ...draft, billedText: event.target.value })}
                maxLength={10}
                data-testid={`${testId}.date`}
              />
            </div>
          ) : null}
        </div>
      </div>

      <div role="group" aria-label={tp('purchasing.bill.terms')}>
        <p className="mb-2 text-small font-semibold text-text">{tp('purchasing.bill.terms')}</p>
        <div className="flex flex-wrap items-center gap-2">
          {[...BILL_TERMS, 'other' as const].map((term) => (
            <ToggleChip
              key={String(term)}
              label={
                term === 0
                  ? tp('purchasing.bill.termNone')
                  : term === 'other'
                    ? tp('purchasing.bill.termOther')
                    : tp('purchasing.bill.termDays', { count: term })
              }
              selected={draft.term === term}
              onToggle={() => setDraft({ ...draft, term })}
              testId={`${testId}.term.${String(term)}`}
            />
          ))}
        </div>
        {draft.term === 'other' ? (
          <div className="mt-2 max-w-48">
            <TextField
              label={tp('purchasing.bill.termDaysField')}
              value={draft.termDays}
              inputMode="numeric"
              onChange={(event) =>
                setDraft({ ...draft, termDays: event.target.value.replace(/\D/g, '').slice(0, 3) })
              }
              data-testid={`${testId}.termDays`}
            />
          </div>
        ) : null}
        {due === null ? null : (
          <p className="mt-2 text-small text-text-muted" data-testid={`${testId}.due`}>
            {dueText({ dueOn: due })}
          </p>
        )}
      </div>

      <div role="group" aria-label={tp('purchasing.bill.lines')}>
        <p className="mb-2 text-small font-semibold text-text">{tp('purchasing.bill.lines')}</p>
        <PartSearch
          onOrder={new Set(draft.lines.map((line) => line.itemId))}
          onPick={(item) => setDraft(addBillLine(draft, item))}
          testId={`${testId}.part`}
        />
        {draft.lines.length === 0 ? (
          <p className="mt-3 text-body text-text-muted">{tp('purchasing.form.noParts')}</p>
        ) : (
          <ul className="mt-3 flex flex-col" data-testid={`${testId}.lines`}>
            {draft.lines.map((line) => {
              const price = linePrice(line);
              return (
                <li
                  key={line.itemId}
                  className="flex flex-col gap-1 border-b border-border py-3 last:border-b-0"
                  data-testid={`${testId}.line.${line.itemId}`}
                >
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 text-body font-semibold text-text">
                      {line.name}
                    </span>
                    <IconButton
                      icon={X}
                      label={`${tp('purchasing.form.remove')} ${line.name}`}
                      onClick={() => setDraft(removeBillLine(draft, line.itemId))}
                      data-testid={`${testId}.line.${line.itemId}.remove`}
                    />
                  </div>
                  <div className="flex flex-wrap items-end gap-3">
                    <div className="w-40">
                      <QtyField
                        label={tp('purchasing.form.qty')}
                        value={line.qty}
                        onChange={(qty) => setDraft(setBillLine(draft, line.itemId, { qty }))}
                        min={1}
                        max={MAX_LINE_QTY}
                        testId={`${testId}.line.${line.itemId}.qty`}
                      />
                    </div>
                    <div className="w-52">
                      <PriceField
                        label={tp('purchasing.bill.price')}
                        value={line.price}
                        onChange={(text) =>
                          setDraft(setBillLine(draft, line.itemId, { price: text }))
                        }
                        max={MAX_UNIT_PRICE}
                        testId={`${testId}.line.${line.itemId}.price`}
                      />
                    </div>
                    <span className="tabular ml-auto pb-2 text-body text-text">
                      {price === null ? '' : formatMoney(line.qty * price)}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <PriceField
          label={tp('purchasing.bill.charges')}
          value={draft.charges}
          onChange={(charges) => setDraft({ ...draft, charges })}
          max={MAX_BILL_CHARGES}
          testId={`${testId}.charges`}
        />
        <div className="flex items-end justify-between gap-4 pb-2" data-testid={`${testId}.total`}>
          <span className="text-body font-semibold text-text">{tp('purchasing.bill.total')}</span>
          <span className="tabular text-title font-bold text-text">
            {formatMoney(draftTotal(draft))}
          </span>
        </div>
      </div>

      <TextArea
        label={tp('purchasing.bill.note')}
        value={draft.note}
        onChange={(event) => setDraft({ ...draft, note: event.target.value })}
        maxLength={MAX_PURCHASING_NOTE}
        rows={2}
        data-testid={`${testId}.note`}
      />
    </TaskDialog>
  );
}

function billDraftOfBill(bill: BillDetailRow | undefined): BillDraft {
  if (bill === undefined) throw new Error('BillDialog needs a bill or a start');
  return billDraftOf(bill, Date.now());
}

/** Batalkan tagihan: one entered by mistake, with why. It stays in the history. */
export function VoidBillDialog({
  bill,
  onClose,
  onDone,
}: {
  readonly bill: BillDetailRow;
  readonly onClose: () => void;
  readonly onDone: () => void;
}): React.JSX.Element {
  const runtime = usePurchasingRuntime();
  const runner = useActionRunner();
  const [reason, setReason] = useState('');
  const testId = 'purchasing.desk.voidBill';
  return (
    <TaskDialog
      title={tp('purchasing.bill.voidTitle')}
      description={`${bill.billNumber} · ${formatMoney(bill.total)}`}
      runner={runner}
      dirty={reason.trim() !== ''}
      discard={discardCopy()}
      onClose={onClose}
      submitLabel={tp('purchasing.bill.voidConfirm')}
      destructive
      onSubmit={() => {
        void runner
          .run(() => runtime.run('voidBill', { billId: bill.id, reason }))
          .then((result) => {
            if (result !== undefined) onDone();
          });
      }}
      submitDisabled={reason.trim() === ''}
      hint={reason.trim() === '' ? tp('purchasing.bill.voidReasonFirst') : null}
      size="sm"
      testId={testId}
    >
      <p className="text-body text-text-muted">{tp('purchasing.bill.voidHint')}</p>
      <TextArea
        label={tp('purchasing.bill.voidReason')}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        maxLength={MAX_PURCHASING_NOTE}
        rows={2}
        data-testid={`${testId}.reason`}
      />
    </TaskDialog>
  );
}
