// The module-screen runtime seam (04-module-contract §7) — how a screen reads and writes without
// ever touching `ProjectionDb` or the op log. This is the pattern EVERY future module screen copies
// (design-system §8.6): a screen calls `useQuery` / `useCommand`, and the platform composition root
// (apps/mobile) binds a `NotesRuntime` over the real `QueryRuntime` / `CommandRuntime` and the
// projection engine's invalidation bus.
//
// WHY A PORT, NOT A DIRECT CORE DEPENDENCY. The screens are Hermes-only UI; the query/command
// runtimes and the invalidation bus are constructed once, at boot, over the one DB connection
// (bootstrap/runtime.ts). Handing screens a small typed port (a) keeps them render-testable — a test
// drives the SAME screen over a real runtime built on an in-memory DB, or over a fake — and (b) keeps
// the identity (04 §5.2 `{tenantId, storeId, userId}`) at the composition root, never in a screen.
//
// LIVE-QUERY INVALIDATION (04 §7). `subscribe` is bound to the projection engine's per-table
// invalidation for the `notes` table. After ops apply (own-device append OR a pulled remote op),
// `useQuery` re-runs, and the screen re-renders in place — calm, no toast per change (design-system
// §4.7). Removing that wiring is the falsification: a pulled op then never reaches the mounted list.
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { DomainError, type QueryPage } from '@bolusi/core';
import type { MediaRef } from '@bolusi/schemas';
import type { OperationSyncStatus } from '@bolusi/ui';

import type { CreateNoteInput, EditNoteBodyInput, ArchiveNoteInput } from '../commands.js';
import type { ThumbnailRef } from '../media-ref.js';
import type { GetNoteInput, ListNotesInput, NoteRow } from '../queries.js';

/** The `Operation.syncStatus` of every op backing a note, keyed by note id (design-system §3.5). */
export type NoteSyncStatuses = Readonly<Record<string, readonly OperationSyncStatus[]>>;

/** One image attachment, resolved for display (06-media-pipeline §6 `RenderableMedia`, screen view). */
export type ThumbnailState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly uri: string }
  /** api/03 §8: a 404 is expected + transient — the op may precede the media. */
  | { readonly kind: 'unavailable' }
  /** 06 §6: two fetches disagreed with the signed hash — never shown, always a distinct state. */
  | { readonly kind: 'mismatch' };

/**
 * What the in-app capture flow (06 §2.1; task 82) hands back — the whole `mediaRef` the note op will
 * carry, not just the id. The capture pipeline already computes the SHA-256 over the final bytes
 * (06 §2.2 step 6), and the note's signed payload is the only tamper-evident place that hash can
 * live (05 §2), so dropping everything but the id here would make every note this device creates
 * unverifiable on every OTHER device (06 §6).
 */
export interface CapturedMedia {
  readonly mediaRef: MediaRef;
}

/**
 * Everything the notes screens need from the platform, and nothing more. apps/mobile binds each
 * method to the composed runtimes (identity-scoped) + the media client; a test binds fakes or a real
 * runtime over an in-memory DB.
 */
export interface NotesRuntime {
  /** 04 §6 reads — permission-checked in the runtime; a denial THROWS `PERMISSION_DENIED` (never `[]`). */
  listNotes(input: ListNotesInput): Promise<QueryPage<NoteRow>>;
  getNote(input: GetNoteInput): Promise<QueryPage<NoteRow>>;
  /** 04 §5 writes — append locally + project synchronously (optimistic; no network wait, §4.2). */
  createNote(input: CreateNoteInput): Promise<{ readonly noteId: string }>;
  editNoteBody(input: EditNoteBodyInput): Promise<{ readonly noteId: string }>;
  archiveNote(input: ArchiveNoteInput): Promise<{ readonly noteId: string }>;
  /**
   * The sync status of each note's ops (design-system §3.5) — read from the op-log bookkeeping, NOT
   * the projection (the `notes` row carries no op status). Drives the per-row / header sync chip and
   * NoteDetail's rejected-op danger banner. A note absent from the map is all-`synced` (silent).
   */
  noteSyncStatuses(noteIds: readonly string[]): Promise<NoteSyncStatuses>;
  /** 04 §7 live-query invalidation for the notes projection table. Returns an unsubscribe. */
  subscribe(listener: () => void): () => void;
  /**
   * Whether the current user holds a permission (02-permissions). Used ONLY to decide whether the
   * empty-state create-CTA renders (design-system §5/§8.6) — the query layer is still the enforcement
   * truth (a denied read returns the unauthorized state regardless of this).
   */
  hasPermission(permissionId: string): boolean;
  /** Open the in-app capture flow (task 82) and resolve the attached media, or null if cancelled. */
  capturePhoto(): Promise<CapturedMedia | null>;
  /**
   * Resolve a note's attachment to a displayable thumbnail (06 §6, media client).
   *
   * Takes the whole {@link ThumbnailRef}, not a bare id: a `signed` ref may be fetched and MUST be
   * verified against its `sha256` before display, while a `legacy` ref may only be resolved from a
   * local file. An id alone would leave the implementation with no hash to verify against and no way
   * to tell the two cases apart — which is exactly why a pulled note's photo used to be
   * unverifiable.
   */
  loadThumbnail(ref: ThumbnailRef): Promise<ThumbnailState>;
}

const NotesRuntimeContext = createContext<NotesRuntime | null>(null);

export interface NotesRuntimeProviderProps {
  readonly runtime: NotesRuntime;
  readonly children: ReactNode;
}

/** Mount at the notes surface (apps/mobile). Every notes screen below reads its runtime from here. */
export function NotesRuntimeProvider({
  runtime,
  children,
}: NotesRuntimeProviderProps): React.JSX.Element {
  return <NotesRuntimeContext.Provider value={runtime}>{children}</NotesRuntimeContext.Provider>;
}

/** The runtime for the current screen. Throws if a screen is mounted outside the provider (a wiring bug). */
export function useNotesRuntime(): NotesRuntime {
  const runtime = useContext(NotesRuntimeContext);
  if (runtime === null) {
    throw new Error(
      'useNotesRuntime: a notes screen was mounted without <NotesRuntimeProvider> (04 §7 wiring).',
    );
  }
  return runtime;
}

/** A live read (04 §7). Distinguishes the four §5 screen states a screen must render. */
export type QueryState<TData> =
  | { readonly status: 'loading' }
  /** A `PERMISSION_DENIED` read — the §5 Unauthorized state, NEVER an empty list (FR-1036). */
  | { readonly status: 'unauthorized' }
  | { readonly status: 'error'; readonly code: string }
  | { readonly status: 'ready'; readonly data: TData };

function errorCode(error: unknown): string {
  // 04 §5.3 closed code set; a denial is `PERMISSION_DENIED`. Anything else renders `UNEXPECTED`.
  return error instanceof DomainError ? error.code : 'UNEXPECTED';
}

/**
 * Run a query and keep it LIVE (04 §7).
 *
 * `run` selects and invokes the query off the runtime; `key` is its dependency identity (re-run when
 * it changes — e.g. the archived filter toggles). The query also re-runs on every notes-projection
 * invalidation, WITHOUT flashing loading (design-system §4.7 — live updates are calm), so a pulled
 * remote op appears in place. A `PERMISSION_DENIED` throw becomes the `unauthorized` state; every
 * other throw becomes `error` with the code, so the screen can render `t('core.errors.'+code)`.
 */
export function useQuery<TData>(
  run: (runtime: NotesRuntime) => Promise<TData>,
  key: string,
): QueryState<TData> {
  const runtime = useNotesRuntime();
  const [state, setState] = useState<QueryState<TData>>({ status: 'loading' });

  // The latest selector, so the effect's deps stay `[runtime, key]` and a new inline `run` each
  // render does not re-subscribe (which would thrash the invalidation subscription).
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    let active = true;
    const execute = (): void => {
      runRef.current(runtime).then(
        (data) => {
          if (active) setState({ status: 'ready', data });
        },
        (error: unknown) => {
          if (!active) return;
          const code = errorCode(error);
          setState(
            code === 'PERMISSION_DENIED' ? { status: 'unauthorized' } : { status: 'error', code },
          );
        },
      );
    };

    execute();
    const unsubscribe = runtime.subscribe(execute);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [runtime, key]);

  return state;
}

/**
 * Bind a command (04 §7). Returns the invoker; the screen decides whether to await it. A local
 * command appends + projects synchronously (04 §5.1), so an OPTIMISTIC screen fires it and navigates
 * away in the same tick without a spinner (design-system §4.2) — the invalidation then re-renders the
 * list it returned to.
 */
export function useCommand<TInput, TOutput>(
  select: (runtime: NotesRuntime) => (input: TInput) => Promise<TOutput>,
): (input: TInput) => Promise<TOutput> {
  const runtime = useNotesRuntime();
  return (input: TInput) => select(runtime)(input);
}

/**
 * Resolve a note's attachment to a displayable, hash-verified thumbnail (06 §6 via the media client).
 * `null` ref ⇒ the note has no attachment and nothing loads. A resolver throw degrades to
 * `unavailable` (api/03 §8: a missing photo is transient, never an error the whole screen dies on).
 *
 * A throw must NEVER degrade to `ready`, and a `mismatch` must never be softened into `unavailable`:
 * both would render bytes, or the absence of a complaint, where 06 §6 requires a distinct and
 * visible failure.
 */
export function useThumbnail(ref: ThumbnailRef | null): ThumbnailState {
  const runtime = useNotesRuntime();
  const [state, setState] = useState<ThumbnailState>(
    ref === null ? { kind: 'unavailable' } : { kind: 'loading' },
  );

  // The identity the effect depends on. An object literal rebuilt each render would re-run the
  // effect (and re-fetch) on every parent re-render; the fields ARE the identity.
  const refKey =
    ref === null
      ? null
      : ref.kind === 'signed'
        ? `s:${ref.mediaId}:${ref.sha256}`
        : `l:${ref.mediaId}`;
  const refRef = useRef(ref);
  refRef.current = ref;

  useEffect(() => {
    const current = refRef.current;
    if (current === null) {
      setState({ kind: 'unavailable' });
      return;
    }
    let active = true;
    setState({ kind: 'loading' });
    runtime.loadThumbnail(current).then(
      (resolved) => {
        if (active) setState(resolved);
      },
      () => {
        if (active) setState({ kind: 'unavailable' });
      },
    );
    return () => {
      active = false;
    };
  }, [runtime, refKey]);

  return state;
}
