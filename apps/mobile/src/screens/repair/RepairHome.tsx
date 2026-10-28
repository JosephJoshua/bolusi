/**
 * RepairHome — the repair module surface at the shell's `home` route, built like `NotesHome`: it
 * owns the module's own navigation (board → ticket → handover, board → intake) as local state,
 * binds the runtime provider once, and publishes its back/leave to the shell so hardware back and
 * header taps go through the intake's discard confirm instead of dropping a half-done intake.
 *
 * On a wide screen (a tablet in landscape) the board stays on the left and the open ticket, its
 * steps and the handover fill the right, so the counter can move between servisan without losing
 * the list. The intake is one task from start to finish and keeps the whole screen. Navigation is
 * the same state either way: turning the tablet only changes how it is drawn.
 */
import type { IntakeDraft } from '@bolusi/modules/repair';
import {
  Handover,
  IntakeWizard,
  NoTicketOpen,
  RepairBoard,
  RepairRuntimeProvider,
  TicketDetail,
  type DiscardGuard,
  type RepairRuntime,
  type StepBack,
} from '@bolusi/modules/repair/screens';
import { ViewportProvider, border, color, useViewport } from '@bolusi/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import type { SurfaceNav } from '../../navigation/surface.js';

type RepairView =
  | { readonly kind: 'board' }
  /** A warranty claim's intake starts from a draft made from the servisan it claims on. */
  | { readonly kind: 'intake'; readonly draft?: IntakeDraft }
  | { readonly kind: 'ticket'; readonly ticketId: string }
  | { readonly kind: 'handover'; readonly ticketId: string };

/**
 * The board's share of a wide screen: wide enough for a row's name, amount and chips (a phone's
 * width), and no wider, so the ticket gets the rest.
 */
const LIST_PANE = { share: 0.4, min: 340, max: 420 } as const;

export function listPaneWidth(width: number): number {
  return Math.min(LIST_PANE.max, Math.max(LIST_PANE.min, Math.round(width * LIST_PANE.share)));
}

export interface RepairHomeProps {
  readonly runtime: RepairRuntime;
  readonly now: () => number;
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
  const viewport = useViewport();
  const split = viewport.widthClass === 'expanded' && view.kind !== 'intake';
  // Inside a flow the header keeps only the sync chip: the title needs the width, and switching
  // user or language belongs on the board, not halfway through a step. Beside the board, whose
  // header already carries both, the pane keeps neither.
  const chrome = split ? { syncChip: null, avatar: null } : { syncChip, avatar: null };

  const discardGuardRef = useRef<DiscardGuard | null>(null);
  const registerDiscardGuard = useCallback((guard: DiscardGuard | null): void => {
    discardGuardRef.current = guard;
  }, []);
  // The open screen's own back (an open ticket step, an intake step), tried before leaving it.
  const stepBackRef = useRef<StepBack | null>(null);
  const registerStepBack = useCallback((back: StepBack | null): void => {
    stepBackRef.current = back;
  }, []);

  const runLeave = useCallback((proceed: () => void): void => {
    const guard = discardGuardRef.current;
    if (guard !== null) guard(proceed);
    else proceed();
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
    onRegisterSurfaceNav?.({
      handleBack: () => {
        if (stepBackRef.current?.() === true) return true;
        runLeave(backTo);
        return true;
      },
      requestLeave: runLeave,
    });
    return () => onRegisterSurfaceNav?.(null);
  }, [view, onRegisterSurfaceNav, runLeave]);

  const board = (
    <RepairBoard
      syncChip={syncChip}
      avatar={avatar}
      now={now}
      selectedTicketId={
        split && (view.kind === 'ticket' || view.kind === 'handover') ? view.ticketId : null
      }
      // Beside an open ticket, a half-done step or handover asks before another ticket replaces it.
      // Its own row again changes nothing, so there is nothing to ask about.
      onOpenTicket={(ticketId) => {
        if (view.kind === 'ticket' && view.ticketId === ticketId) return;
        runLeave(() => setView({ kind: 'ticket', ticketId }));
      }}
      onNewIntake={() => runLeave(() => setView({ kind: 'intake' }))}
      onOpenSyncStatus={onOpenSyncStatus}
    />
  );

  const detail =
    view.kind === 'ticket' ? (
      <TicketDetail
        // A new ticket is a new screen: its open step and scroll position stay with the last one.
        key={view.ticketId}
        ticketId={view.ticketId}
        chrome={chrome}
        now={now}
        hideBack={split}
        onBack={() => setView({ kind: 'board' })}
        onHandover={(ticketId) => setView({ kind: 'handover', ticketId })}
        onStartClaim={(draft) => setView({ kind: 'intake', draft })}
        onOpenTicket={(ticketId) => setView({ kind: 'ticket', ticketId })}
        onOpenSyncStatus={onOpenSyncStatus}
        onRegisterStepBack={registerStepBack}
        onRegisterDiscardGuard={registerDiscardGuard}
      />
    ) : view.kind === 'handover' ? (
      <Handover
        key={view.ticketId}
        ticketId={view.ticketId}
        chrome={chrome}
        onDone={() => setView({ kind: 'ticket', ticketId: view.ticketId })}
        onCancel={() => setView({ kind: 'ticket', ticketId: view.ticketId })}
        onRegisterDiscardGuard={registerDiscardGuard}
      />
    ) : null;

  const showBoard = split || view.kind === 'board';
  const showDetail = split || view.kind === 'ticket' || view.kind === 'handover';
  // The slots keep their places in both layouts, so turning the tablet redraws the open ticket
  // instead of remounting it: a step half filled in survives the rotation.
  return (
    <RepairRuntimeProvider runtime={runtime}>
      <View
        style={split ? styles.split : styles.single}
        testID={split ? 'repair.split' : undefined}
      >
        {showBoard ? (
          <View
            style={
              split ? [styles.listPane, { width: listPaneWidth(viewport.width) }] : styles.single
            }
          >
            {board}
          </View>
        ) : null}
        {showDetail ? (
          // The ticket sizes itself to its pane, not the window: beside the board on a small tablet
          // it has a phone's width, and lays its photos out like one.
          <ViewportProvider
            style={styles.single}
            testID={split ? 'repair.split.detail' : undefined}
          >
            {detail ?? <NoTicketOpen />}
          </ViewportProvider>
        ) : null}
        {view.kind === 'intake' ? (
          <IntakeWizard
            chrome={chrome}
            now={now}
            restoredDraft={view.draft ?? restoredDraft}
            onDraftChange={onDraftChange}
            onRegisterDiscardGuard={registerDiscardGuard}
            onRegisterStepBack={registerStepBack}
            onOpened={(ticketId) => setView({ kind: 'ticket', ticketId })}
            onCancel={() => setView({ kind: 'board' })}
          />
        ) : null}
      </View>
    </RepairRuntimeProvider>
  );
}

const styles = StyleSheet.create({
  single: { flex: 1 },
  split: { flex: 1, flexDirection: 'row' },
  listPane: { borderRightWidth: border.hairline, borderRightColor: color.border },
});
