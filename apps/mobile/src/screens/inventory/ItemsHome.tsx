/**
 * ItemsHome — the Barang place at the shell's Barang tab: the store's stock and, as further
 * sections, Belanja for whoever buys from suppliers and Kiriman for whoever sends or receives parts
 * between stores. Every section stays mounted, so a filter or a half-written order or send is still
 * there after a look at another one. While a section has something
 * open it publishes its back to the shell, so hardware back closes it and the tabs step aside.
 */
import {
  InventoryRuntimeProvider,
  PartsSurface,
  TransfersSurface,
  ti,
  type InventoryRuntime,
} from '@bolusi/modules/inventory/screens';
import { opensTransfers } from '@bolusi/modules/inventory';
import { opensPurchasing } from '@bolusi/modules/purchasing';
import {
  PurchasingRuntimeProvider,
  PurchasingSurface,
  tp,
  type PurchasingRuntime,
} from '@bolusi/modules/purchasing/screens';
import type { PartFilter } from '@bolusi/modules/inventory';
import type { OrderFilter } from '@bolusi/modules/purchasing';
import {
  usePlaceOpen,
  type DiscardGuard,
  type PlaceOpen,
  type PlaceStep,
} from '@bolusi/modules/screen-kit';
import { PlaceSections, space } from '@bolusi/ui';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import type { SurfaceNav } from '../../navigation/surface.js';

type Section = 'stock' | 'orders' | 'transfers';

/** What another place may open here: one stock view, or the orders. */
export type ItemsOpenTarget =
  | { readonly section: 'stock'; readonly stock: PartFilter }
  | { readonly section: 'orders'; readonly orders: OrderFilter };

export interface ItemsHomeProps {
  readonly inventory: InventoryRuntime;
  /** Belanja's runtime; its section shows only for whoever may buy. */
  readonly purchasing?: PurchasingRuntime | undefined;
  readonly syncChip: ReactNode;
  readonly avatar: ReactNode;
  readonly onOpenSyncStatus: () => void;
  /** Published while a section has something open; null on its list. */
  readonly onRegisterSurfaceNav?: ((nav: SurfaceNav | null) => void) | undefined;
  /** Another place asks to show something here; a new nonce is a new ask. */
  readonly open?: PlaceOpen<ItemsOpenTarget> | null | undefined;
}

export function ItemsHome({
  inventory,
  purchasing,
  syncChip,
  avatar,
  onOpenSyncStatus,
  onRegisterSurfaceNav,
  open = null,
}: ItemsHomeProps): React.JSX.Element {
  const buys = opensPurchasing(inventory, purchasing);
  const moves = opensTransfers(inventory);
  const [picked, setPicked] = useState<Section>('stock');
  // A section taken away (a grant changed) falls back to the stock.
  const section: Section =
    (picked === 'orders' && !buys) || (picked === 'transfers' && !moves) ? 'stock' : picked;
  const [steps, setSteps] = useState<Readonly<Record<Section, PlaceStep | null>>>({
    stock: null,
    orders: null,
    transfers: null,
  });
  const guards = useRef<Record<Section, DiscardGuard | null>>({
    stock: null,
    orders: null,
    transfers: null,
  });
  const registerStockStep = useCallback(
    (step: PlaceStep | null) => setSteps((all) => ({ ...all, stock: step })),
    [],
  );
  const registerOrdersStep = useCallback(
    (step: PlaceStep | null) => setSteps((all) => ({ ...all, orders: step })),
    [],
  );
  const registerTransfersStep = useCallback(
    (step: PlaceStep | null) => setSteps((all) => ({ ...all, transfers: step })),
    [],
  );
  const registerTransfersGuard = useCallback((guard: DiscardGuard | null) => {
    guards.current.transfers = guard;
  }, []);
  const registerStockGuard = useCallback((guard: DiscardGuard | null) => {
    guards.current.stock = guard;
  }, []);
  const registerOrdersGuard = useCallback((guard: DiscardGuard | null) => {
    guards.current.orders = guard;
  }, []);

  // An ask turns to its section and hands the section what to show.
  usePlaceOpen(open, (target) => setPicked(target.section));
  const showStock = useMemo(
    () =>
      open !== null && open.target.section === 'stock'
        ? { nonce: open.nonce, target: open.target.stock }
        : null,
    [open],
  );
  const showOrders = useMemo(
    () =>
      open !== null && open.target.section === 'orders'
        ? { nonce: open.nonce, target: open.target.orders }
        : null,
    [open],
  );

  const step = steps[section];
  useEffect(() => {
    if (step === null) {
      onRegisterSurfaceNav?.(null);
      return;
    }
    onRegisterSurfaceNav?.({
      handleBack: () => {
        step.back();
        return true;
      },
      requestLeave: (proceed) => {
        const guard = guards.current[section];
        if (guard === null) proceed();
        else guard(proceed);
      },
      listBeside: step.listBeside,
    });
  }, [step, section, onRegisterSurfaceNav]);
  useEffect(() => () => onRegisterSurfaceNav?.(null), [onRegisterSurfaceNav]);

  const options = [
    { value: 'stock' as const, label: ti('inventory.place.stock') },
    ...(buys ? [{ value: 'orders' as const, label: tp('purchasing.list.title') }] : []),
    ...(moves ? [{ value: 'transfers' as const, label: ti('inventory.transfer.section') }] : []),
  ];
  const sections =
    options.length > 1 ? (
      <View style={styles.sections}>
        <PlaceSections<Section>
          options={options}
          value={section}
          onChange={setPicked}
          testID="items.sections"
        />
      </View>
    ) : undefined;
  const title = ti('inventory.list.title');
  const place = useMemo(
    () => ({ title, sections, onOpenSyncStatus }),
    [title, sections, onOpenSyncStatus],
  );
  const chrome = useMemo(() => ({ syncChip, avatar }), [syncChip, avatar]);

  return (
    <InventoryRuntimeProvider runtime={inventory}>
      <View style={section === 'stock' ? styles.fill : styles.hidden}>
        <PartsSurface
          chrome={chrome}
          place={place}
          onRegisterPlaceStep={registerStockStep}
          onRegisterDiscardGuard={registerStockGuard}
          showStock={showStock}
        />
      </View>
      {buys && purchasing !== undefined ? (
        <PurchasingRuntimeProvider runtime={purchasing}>
          <View style={section === 'orders' ? styles.fill : styles.hidden}>
            <PurchasingSurface
              chrome={chrome}
              place={place}
              onRegisterPlaceStep={registerOrdersStep}
              onRegisterDiscardGuard={registerOrdersGuard}
              showOrders={showOrders}
            />
          </View>
        </PurchasingRuntimeProvider>
      ) : null}
      {moves ? (
        <View style={section === 'transfers' ? styles.fill : styles.hidden}>
          <TransfersSurface
            chrome={chrome}
            place={place}
            onRegisterPlaceStep={registerTransfersStep}
            onRegisterDiscardGuard={registerTransfersGuard}
          />
        </View>
      ) : null}
    </InventoryRuntimeProvider>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  hidden: { display: 'none' },
  sections: { marginBottom: space.md },
});
