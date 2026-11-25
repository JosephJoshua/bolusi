/**
 * PurchasingSurface — "Belanja": this store's orders to suppliers and everything reached from them
 * (an order, a new one or a draft being finished, picking its parts, receiving what arrived, the
 * suppliers, and for owners the suppliers' bills), as local navigation like PartsSurface. The order being written lives here, so a trip
 * to pick a part or add a supplier comes back to it. Back closes the open step first.
 */
import { EmptyState, ListDetail, useListDetailSplit } from '@bolusi/ui';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { DiscardGuard, StepBack } from '../../screen-kit/index.js';
import type { ScreenChrome } from '../../screen-kit/screens/views.js';
import { tp, type PurchasingKey } from '../i18n.js';
import { EMPTY_ORDER, addLine, draftChanged, draftOf, type OrderDraft } from '../order-form.js';
import type { OrderDetailRow, ReceiptCostRow, SupplierRow } from '../queries.js';
import { PriceStep } from './OrderCosts.js';
import {
  EMPTY_BILL,
  addBillLine,
  billDraftChanged,
  billDraftFromOrder,
  billDraftOf,
  type BelanjaTab,
  type BillDraft,
} from '../bills/bill-form.js';
import type { BillDetailRow } from '../bills/queries.js';
import { BillDetail, VoidBillStep } from './BillDetail.js';
import { BillForm } from './BillForm.js';
import { OrderDetail } from './OrderDetail.js';
import { OrderForm, PickPartStep } from './OrderForm.js';
import { OrderList } from './OrderList.js';
import { ReceiveStep } from './ReceiveStep.js';
import { SupplierForm, SupplierList } from './SupplierScreens.js';

/** The order form open: new, or a draft; what it started from tells a back press what it loses. */
interface Writing {
  readonly orderId?: string | undefined;
  readonly from: OrderDraft;
}

/** The bill form open: new (from an order, or on its own), or a bill being corrected. */
interface BillWriting {
  readonly billId?: string | undefined;
  /** Where back leads: the order it was opened from, or the list. */
  readonly orderId?: string | undefined;
  readonly from: BillDraft;
}

type View =
  | { readonly kind: 'list' }
  | { readonly kind: 'order'; readonly orderId: string }
  | { readonly kind: 'bill'; readonly billId: string }
  | { readonly kind: 'billForm' }
  | { readonly kind: 'billPick' }
  | { readonly kind: 'billVoid'; readonly bill: BillDetailRow }
  | { readonly kind: 'form' }
  | { readonly kind: 'pick' }
  | { readonly kind: 'formSupplier' }
  | { readonly kind: 'receive'; readonly order: OrderDetailRow }
  | { readonly kind: 'price'; readonly orderId: string; readonly line: ReceiptCostRow }
  | { readonly kind: 'suppliers' }
  | { readonly kind: 'supplier'; readonly supplier?: SupplierRow | undefined };

export interface PurchasingSurfaceProps {
  readonly chrome: ScreenChrome;
  readonly onClose: () => void;
  readonly onRegisterStepBack?: ((back: StepBack | null) => void) | undefined;
  readonly onRegisterDiscardGuard?: ((guard: DiscardGuard | null) => void) | undefined;
}

export function PurchasingSurface({
  chrome,
  onClose,
  onRegisterStepBack,
  onRegisterDiscardGuard,
}: PurchasingSurfaceProps): React.JSX.Element {
  const [view, setView] = useState<View>({ kind: 'list' });
  const [filter, setFilter] = useState<BelanjaTab>('open');
  const [notice, setNotice] = useState<PurchasingKey | null>(null);
  const [supplierNotice, setSupplierNotice] = useState<string | null>(null);
  const [writing, setWriting] = useState<Writing | null>(null);
  const [draft, setDraft] = useState<OrderDraft>(EMPTY_ORDER);
  const [billWriting, setBillWriting] = useState<BillWriting | null>(null);
  const [billDraft, setBillDraft] = useState<BillDraft>(EMPTY_BILL);
  const guardRef = useRef<DiscardGuard | null>(null);
  const registerGuard = useCallback(
    (guard: DiscardGuard | null): void => {
      guardRef.current = guard;
      onRegisterDiscardGuard?.(guard);
    },
    [onRegisterDiscardGuard],
  );

  const closeForm = useCallback((): void => {
    const to: View =
      writing?.orderId === undefined
        ? { kind: 'list' }
        : { kind: 'order', orderId: writing.orderId };
    setWriting(null);
    setView(to);
  }, [writing]);

  const closeBillForm = useCallback((): void => {
    const to: View =
      billWriting?.billId !== undefined
        ? { kind: 'bill', billId: billWriting.billId }
        : billWriting?.orderId !== undefined
          ? { kind: 'order', orderId: billWriting.orderId }
          : { kind: 'list' };
    setBillWriting(null);
    setView(to);
  }, [billWriting]);

  const back = useCallback((): boolean => {
    switch (view.kind) {
      case 'list':
        return false;
      case 'order':
      case 'bill':
      case 'suppliers':
        setView({ kind: 'list' });
        return true;
      case 'billForm': {
        const guard = guardRef.current;
        if (guard === null) closeBillForm();
        else guard(closeBillForm);
        return true;
      }
      case 'billPick':
        setView({ kind: 'billForm' });
        return true;
      case 'billVoid':
        setView({ kind: 'bill', billId: view.bill.id });
        return true;
      case 'form': {
        // A half-written order asks first, through the form's discard sheet.
        const guard = guardRef.current;
        if (guard === null) closeForm();
        else guard(closeForm);
        return true;
      }
      case 'pick':
      case 'formSupplier':
        setView({ kind: 'form' });
        return true;
      case 'receive':
        setView({ kind: 'order', orderId: view.order.id });
        return true;
      case 'price':
        setView({ kind: 'order', orderId: view.orderId });
        return true;
      case 'supplier':
        setView({ kind: 'suppliers' });
        return true;
    }
  }, [view, closeForm, closeBillForm]);

  useEffect(() => {
    onRegisterStepBack?.(back);
    return () => onRegisterStepBack?.(null);
  }, [back, onRegisterStepBack]);

  const openOrder = (orderId: string, done: PurchasingKey | null = null): void => {
    setNotice(done);
    setView({ kind: 'order', orderId });
  };
  const openBill = (billId: string, done: PurchasingKey | null = null): void => {
    setNotice(done);
    setView({ kind: 'bill', billId });
  };
  const writeBill = (writing: BillWriting): void => {
    setBillWriting(writing);
    setBillDraft(writing.from);
    setView({ kind: 'billForm' });
  };
  const write = (from: OrderDraft, orderId?: string): void => {
    setWriting({ orderId, from });
    setDraft(from);
    setView({ kind: 'form' });
  };

  // On a wide screen the list stays beside the open order. Writing or receiving an order is a task
  // of its own and keeps the whole screen, so a tap on the list never throws away a half-done one.
  const beside = view.kind === 'list' || view.kind === 'order' || view.kind === 'bill';
  const split = useListDetailSplit() && beside;
  // The list's header carries the sync chip and the avatar; the pane beside it keeps neither.
  const paneChrome: ScreenChrome = split ? { syncChip: null, avatar: null } : chrome;
  const openId = view.kind === 'order' ? view.orderId : view.kind === 'bill' ? view.billId : null;

  const list = (
    <OrderList
      chrome={chrome}
      filter={filter}
      onFilter={setFilter}
      onBack={onClose}
      onOpenOrder={(orderId) => {
        if (orderId !== openId) openOrder(orderId);
      }}
      onNewOrder={() => write(EMPTY_ORDER)}
      onOpenBill={(billId) => {
        if (billId !== openId) openBill(billId);
      }}
      onNewBill={() => writeBill({ from: EMPTY_BILL })}
      onOpenSuppliers={() => {
        setSupplierNotice(null);
        setView({ kind: 'suppliers' });
      }}
      selectedId={split ? openId : null}
    />
  );

  const detail =
    view.kind === 'order' ? (
      <OrderDetail
        key={view.orderId}
        orderId={view.orderId}
        chrome={paneChrome}
        hideBack={split}
        onBack={() => setView({ kind: 'list' })}
        onEdit={(order) => write(draftOf(order), order.id)}
        onReceive={(order) => setView({ kind: 'receive', order })}
        onNewBill={(order) => writeBill({ orderId: order.id, from: billDraftFromOrder(order) })}
        onOpenBill={(billId) => openBill(billId)}
        onPrice={(line) => setView({ kind: 'price', orderId: view.orderId, line })}
        notice={notice}
        onClearNotice={() => setNotice(null)}
      />
    ) : view.kind === 'bill' ? (
      <BillDetail
        key={view.billId}
        billId={view.billId}
        chrome={paneChrome}
        hideBack={split}
        onBack={() => setView({ kind: 'list' })}
        onEdit={(bill) => writeBill({ billId: bill.id, from: billDraftOf(bill, Date.now()) })}
        onVoid={(bill) => setView({ kind: 'billVoid', bill })}
        notice={notice}
        onClearNotice={() => setNotice(null)}
      />
    ) : split ? (
      <EmptyState
        title={tp(filter === 'bills' ? 'purchasing.bill.pickOne' : 'purchasing.list.pickOrder')}
        testID="purchasing.noOrderOpen"
      />
    ) : null;

  return (
    <ListDetail
      split={split}
      list={split || view.kind === 'list' ? list : null}
      detail={detail}
      testID="purchasing.split"
    >
      {beside ? null : fullScreen()}
    </ListDetail>
  );

  /** The tasks that keep the whole screen. */
  function fullScreen(): React.JSX.Element | null {
    switch (view.kind) {
      case 'list':
      case 'order':
      case 'bill':
        return null;
      case 'billForm':
        return (
          <BillForm
            chrome={chrome}
            billId={billWriting?.billId}
            draft={billDraft}
            onChange={setBillDraft}
            onPickPart={() => setView({ kind: 'billPick' })}
            onDone={(billId) => {
              const edited = billWriting?.billId !== undefined;
              setBillWriting(null);
              openBill(
                billId,
                edited ? 'purchasing.done.billSaved' : 'purchasing.done.billRecorded',
              );
            }}
            onCancel={closeBillForm}
            dirty={billWriting !== null && billDraftChanged(billDraft, billWriting.from)}
            onRegisterDiscardGuard={registerGuard}
          />
        );
      case 'billPick':
        return (
          <PickPartStep
            chrome={chrome}
            onOrder={new Set(billDraft.lines.map((line) => line.itemId))}
            onPick={(item) => {
              setBillDraft((now) => addBillLine(now, item));
              setView({ kind: 'billForm' });
            }}
            onCancel={() => setView({ kind: 'billForm' })}
          />
        );
      case 'billVoid':
        return (
          <VoidBillStep
            chrome={chrome}
            bill={view.bill}
            onDone={() => openBill(view.bill.id, 'purchasing.done.billVoided')}
            onCancel={() => setView({ kind: 'bill', billId: view.bill.id })}
          />
        );
      case 'receive':
        return (
          <ReceiveStep
            chrome={chrome}
            order={view.order}
            onDone={() => openOrder(view.order.id, 'purchasing.done.received')}
            onCancel={() => setView({ kind: 'order', orderId: view.order.id })}
          />
        );
      case 'price':
        return (
          <PriceStep
            chrome={chrome}
            line={view.line}
            onDone={() => openOrder(view.orderId, 'purchasing.done.priced')}
            onCancel={() => setView({ kind: 'order', orderId: view.orderId })}
          />
        );
      case 'form':
        return (
          <OrderForm
            chrome={chrome}
            orderId={writing?.orderId}
            draft={draft}
            onChange={setDraft}
            onPickPart={() => setView({ kind: 'pick' })}
            onAddSupplier={() => setView({ kind: 'formSupplier' })}
            onDone={(orderId, placed) => {
              setWriting(null);
              openOrder(orderId, placed ? 'purchasing.done.placed' : 'purchasing.done.drafted');
            }}
            onCancel={closeForm}
            dirty={writing !== null && draftChanged(draft, writing.from)}
            onRegisterDiscardGuard={registerGuard}
          />
        );
      case 'pick':
        return (
          <PickPartStep
            chrome={chrome}
            onOrder={new Set(draft.lines.map((line) => line.itemId))}
            onPick={(item) => {
              setDraft((now) => addLine(now, item));
              setView({ kind: 'form' });
            }}
            onCancel={() => setView({ kind: 'form' })}
          />
        );
      case 'formSupplier':
        return (
          <SupplierForm
            chrome={chrome}
            onDone={(supplierId) => {
              setDraft((now) => ({ ...now, supplierId }));
              setView({ kind: 'form' });
            }}
            onCancel={() => setView({ kind: 'form' })}
          />
        );
      case 'suppliers':
        return (
          <SupplierList
            chrome={chrome}
            onBack={() => setView({ kind: 'list' })}
            onOpen={(supplier) => setView({ kind: 'supplier', supplier })}
            onAdd={() => setView({ kind: 'supplier' })}
            notice={supplierNotice}
            onClearNotice={() => setSupplierNotice(null)}
          />
        );
      case 'supplier':
        return (
          <SupplierForm
            chrome={chrome}
            supplier={view.supplier}
            onDone={() => {
              setSupplierNotice(tp('purchasing.done.supplierSaved'));
              setView({ kind: 'suppliers' });
            }}
            onCancel={() => setView({ kind: 'suppliers' })}
          />
        );
    }
  }
}
