/**
 * PurchasingSurface — "Belanja": this store's orders to suppliers and everything reached from them
 * (an order, a new one or a draft being finished, picking its parts, receiving what arrived, the
 * suppliers), as local navigation like PartsSurface. The order being written lives here, so a trip
 * to pick a part or add a supplier comes back to it. Back closes the open step first.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { DiscardGuard, StepBack } from '../../screen-kit/index.js';
import type { ScreenChrome } from '../../screen-kit/screens/views.js';
import { tp, type PurchasingKey } from '../i18n.js';
import { EMPTY_ORDER, addLine, draftChanged, draftOf, type OrderDraft } from '../order-form.js';
import type { OrderDetailRow, OrderFilter, SupplierRow } from '../queries.js';
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

type View =
  | { readonly kind: 'list' }
  | { readonly kind: 'order'; readonly orderId: string }
  | { readonly kind: 'form' }
  | { readonly kind: 'pick' }
  | { readonly kind: 'formSupplier' }
  | { readonly kind: 'receive'; readonly order: OrderDetailRow }
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
  const [filter, setFilter] = useState<OrderFilter>('open');
  const [notice, setNotice] = useState<PurchasingKey | null>(null);
  const [supplierNotice, setSupplierNotice] = useState<string | null>(null);
  const [writing, setWriting] = useState<Writing | null>(null);
  const [draft, setDraft] = useState<OrderDraft>(EMPTY_ORDER);
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

  const back = useCallback((): boolean => {
    switch (view.kind) {
      case 'list':
        return false;
      case 'order':
      case 'suppliers':
        setView({ kind: 'list' });
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
      case 'supplier':
        setView({ kind: 'suppliers' });
        return true;
    }
  }, [view, closeForm]);

  useEffect(() => {
    onRegisterStepBack?.(back);
    return () => onRegisterStepBack?.(null);
  }, [back, onRegisterStepBack]);

  const openOrder = (orderId: string, done: PurchasingKey | null = null): void => {
    setNotice(done);
    setView({ kind: 'order', orderId });
  };
  const write = (from: OrderDraft, orderId?: string): void => {
    setWriting({ orderId, from });
    setDraft(from);
    setView({ kind: 'form' });
  };

  switch (view.kind) {
    case 'list':
      return (
        <OrderList
          chrome={chrome}
          filter={filter}
          onFilter={setFilter}
          onBack={onClose}
          onOpenOrder={(orderId) => openOrder(orderId)}
          onNewOrder={() => write(EMPTY_ORDER)}
          onOpenSuppliers={() => {
            setSupplierNotice(null);
            setView({ kind: 'suppliers' });
          }}
        />
      );
    case 'order':
      return (
        <OrderDetail
          orderId={view.orderId}
          chrome={chrome}
          onBack={() => setView({ kind: 'list' })}
          onEdit={(order) => write(draftOf(order), order.id)}
          onReceive={(order) => setView({ kind: 'receive', order })}
          notice={notice}
          onClearNotice={() => setNotice(null)}
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
    case 'receive':
      return (
        <ReceiveStep
          chrome={chrome}
          order={view.order}
          onDone={() => openOrder(view.order.id, 'purchasing.done.received')}
          onCancel={() => setView({ kind: 'order', orderId: view.order.id })}
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
