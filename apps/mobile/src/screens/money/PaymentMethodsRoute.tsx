/**
 * The store's payment methods (`paymentMethods` route), opened from Settings. Like `PartsRoute` it
 * binds the runtime provider and publishes the surface's back/leave to the shell, so hardware back
 * closes an open form first and a half-filled one asks before it is dropped.
 */
import {
  MoneyRuntimeProvider,
  PaymentMethodsSurface,
  type MoneyRuntime,
} from '@bolusi/modules/money/screens';
import type { ReactNode } from 'react';

import type { SurfaceNav } from '../../navigation/surface.js';
import { useRouteSurfaceNav } from '../../navigation/useRouteSurfaceNav.js';

export interface PaymentMethodsRouteProps {
  readonly runtime: MoneyRuntime;
  readonly syncChip: ReactNode;
  readonly onClose: () => void;
  readonly onRegisterSurfaceNav?: ((nav: SurfaceNav | null) => void) | undefined;
}

export function PaymentMethodsRoute({
  runtime,
  syncChip,
  onClose,
  onRegisterSurfaceNav,
}: PaymentMethodsRouteProps): React.JSX.Element {
  const { registerDiscardGuard, registerStepBack } = useRouteSurfaceNav(
    onClose,
    onRegisterSurfaceNav,
  );

  return (
    <MoneyRuntimeProvider runtime={runtime}>
      <PaymentMethodsSurface
        chrome={{ syncChip, avatar: null }}
        onClose={onClose}
        onRegisterStepBack={registerStepBack}
        onRegisterDiscardGuard={registerDiscardGuard}
      />
    </MoneyRuntimeProvider>
  );
}
