/**
 * The repair settings reached from Settings: the intake lists (`intakeOptions` route), the
 * cancellation fees (`cancelFees`), when a phone left in the store is flagged (`uncollectedDays`),
 * what the slips print (`printSettings`), and this phone's paper
 * (`printPaper`, anyone who prints). Like `RepairHome` it binds the runtime provider and publishes the
 * surface's back/leave to the shell, so hardware back and a header tap go through the screen's
 * discard confirm instead of dropping edits.
 */
import {
  CancelFeesScreen,
  IntakeOptionsScreen,
  PaperScreen,
  PrintSettingsScreen,
  RepairRuntimeProvider,
  UncollectedDaysScreen,
  type DiscardGuard,
  type RepairRuntime,
  type StepBack,
} from '@bolusi/modules/repair/screens';
import { useCallback, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

import type { SurfaceNav } from '../../navigation/surface.js';

export type RepairSettingsPage =
  'intakeOptions' | 'cancelFees' | 'uncollectedDays' | 'printSettings' | 'printPaper';

export interface RepairSettingsRouteProps {
  readonly page: RepairSettingsPage;
  readonly runtime: RepairRuntime;
  readonly syncChip: ReactNode;
  readonly onClose: () => void;
  readonly onRegisterSurfaceNav?: ((nav: SurfaceNav | null) => void) | undefined;
}

export function RepairSettingsRoute({
  page,
  runtime,
  syncChip,
  onClose,
  onRegisterSurfaceNav,
}: RepairSettingsRouteProps): React.JSX.Element {
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
      {page === 'intakeOptions' ? (
        <IntakeOptionsScreen
          chrome={{ syncChip, avatar: null }}
          onClose={onClose}
          onRegisterDiscardGuard={registerDiscardGuard}
          onRegisterStepBack={registerStepBack}
        />
      ) : page === 'cancelFees' ? (
        <CancelFeesScreen
          chrome={{ syncChip, avatar: null }}
          onClose={onClose}
          onRegisterDiscardGuard={registerDiscardGuard}
        />
      ) : page === 'uncollectedDays' ? (
        <UncollectedDaysScreen
          chrome={{ syncChip, avatar: null }}
          onClose={onClose}
          onRegisterDiscardGuard={registerDiscardGuard}
        />
      ) : page === 'printPaper' ? (
        <PaperScreen chrome={{ syncChip, avatar: null }} onClose={onClose} />
      ) : (
        <PrintSettingsScreen
          chrome={{ syncChip, avatar: null }}
          onClose={onClose}
          onRegisterDiscardGuard={registerDiscardGuard}
        />
      )}
    </RepairRuntimeProvider>
  );
}
