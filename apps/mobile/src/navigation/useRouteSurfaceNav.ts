/**
 * The back/leave a one-route module surface (a settings page, the parts list) publishes to the
 * shell: hardware back runs the surface's own step back first, then leaves through its discard guard
 * to `onClose`; a header-chrome tap leaves through the same guard. The surface registers its guard
 * and step back through the two callbacks this returns.
 */
import type { DiscardGuard, StepBack } from '@bolusi/modules/screen-kit';
import { useCallback, useEffect, useRef } from 'react';

import type { SurfaceNav } from './surface.js';

export interface RouteSurfaceNav {
  readonly registerDiscardGuard: (guard: DiscardGuard | null) => void;
  readonly registerStepBack: (back: StepBack | null) => void;
}

export function useRouteSurfaceNav(
  onClose: () => void,
  onRegisterSurfaceNav: ((nav: SurfaceNav | null) => void) | undefined,
): RouteSurfaceNav {
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

  return { registerDiscardGuard, registerStepBack };
}
