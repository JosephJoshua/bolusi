/**
 * The parts list (`parts` route), opened from the account menu. Like `RepairSettingsRoute` it binds
 * the runtime provider and publishes the surface's back/leave to the shell, so hardware back closes
 * an open step or part first and a half-filled form asks before it is dropped.
 */
import {
  InventoryRuntimeProvider,
  PartsSurface,
  type InventoryRuntime,
} from '@bolusi/modules/inventory/screens';
import type { ReactNode } from 'react';

import type { SurfaceNav } from '../../navigation/surface.js';
import { useRouteSurfaceNav } from '../../navigation/useRouteSurfaceNav.js';

export interface PartsRouteProps {
  readonly runtime: InventoryRuntime;
  readonly syncChip: ReactNode;
  readonly onClose: () => void;
  readonly onRegisterSurfaceNav?: ((nav: SurfaceNav | null) => void) | undefined;
}

export function PartsRoute({
  runtime,
  syncChip,
  onClose,
  onRegisterSurfaceNav,
}: PartsRouteProps): React.JSX.Element {
  const { registerDiscardGuard, registerStepBack } = useRouteSurfaceNav(
    onClose,
    onRegisterSurfaceNav,
  );

  return (
    <InventoryRuntimeProvider runtime={runtime}>
      <PartsSurface
        chrome={{ syncChip, avatar: null }}
        onClose={onClose}
        onRegisterStepBack={registerStepBack}
        onRegisterDiscardGuard={registerDiscardGuard}
      />
    </InventoryRuntimeProvider>
  );
}
