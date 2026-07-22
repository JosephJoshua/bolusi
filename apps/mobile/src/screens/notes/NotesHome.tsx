/**
 * NotesHome — the notes module surface mounted at the shell's `home` route (task 24 navigation, no
 * shell rework). It owns the module's INTERNAL navigation (list → detail → editor) as local state,
 * the way the enrollment wizard owns its steps, so the shell gate (`resolveZone`) is untouched. It
 * binds the `NotesRuntimeProvider` once, and hands the shell chrome (header sync chip + avatar) down
 * to every screen as slots.
 *
 * This is the reference wiring every future module surface copies.
 */
import {
  NoteDetail,
  NoteEditor,
  NotesList,
  NotesRuntimeProvider,
  type DiscardGuard,
  type NotesRuntime,
} from '@bolusi/modules/notes/screens';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { SurfaceNav } from '../../navigation/surface.js';

type NotesView =
  | { readonly kind: 'list' }
  | { readonly kind: 'create' }
  | { readonly kind: 'edit'; readonly noteId: string }
  | { readonly kind: 'detail'; readonly noteId: string };

export interface NotesHomeProps {
  readonly runtime: NotesRuntime;
  /** ms epoch for relative timestamps (07-i18n §5.3). */
  readonly now: number;
  /** Shell chrome (§8.1): the always-present header sync chip + avatar nodes, built by the shell. */
  readonly syncChip: ReactNode;
  readonly avatar: ReactNode;
  /** A rejected chip / banner action → the shell's Sync Status screen (§8.4). */
  readonly onOpenSyncStatus: () => void;
  /**
   * Publish this surface's internal back/leave to the shell (design-system §8.1; task 145). Registered
   * whenever the surface is off its list root (an editor or detail is open) so hardware back and
   * header-chrome taps route through the module's own navigation — and the editor's discard gate —
   * instead of exiting the app or unmounting a dirty draft; `null` at the list root. Optional so a
   * direct mount (tests) is unaffected.
   */
  readonly onRegisterSurfaceNav?: ((nav: SurfaceNav | null) => void) | undefined;
}

export function NotesHome({
  runtime,
  now,
  syncChip,
  avatar,
  onOpenSyncStatus,
  onRegisterSurfaceNav,
}: NotesHomeProps): React.JSX.Element {
  const [view, setView] = useState<NotesView>({ kind: 'list' });

  /**
   * The live editor's discard gate (task 145), set by `NoteEditor` while a create/edit form is mounted
   * and cleared on unmount. Held in a ref because the shell reads it at the moment of a back/leave —
   * long after any render — and a value change must not itself re-render this tree.
   */
  const discardGuardRef = useRef<DiscardGuard | null>(null);
  const registerDiscardGuard = useCallback((guard: DiscardGuard | null): void => {
    discardGuardRef.current = guard;
  }, []);

  // Register the surface's back/leave with the shell whenever it is off the list root. `handleBack`
  // (hardware back) returns one step the way the header back does; `requestLeave` (a chrome tap)
  // carries the shell's destination. Both run the editor's discard gate when a form is mounted (else
  // there is no draft to guard and they leave at once), so §8.1's "back == header back" holds here too.
  useEffect(() => {
    if (view.kind === 'list') {
      onRegisterSurfaceNav?.(null);
      return;
    }
    // The step this surface returns to — identical to the editor's own `onCancel`/`onBack` target, so
    // hardware back and header back land in the same place: create/detail → list, edit → its detail.
    const backTo: () => void =
      view.kind === 'edit'
        ? () => setView({ kind: 'detail', noteId: view.noteId })
        : () => setView({ kind: 'list' });
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
    <NotesRuntimeProvider runtime={runtime}>
      {view.kind === 'list' ? (
        <NotesList
          now={now}
          syncChip={syncChip}
          avatar={avatar}
          onOpenNote={(noteId) => setView({ kind: 'detail', noteId })}
          onCreateNote={() => setView({ kind: 'create' })}
          onOpenSyncStatus={onOpenSyncStatus}
        />
      ) : null}

      {view.kind === 'create' ? (
        <NoteEditor
          mode="create"
          syncChip={syncChip}
          avatar={avatar}
          onDone={() => setView({ kind: 'list' })}
          onCancel={() => setView({ kind: 'list' })}
          onRegisterDiscardGuard={registerDiscardGuard}
        />
      ) : null}

      {view.kind === 'edit' ? (
        <NoteEditor
          mode="edit"
          noteId={view.noteId}
          syncChip={syncChip}
          avatar={avatar}
          onDone={() => setView({ kind: 'detail', noteId: view.noteId })}
          onCancel={() => setView({ kind: 'detail', noteId: view.noteId })}
          onRegisterDiscardGuard={registerDiscardGuard}
        />
      ) : null}

      {view.kind === 'detail' ? (
        <NoteDetail
          noteId={view.noteId}
          now={now}
          syncChip={syncChip}
          avatar={avatar}
          onBack={() => setView({ kind: 'list' })}
          onEdit={(noteId) => setView({ kind: 'edit', noteId })}
          onOpenSyncStatus={onOpenSyncStatus}
        />
      ) : null}
    </NotesRuntimeProvider>
  );
}
