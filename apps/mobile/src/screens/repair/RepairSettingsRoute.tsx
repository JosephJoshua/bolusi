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
  type RepairRuntime,
} from '@bolusi/modules/repair/screens';
import type { ReactNode } from 'react';

import type { SurfaceNav } from '../../navigation/surface.js';
import { useRouteSurfaceNav } from '../../navigation/useRouteSurfaceNav.js';

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
  const { registerDiscardGuard, registerStepBack } = useRouteSurfaceNav(
    onClose,
    onRegisterSurfaceNav,
  );

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
