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
import type { DiscardGuard, StepBack } from '@bolusi/modules/screen-kit';
import { useCallback, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

import type { SurfaceNav } from '../../navigation/surface.js';

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
  const discardGuardRef = useRef<DiscardGuard | null>(null);
  const registerDiscardGuard = useCallback((guard: DiscardGuard | null): void => {
    discardGuardRef.current = guard;
  }, []);
  const stepBackRef = useRef<StepBack | null>(null);
  const registerStepBack = useCallback((back: StepBack | null): void => {
    stepBackRef.current = back;
  }, []);

  useEffect(() => {
    const runLeave = (proceed: () => void): void => {
      const guard = discardGuardRef.current;
      if (guard !== null) guard(proceed);
      else proceed();
    };
    onRegisterSurfaceNav?.({
      handleBack: () => {
        if (stepBackRef.current?.() === true) return true;
        runLeave(onClose);
        return true;
      },
      requestLeave: runLeave,
    });
    return () => onRegisterSurfaceNav?.(null);
  }, [onClose, onRegisterSurfaceNav]);

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
