/**
 * The owner's intake lists at the shell's `intakeOptions` route, reached from Settings. Like
 * `RepairHome` it binds the runtime provider and publishes the surface's back/leave to the shell, so
 * hardware back and a header tap go through an open list's discard confirm instead of dropping edits.
 */
import {
  IntakeOptionsScreen,
  RepairRuntimeProvider,
  type DiscardGuard,
  type RepairRuntime,
  type StepBack,
} from '@bolusi/modules/repair/screens';
import { useCallback, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

import type { SurfaceNav } from '../../navigation/surface.js';

export interface IntakeOptionsRouteProps {
  readonly runtime: RepairRuntime;
  readonly syncChip: ReactNode;
  readonly onClose: () => void;
  readonly onRegisterSurfaceNav?: ((nav: SurfaceNav | null) => void) | undefined;
}

export function IntakeOptionsRoute({
  runtime,
  syncChip,
  onClose,
  onRegisterSurfaceNav,
}: IntakeOptionsRouteProps): React.JSX.Element {
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
    <RepairRuntimeProvider runtime={runtime}>
      <IntakeOptionsScreen
        chrome={{ syncChip, avatar: null }}
        onClose={onClose}
        onRegisterDiscardGuard={registerDiscardGuard}
        onRegisterStepBack={registerStepBack}
      />
    </RepairRuntimeProvider>
  );
}
