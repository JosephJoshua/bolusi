/**
 * RepairHome — the repair module surface at the shell's `home` route, built like `NotesHome`: it
 * owns the module's own navigation (board → ticket → handover, board → intake) as local state,
 * binds the runtime provider once, and publishes its back/leave to the shell so hardware back and
 * header taps go through the intake's discard confirm instead of dropping a half-done intake.
 */
import type { IntakeDraft } from '@bolusi/modules/repair';
import {
  Handover,
  IntakeWizard,
  RepairBoard,
  RepairRuntimeProvider,
  TicketDetail,
  type DiscardGuard,
  type RepairRuntime,
} from '@bolusi/modules/repair/screens';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { SurfaceNav } from '../../navigation/surface.js';

type RepairView =
  | { readonly kind: 'board' }
  | { readonly kind: 'intake' }
  | { readonly kind: 'ticket'; readonly ticketId: string }
  | { readonly kind: 'handover'; readonly ticketId: string };

export interface RepairHomeProps {
  readonly runtime: RepairRuntime;
  readonly now: number;
  readonly syncChip: ReactNode;
  readonly avatar: ReactNode;
  readonly onOpenSyncStatus: () => void;
  readonly onRegisterSurfaceNav?: ((nav: SurfaceNav | null) => void) | undefined;
  /** This user's intake in progress when they last locked, already owner-checked by the shell. */
  readonly restoredDraft?: IntakeDraft | null;
  readonly onDraftChange?: ((draft: IntakeDraft | null) => void) | undefined;
}

export function RepairHome({
  runtime,
  now,
  syncChip,
  avatar,
  onOpenSyncStatus,
  onRegisterSurfaceNav,
  restoredDraft,
  onDraftChange,
}: RepairHomeProps): React.JSX.Element {
  // Read once at mount: the lock unmounts this surface and the unlock remounts it.
  const [view, setView] = useState<RepairView>(() =>
    restoredDraft === null || restoredDraft === undefined ? { kind: 'board' } : { kind: 'intake' },
  );
  const chrome = { syncChip, avatar };

  const discardGuardRef = useRef<DiscardGuard | null>(null);
  const registerDiscardGuard = useCallback((guard: DiscardGuard | null): void => {
    discardGuardRef.current = guard;
  }, []);

  useEffect(() => {
    if (view.kind === 'board') {
      onRegisterSurfaceNav?.(null);
      return;
    }
    const backTo: () => void =
      view.kind === 'handover'
        ? () => setView({ kind: 'ticket', ticketId: view.ticketId })
        : () => setView({ kind: 'board' });
    const runLeave = (proceed: () => void): void => {
      const guard = discardGuardRef.current;
      if (guard !== null) guard(proceed);
      else proceed();
    };
    onRegisterSurfaceNav?.({
      handleBack: () => {
        runLeave(backTo);
        return true;
      },
      requestLeave: runLeave,
    });
    return () => onRegisterSurfaceNav?.(null);
  }, [view, onRegisterSurfaceNav]);

  return (
    <RepairRuntimeProvider runtime={runtime}>
      {view.kind === 'board' ? (
        <RepairBoard
          syncChip={syncChip}
          avatar={avatar}
          onOpenTicket={(ticketId) => setView({ kind: 'ticket', ticketId })}
          onNewIntake={() => setView({ kind: 'intake' })}
          onOpenSyncStatus={onOpenSyncStatus}
        />
      ) : null}

      {view.kind === 'intake' ? (
        <IntakeWizard
          chrome={chrome}
          now={now}
          restoredDraft={restoredDraft}
          onDraftChange={onDraftChange}
          onRegisterDiscardGuard={registerDiscardGuard}
          onOpened={(ticketId) => setView({ kind: 'ticket', ticketId })}
          onCancel={() => setView({ kind: 'board' })}
        />
      ) : null}

      {view.kind === 'ticket' ? (
        <TicketDetail
          ticketId={view.ticketId}
          chrome={chrome}
          onBack={() => setView({ kind: 'board' })}
          onHandover={(ticketId) => setView({ kind: 'handover', ticketId })}
          onOpenSyncStatus={onOpenSyncStatus}
        />
      ) : null}

      {view.kind === 'handover' ? (
        <Handover
          ticketId={view.ticketId}
          chrome={chrome}
          onDone={() => setView({ kind: 'ticket', ticketId: view.ticketId })}
          onCancel={() => setView({ kind: 'ticket', ticketId: view.ticketId })}
        />
      ) : null}
    </RepairRuntimeProvider>
  );
}
