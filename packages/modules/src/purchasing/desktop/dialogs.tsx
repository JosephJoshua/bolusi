// Buying's tasks on the counter PC, each a dialog over the orders: write or finish an order, receive
// what came, and keep the suppliers. The rules and the form's state are the phone's (`order-form`).
import { formatPhone, t } from '@bolusi/i18n';
import {
  Button,
  ChoiceList,
  Dialog,
  IconButton,
  SearchField,
  Tabs,
  TextArea,
  TextField,
} from '@bolusi/ui-web';
import { ChevronRight, Plus, X } from 'lucide-react';
import { useState } from 'react';

import { useActionRunner, useSettledValue } from '../../screen-kit/index.js';
import { QueryPanel, TaskDialog, type DiscardCopy } from '../../screen-kit/desktop/index.js';
import { QtyField } from '../../inventory/desktop/fields.js';
import { stockText } from '../../inventory/labels.js';
import type { ItemRow } from '../../inventory/queries.js';
import { useInventoryQuery, useInventoryRuntime } from '../../inventory/runtime.js';
import {
  MAX_LINE_QTY,
  MAX_PURCHASING_NOTE,
  MAX_SUPPLIER_NAME,
  MAX_SUPPLIER_PHONE,
} from '../constants.js';
import { tp } from '../i18n.js';
import {
  EMPTY_ORDER,
  addLine,
  canSave,
  draftChanged,
  draftOf,
  orderInput,
  receiveHint,
  receiveInput,
  receiveStart,
  receivedTotal,
  removeLine,
  setQty,
  type OrderDraft,
} from '../order-form.js';
import type { OrderDetailRow, SupplierRow } from '../queries.js';
import { usePurchasingQuery, usePurchasingRuntime } from '../runtime.js';

function discardCopy(): DiscardCopy {
  return {
    title: tp('purchasing.discard.title'),
    message: tp('purchasing.discard.message'),
    confirm: tp('purchasing.discard.confirm'),
    keep: tp('purchasing.discard.keep'),
  };
}

const PICK_LIMIT = 8;

export interface OrderDialogProps {
  /** The draft being finished; absent for a new order. */
  readonly order?: OrderDetailRow | undefined;
  readonly onClose: () => void;
  /** Saved: placed, or kept as a draft. */
  readonly onDone: (orderId: string, placed: boolean) => void;
}

/**
 * Pesanan baru, or a draft finished: the supplier, the parts and how many of each, and a note for
 * the supplier. "Pesan" places it; "Simpan draf" keeps it to finish later.
 */
export function OrderDialog({ order, onClose, onDone }: OrderDialogProps): React.JSX.Element {
  const runtime = usePurchasingRuntime();
  const runner = useActionRunner();
  const start = order === undefined ? EMPTY_ORDER : draftOf(order);
  const [draft, setDraft] = useState<OrderDraft>(start);
  const [addingSupplier, setAddingSupplier] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const testId = 'purchasing.desk.form';
  const suppliers = usePurchasingQuery(
    async (rt) => (await rt.query('listSuppliers', { text: '', includeArchived: false })).rows,
    `desk.form.suppliers:${String(reloadNonce)}`,
  );

  const save = (place: boolean): void => {
    void runner
      .run(async () =>
        order === undefined
          ? (await runtime.run('draftOrder', orderInput(draft, place))).orderId
          : (await runtime.run('editOrder', { orderId: order.id, ...orderInput(draft, place) }))
              .orderId,
      )
      .then((orderId) => {
        if (orderId !== undefined) onDone(orderId, place);
      });
  };
  const ready = canSave(draft);

  return (
    <>
      <TaskDialog
        title={tp(order === undefined ? 'purchasing.form.newTitle' : 'purchasing.form.editTitle')}
        description={order?.orderNumber}
        runner={runner}
        dirty={draftChanged(draft, start)}
        discard={discardCopy()}
        onClose={onClose}
        submitLabel={tp('purchasing.action.place')}
        onSubmit={() => save(true)}
        submitDisabled={!ready}
        hint={ready ? null : tp('purchasing.form.pickFirst')}
        secondary={{
          label: tp('purchasing.action.saveDraft'),
          onClick: () => save(false),
          testId: `${testId}.saveDraft`,
        }}
        size="lg"
        testId={testId}
      >
        <div>
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-small font-semibold text-text">{tp('purchasing.form.supplier')}</p>
            <Button
              label={tp('purchasing.supplier.add')}
              variant="text"
              size="sm"
              icon={Plus}
              className="-my-1"
              onClick={() => setAddingSupplier(true)}
              data-testid={`${testId}.addSupplier`}
            />
          </div>
          <QueryPanel query={suppliers} onRetry={() => setReloadNonce((n) => n + 1)}>
            {(rows) =>
              rows.length === 0 ? (
                <p className="text-body text-text-muted">{tp('purchasing.form.noSuppliers')}</p>
              ) : (
                <ChoiceList
                  options={rows.map((row) => ({
                    value: row.id,
                    label:
                      row.phone === null ? row.name : `${row.name} · ${formatPhone(row.phone)}`,
                  }))}
                  value={draft.supplierId}
                  onChange={(supplierId) => setDraft({ ...draft, supplierId })}
                  label={tp('purchasing.form.supplier')}
                  testId={`${testId}.supplier`}
                />
              )
            }
          </QueryPanel>
        </div>

        <div role="group" aria-label={tp('purchasing.order.lines')}>
          <p className="mb-2 text-small font-semibold text-text">{tp('purchasing.order.lines')}</p>
          <PartSearch
            onOrder={new Set(draft.lines.map((line) => line.itemId))}
            onPick={(item) => setDraft(addLine(draft, item))}
            testId={`${testId}.part`}
          />
          {draft.lines.length === 0 ? (
            <p className="mt-3 text-body text-text-muted">{tp('purchasing.form.noParts')}</p>
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
                      onChange={(qty) => setDraft(setQty(draft, line.itemId, qty))}
                      min={1}
                      max={MAX_LINE_QTY}
                      testId={`${testId}.line.${line.itemId}.qty`}
                    />
                  </div>
                  <IconButton
                    icon={X}
                    label={`${tp('purchasing.form.remove')} ${line.name}`}
                    onClick={() => setDraft(removeLine(draft, line.itemId))}
                    data-testid={`${testId}.line.${line.itemId}.remove`}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>

        <TextArea
          label={tp('purchasing.form.note')}
          value={draft.note}
          onChange={(event) => setDraft({ ...draft, note: event.target.value })}
          maxLength={MAX_PURCHASING_NOTE}
          rows={2}
          data-testid={`${testId}.note`}
        />
      </TaskDialog>
      {addingSupplier ? (
        <SupplierDialog
          onClose={() => setAddingSupplier(false)}
          onDone={(supplierId) => {
            setAddingSupplier(false);
            setDraft({ ...draft, supplierId });
          }}
        />
      ) : null}
    </>
  );
}

/**
 * Find a part to add: typing ranks the parts list, a click adds the part (one more when it is
 * already on the order). A USB scanner types a code and presses Enter, which adds the part it names.
 */
function PartSearch({
  onOrder,
  onPick,
  testId,
}: {
  readonly onOrder: ReadonlySet<string>;
  readonly onPick: (item: ItemRow) => void;
  readonly testId: string;
}): React.JSX.Element {
  const inventory = useInventoryRuntime();
  const [text, setText] = useState('');
  const [reloadNonce, setReloadNonce] = useState(0);
  const typed = text.trim();
  const settled = useSettledValue(typed);
  const searchText = typed === '' ? '' : settled;
  const query = useInventoryQuery(
    async (rt) =>
      searchText === ''
        ? []
        : (await rt.query('listItems', { text: searchText, filter: 'active', limit: PICK_LIMIT }))
            .rows,
    `desk.buyPick:${searchText}:${String(reloadNonce)}`,
  );
  const pick = (item: ItemRow): void => {
    onPick(item);
    setText('');
  };
  const pickCode = async (): Promise<void> => {
    const found = await inventory
      .query('findByCode', { code: typed })
      .then((page) => page.rows)
      .catch(() => []);
    const only = found.length === 1 ? found[0] : undefined;
    if (only !== undefined && !only.archived) pick(only);
  };
  return (
    <div
      onKeyDown={(event) => {
        if (event.key === 'Enter' && event.target instanceof HTMLInputElement && typed !== '') {
          event.preventDefault();
          void pickCode();
        }
      }}
    >
      <SearchField
        value={text}
        onChange={setText}
        placeholder={tp('purchasing.desk.addPart')}
        label={tp('purchasing.form.addPart')}
        clearLabel={tp('purchasing.pick.clear')}
        testId={`${testId}.search`}
      />
      {searchText === '' ? null : (
        <div className="mt-1 max-h-64 overflow-y-auto rounded-sm border border-border">
          <QueryPanel query={query} onRetry={() => setReloadNonce((n) => n + 1)}>
            {(rows) =>
              rows.length === 0 ? (
                <p className="px-3 py-4 text-center text-body text-text-muted">
                  {tp('purchasing.desk.noPartMatches')}
                </p>
              ) : (
                <ul>
                  {rows.map((row) => (
                    <li key={row.id}>
                      <button
                        type="button"
                        onClick={() => pick(row)}
                        className="flex w-full cursor-pointer items-center gap-3 border-b border-border px-3 py-2 text-left last:border-b-0 hover:bg-surface-alt focus-visible:bg-surface-alt focus-visible:outline-none"
                        data-testid={`${testId}.choice.${row.id}`}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block text-body font-semibold text-text">
                            {row.name}
                          </span>
                          {onOrder.has(row.id) ? (
                            <span className="block text-small text-text-muted">
                              {tp('purchasing.pick.onOrder')}
                            </span>
                          ) : row.code === null ? null : (
                            <span className="tabular block text-small text-text-muted">
                              {row.code}
                            </span>
                          )}
                        </span>
                        <span
                          className={
                            row.onHand < 0
                              ? 'tabular shrink-0 text-small font-semibold text-danger'
                              : 'tabular shrink-0 text-small text-text-muted'
                          }
                        >
                          {tp('purchasing.pick.stock', { count: stockText(row.onHand) })}
                        </span>
                        <Plus size={16} aria-hidden className="shrink-0 text-primary" />
                      </button>
                    </li>
                  ))}
                </ul>
              )
            }
          </QueryPanel>
        </div>
      )}
    </div>
  );
}

export interface ReceiveDialogProps {
  readonly order: OrderDetailRow;
  readonly onClose: () => void;
  readonly onDone: () => void;
}

/** Terima barang: how many of each part came, starting at what is still to come. */
export function ReceiveDialog({ order, onClose, onDone }: ReceiveDialogProps): React.JSX.Element {
  const runtime = usePurchasingRuntime();
  const runner = useActionRunner();
  const start = receiveStart(order);
  const [counts, setCounts] = useState(start);
  const [note, setNote] = useState('');
  const total = receivedTotal(counts);
  const save = (): void => {
    void runner
      .run(() => runtime.run('receiveOrder', receiveInput(order, counts, note)))
      .then((result) => {
        if (result !== undefined) onDone();
      });
  };
  return (
    <TaskDialog
      title={tp('purchasing.receive.title')}
      description={`${order.orderNumber} · ${order.supplierName}`}
      runner={runner}
      dirty={JSON.stringify(counts) !== JSON.stringify(start) || note !== ''}
      discard={discardCopy()}
      onClose={onClose}
      submitLabel={tp('purchasing.receive.save')}
      onSubmit={save}
      submitDisabled={total === 0}
      hint={total === 0 ? tp('purchasing.receive.nothing') : null}
      size="md"
      testId="purchasing.desk.receive"
    >
      {order.lines.map((line, index) => (
        <QtyField
          key={line.itemId}
          label={line.name}
          value={counts[line.itemId] ?? 0}
          onChange={(qty) => setCounts({ ...counts, [line.itemId]: qty })}
          max={MAX_LINE_QTY}
          autoFocus={index === 0}
          hint={receiveHint(line, counts[line.itemId] ?? 0)}
          testId={`purchasing.desk.receive.line.${line.itemId}`}
        />
      ))}
      <TextArea
        label={tp('purchasing.receive.note')}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        maxLength={MAX_PURCHASING_NOTE}
        rows={2}
        data-testid="purchasing.desk.receive.note"
      />
    </TaskDialog>
  );
}

export interface SupplierDialogProps {
  /** The supplier being changed; absent to add one. */
  readonly supplier?: SupplierRow | undefined;
  readonly onClose: () => void;
  readonly onDone: (supplierId: string) => void;
}

/** Add a supplier or change one: a name and the WhatsApp number orders go to. */
export function SupplierDialog({
  supplier,
  onClose,
  onDone,
}: SupplierDialogProps): React.JSX.Element {
  const runtime = usePurchasingRuntime();
  const runner = useActionRunner();
  const [name, setName] = useState(supplier?.name ?? '');
  const [phone, setPhone] = useState(supplier?.phone ?? '');
  const [note, setNote] = useState(supplier?.note ?? '');
  const details = { name: name.trim(), phone: phone.trim() || null, note: note.trim() || null };
  const from = {
    name: supplier?.name ?? '',
    phone: supplier?.phone ?? null,
    note: supplier?.note ?? null,
  };
  const changed =
    details.name !== from.name || details.phone !== from.phone || details.note !== from.note;
  const testId = 'purchasing.desk.supplierForm';

  const save = (archived: boolean): void => {
    void runner
      .run(async () =>
        supplier === undefined
          ? (await runtime.run('addSupplier', details)).supplierId
          : (await runtime.run('editSupplier', { supplierId: supplier.id, archived, ...details }))
              .supplierId,
      )
      .then((supplierId) => {
        if (supplierId !== undefined) onDone(supplierId);
      });
  };

  return (
    <TaskDialog
      title={tp(
        supplier === undefined ? 'purchasing.supplier.add' : 'purchasing.supplier.editTitle',
      )}
      runner={runner}
      dirty={changed}
      discard={discardCopy()}
      onClose={onClose}
      submitLabel={tp('purchasing.supplier.save')}
      onSubmit={() => save(supplier?.archived ?? false)}
      submitDisabled={details.name === '' || (supplier !== undefined && !changed)}
      hint={details.name === '' ? tp('purchasing.supplier.nameFirst') : null}
      secondary={
        supplier === undefined
          ? undefined
          : {
              label: tp(
                supplier.archived ? 'purchasing.supplier.restore' : 'purchasing.supplier.archive',
              ),
              onClick: () => save(!supplier.archived),
              testId: `${testId}.archive`,
            }
      }
      testId={testId}
    >
      <TextField
        label={tp('purchasing.supplier.name')}
        value={name}
        onChange={(event) => setName(event.target.value)}
        maxLength={MAX_SUPPLIER_NAME}
        autoFocus
        data-testid={`${testId}.name`}
      />
      <TextField
        label={tp('purchasing.supplier.phone')}
        value={phone}
        onChange={(event) => setPhone(event.target.value)}
        inputMode="tel"
        maxLength={MAX_SUPPLIER_PHONE}
        data-testid={`${testId}.phone`}
      />
      <TextArea
        label={tp('purchasing.supplier.note')}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        maxLength={MAX_PURCHASING_NOTE}
        rows={2}
        data-testid={`${testId}.note`}
      />
    </TaskDialog>
  );
}

type SupplierView = 'active' | 'archived';

/** The business's suppliers, the same for every store: open one to change it, or add one. */
export function SuppliersDialog({ onClose }: { readonly onClose: () => void }): React.JSX.Element {
  const [view, setView] = useState<SupplierView>('active');
  const [editing, setEditing] = useState<SupplierRow | 'new' | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const testId = 'purchasing.desk.suppliers';
  const query = usePurchasingQuery(
    async (rt) =>
      (
        await rt.query('listSuppliers', { text: '', includeArchived: view === 'archived' })
      ).rows.filter((row) => row.archived === (view === 'archived')),
    `desk.suppliers:${view}:${String(reloadNonce)}`,
  );
  return (
    <>
      <Dialog
        open={editing === null}
        onRequestClose={onClose}
        title={tp('purchasing.supplier.listTitle')}
        description={tp('purchasing.desk.suppliersHint')}
        closeLabel={t('core.action.close')}
        size="md"
        testId={testId}
        footer={
          <>
            <Button label={t('core.action.close')} onClick={onClose} />
            <Button
              label={tp('purchasing.supplier.add')}
              variant="primary"
              icon={Plus}
              onClick={() => setEditing('new')}
              data-testid={`${testId}.add`}
            />
          </>
        }
      >
        <Tabs<SupplierView>
          items={[
            { value: 'active', label: tp('purchasing.supplier.active') },
            { value: 'archived', label: tp('purchasing.supplier.archived') },
          ]}
          value={view}
          onChange={setView}
          label={tp('purchasing.supplier.listTitle')}
          testId={`${testId}.views`}
        />
        <div className="mt-2 min-h-40">
          <QueryPanel query={query} onRetry={() => setReloadNonce((n) => n + 1)}>
            {(rows) =>
              rows.length === 0 ? (
                <p className="py-6 text-center text-body text-text-muted">
                  {tp(
                    view === 'active'
                      ? 'purchasing.supplier.empty'
                      : 'purchasing.supplier.noArchived',
                  )}
                </p>
              ) : (
                <ul>
                  {rows.map((row) => (
                    <li key={row.id}>
                      <button
                        type="button"
                        onClick={() => setEditing(row)}
                        className="flex w-full cursor-pointer items-center gap-3 border-b border-border px-1 py-3 text-left last:border-b-0 hover:bg-surface-alt focus-visible:bg-surface-alt focus-visible:outline-none"
                        data-testid={`${testId}.row.${row.id}`}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block text-body font-semibold text-text">
                            {row.name}
                          </span>
                          {row.phone === null && row.note === null ? null : (
                            <span className="block text-small text-text-muted">
                              {[row.phone === null ? null : formatPhone(row.phone), row.note]
                                .filter((part) => part !== null)
                                .join(' · ')}
                            </span>
                          )}
                        </span>
                        <ChevronRight size={16} aria-hidden className="shrink-0 text-text-muted" />
                      </button>
                    </li>
                  ))}
                </ul>
              )
            }
          </QueryPanel>
        </div>
      </Dialog>
      {editing === null ? null : (
        <SupplierDialog
          supplier={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onDone={() => setEditing(null)}
        />
      )}
    </>
  );
}
