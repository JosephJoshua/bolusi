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
  type NotesRuntime,
} from '@bolusi/modules/notes/screens';
import { useState } from 'react';
import type { ReactNode } from 'react';

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
}

export function NotesHome({
  runtime,
  now,
  syncChip,
  avatar,
  onOpenSyncStatus,
}: NotesHomeProps): React.JSX.Element {
  const [view, setView] = useState<NotesView>({ kind: 'list' });

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
