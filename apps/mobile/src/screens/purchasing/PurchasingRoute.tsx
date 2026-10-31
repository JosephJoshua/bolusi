/**
 * "Belanja" (`purchasing` route), opened from the account menu: orders to suppliers. Like
 * `PartsRoute` it binds the runtime providers (the parts list too, to pick what to order) and
 * publishes the surface's back/leave to the shell, so hardware back closes an open step first and
 * a half-written order asks before it is dropped.
 */
import { InventoryRuntimeProvider, type InventoryRuntime } from '@bolusi/modules/inventory/screens';
import {
  PurchasingRuntimeProvider,
  PurchasingSurface,
  type PurchasingRuntime,
} from '@bolusi/modules/purchasing/screens';
import type { ReactNode } from 'react';

import type { SurfaceNav } from '../../navigation/surface.js';
import { useRouteSurfaceNav } from '../../navigation/useRouteSurfaceNav.js';

export interface PurchasingRouteProps {
  readonly runtime: PurchasingRuntime;
  readonly inventory: InventoryRuntime;
  readonly syncChip: ReactNode;
  readonly onClose: () => void;
  readonly onRegisterSurfaceNav?: ((nav: SurfaceNav | null) => void) | undefined;
}

export function PurchasingRoute({
  runtime,
  inventory,
  syncChip,
  onClose,
  onRegisterSurfaceNav,
}: PurchasingRouteProps): React.JSX.Element {
  const { registerDiscardGuard, registerStepBack } = useRouteSurfaceNav(
    onClose,
    onRegisterSurfaceNav,
  );
  return (
    <InventoryRuntimeProvider runtime={inventory}>
      <PurchasingRuntimeProvider runtime={runtime}>
        <PurchasingSurface
          chrome={{ syncChip, avatar: null }}
          onClose={onClose}
          onRegisterStepBack={registerStepBack}
          onRegisterDiscardGuard={registerDiscardGuard}
        />
      </PurchasingRuntimeProvider>
    </InventoryRuntimeProvider>
  );
}
